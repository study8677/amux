import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { command, resolveModule } = vi.hoisted(() => ({ command: vi.fn(), resolveModule: vi.fn() }));
vi.mock("node:module", async () => ({ ...await vi.importActual<object>("node:module"), createRequire: () => ({ resolve: resolveModule }) }));
vi.mock("node:child_process", () => ({ execFileSync: command }));
let home: string;
let cliPath: string;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'amux-service & "quoted"-'));
  cliPath = path.join(home, "project/dist/cli.js");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, 'import "./chunk.js";\n');
  fs.writeFileSync(path.join(path.dirname(cliPath), "chunk.js"), 'export const marker = "runtime fixture";\n');
  for (const name of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const directory = path.join(home, "fixture-modules", name);
    fs.mkdirSync(path.join(directory, "build/Release"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(directory, "index.js"), 'module.exports = {};\n');
    fs.writeFileSync(path.join(directory, "build/Release/better_sqlite3.node"), "native-fixture");
  }
  resolveModule.mockReset().mockImplementation((specifier: string) => {
    const packageName = specifier.split("/")[0];
    return path.join(home, "fixture-modules", packageName, specifier.endsWith("/package.json") ? "package.json" : "index.js");
  });
  Object.defineProperty(process, "platform", { value: "darwin" });
  command.mockReset();
  vi.resetModules();
  vi.doMock("../src/core/paths.js", () => ({ AMUX_HOME: path.join(home, ".amux"), HOME_DIR: home }));
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.doUnmock("../src/core/paths.js");
  fs.rmSync(home, { recursive: true, force: true });
});

describe("launchd service lifecycle", () => {
  it("writes separate self-restarting login services with escaped argv", async () => {
    const { installServices, serviceInstalled } = await import("../src/daemon/service.js");
    expect(serviceInstalled()).toBe(false);
    await installServices(cliPath);
    expect(serviceInstalled()).toBe(true);
    const directory = path.join(home, "Library/LaunchAgents");
    const daemon = fs.readFileSync(path.join(directory, "com.amux.daemon.plist"), "utf8");
    const dashboard = fs.readFileSync(path.join(directory, "com.amux.dashboard.plist"), "utf8");
    for (const text of [daemon, dashboard]) {
      expect(text).toContain("<key>RunAtLoad</key><true/>");
      expect(text).toContain("<key>KeepAlive</key><true/>");
      expect(text).toContain("<key>ThrottleInterval</key><integer>10</integer>");
      expect(text).toContain("amux-service &amp; &quot;quoted&quot;");
      expect(text).toContain(`<string>${process.execPath}</string>`);
    }
    expect(daemon).toContain("<string>daemon</string><string>run</string><string>--quiet</string>");
    expect(dashboard).toContain("<string>dashboard</string>");
    expect(command.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(2);
    expect(command.mock.calls.filter(([, args]) => args[0] === "enable")).toHaveLength(2);
  });

  it("copies complete build chunks and native dependency into a standalone ESM runtime", async () => {
    const { prepareServiceRuntime } = await import("../src/daemon/service.js");
    const installedCli = prepareServiceRuntime(cliPath);
    const runtime = path.dirname(path.dirname(installedCli));
    expect(installedCli).toContain(path.join(home, ".amux/runtime"));
    expect(fs.readFileSync(installedCli, "utf8")).toBe(fs.readFileSync(cliPath, "utf8"));
    expect(fs.readFileSync(path.join(runtime, "dist/chunk.js"), "utf8")).toContain("runtime fixture");
    expect(JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8"))).toMatchObject({ type: "module", private: true });
    expect(fs.readFileSync(path.join(runtime, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "utf8")).toBe("native-fixture");
    expect(fs.existsSync(path.join(runtime, "ready"))).toBe(true);
    fs.rmSync(path.dirname(path.dirname(cliPath)), { recursive: true });
    expect(fs.readFileSync(installedCli, "utf8")).toContain('import "./chunk.js"');
    expect(fs.existsSync(path.join(runtime, "dist/chunk.js"))).toBe(true);
  });

  it("reuses matching builds and versions the runtime when a chunk changes", async () => {
    const { prepareServiceRuntime } = await import("../src/daemon/service.js");
    const first = prepareServiceRuntime(cliPath);
    expect(prepareServiceRuntime(cliPath)).toBe(first);
    fs.appendFileSync(path.join(path.dirname(cliPath), "chunk.js"), "export const changed = true;\n");
    const second = prepareServiceRuntime(cliPath);
    expect(second).not.toBe(first);
    expect(fs.readFileSync(path.join(path.dirname(second), "chunk.js"), "utf8")).toContain("changed");
    expect(fs.existsSync(first)).toBe(true);
  });

  it("disables and unloads only the daemon so the status page stays available", async () => {
    const { installServices, stopService } = await import("../src/daemon/service.js");
    await installServices(cliPath);
    command.mockClear();
    stopService();
    expect(command.mock.calls.map(([, args]) => args[0])).toEqual(["disable", "bootout"]);
    for (const [, args] of command.mock.calls) expect(args[1]).toMatch(/com\.amux\.daemon$/);
  });

  it("tolerates an already-unloaded service while reinstalling", async () => {
    command.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "bootout") throw new Error("not loaded");
    });
    const { installServices } = await import("../src/daemon/service.js");
    await expect(installServices(cliPath)).resolves.toBeUndefined();
    expect(command.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(2);
  });

  it("retries bootstrap while the previous launchd label is still unloading", async () => {
    vi.useFakeTimers();
    let bootstrapCount = 0;
    command.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "bootstrap" && bootstrapCount++ === 0) throw new Error("bootstrap error 5");
      return "service still registered";
    });
    const { installServices } = await import("../src/daemon/service.js");
    const installing = installServices(cliPath);
    expect(command.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    await installing;
    expect(command.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(3);
    expect(command.mock.calls.filter(([, args]) => args[0] === "print")).toHaveLength(0);
  });

  it("recovers transient bootstrap failures even when launchctl cannot print the old label", async () => {
    vi.useFakeTimers();
    let bootstrapCount = 0;
    command.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "bootstrap" && bootstrapCount++ < 2) throw new Error("bootstrap error 5");
      if (args[0] === "print") throw new Error("service not found");
    });
    const { installServices } = await import("../src/daemon/service.js");
    const installing = installServices(cliPath);
    await vi.advanceTimersByTimeAsync(500);
    await installing;
    expect(command.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(4);
    expect(command.mock.calls.filter(([, args]) => args[0] === "print")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds retries when a launchd label never finishes unloading", async () => {
    vi.useFakeTimers();
    command.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "bootstrap") throw new Error("bootstrap error 5");
      return "service still registered";
    });
    const { installServices } = await import("../src/daemon/service.js");
    const rejected = expect(installServices(cliPath)).rejects.toThrow("bootstrap error 5");
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    const retries = command.mock.calls.filter(([, args]) => args[0] === "bootstrap").length;
    expect(retries).toBe(20);
    expect(vi.getTimerCount()).toBe(0);
  });

});
