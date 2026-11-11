import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRef } from "../src/core/types.js";

const mocks = vi.hoisted(() => ({ discover: vi.fn(), projects: vi.fn(), mirror: vi.fn(), watch: vi.fn(), command: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.command, spawn: vi.fn() }));
vi.mock("chokidar", () => ({ watch: mocks.watch }));
vi.mock("../src/core/engine.js", () => ({ discoverSessions: mocks.discover, listContextProjects: mocks.projects }));
vi.mock("../src/harness/registry.js", () => ({ getHarnesses: () => [{ watchTargets: () => [] }] }));
vi.mock("../src/projects/sync.js", () => ({ loadRegistry: () => ({ initialized: false }), syncProjects: vi.fn() }));
vi.mock("../src/core/config.js", () => ({ loadConfig: () => ({ context: { debounceMs: 3000 } }) }));
vi.mock("../src/core/log.js", () => ({ log: vi.fn(), setLogFile: vi.fn(), setQuiet: vi.fn() }));
vi.mock("../src/mirror/index.js", () => ({ mirrorLatestSession: mocks.mirror }));

let home: string;
let workspace: string;
let sessions: SessionRef[];
let running: Promise<void> | undefined;
let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
let initialSignals: { int: ((signal: "SIGINT") => void)[]; term: ((signal: "SIGTERM") => void)[] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  vi.resetModules();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "amux-daemon-test-"));
  workspace = path.join(home, "project");
  fs.mkdirSync(workspace);
  sessions = [];
  running = undefined;
  initialSignals = { int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") };
  vi.doMock("../src/core/paths.js", async () => ({ ...await vi.importActual<object>("../src/core/paths.js"), AMUX_HOME: home }));
  mocks.discover.mockReset().mockImplementation(() => sessions);
  mocks.projects.mockReset().mockResolvedValue([{ key: "p_test", name: "test", roots: [workspace] }]);
  mocks.mirror.mockReset().mockResolvedValue({ targetAgent: "antigravity", targetSessionId: "target", title: "test", turnCount: 2, workspacePath: workspace });
  mocks.command.mockReset().mockReturnValue("node cli.js daemon run --quiet");
  watcher = Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });
  mocks.watch.mockReset().mockReturnValue(watcher);
});

afterEach(async () => {
  if (running) {
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  }
  for (const listener of process.listeners("SIGINT")) if (!initialSignals.int.includes(listener)) process.removeListener("SIGINT", listener);
  for (const listener of process.listeners("SIGTERM")) if (!initialSignals.term.includes(listener)) process.removeListener("SIGTERM", listener);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock("../src/core/paths.js");
  fs.rmSync(home, { recursive: true, force: true });
});

function addSession(id: string, agent: "codex" | "antigravity" = "codex") {
  const file = path.join(home, `${id}.jsonl`);
  fs.writeFileSync(file, "{}\n");
  const session = { harness: agent, id, paths: [workspace], updatedAt: Date.now(), file };
  sessions.push(session);
  return session;
}
async function start() {
  const daemon = await import("../src/daemon/daemon.js");
  running = daemon.runDaemon({ quiet: true });
  await vi.advanceTimersByTimeAsync(0);
  return daemon;
}

describe("daemon supervisor", () => {
  it("backfills active sessions at startup and persists real sync events and heartbeat", async () => {
    addSession("already-active");
    await start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(mocks.mirror).toHaveBeenCalledWith({ workspacePath: workspace, source: "codex" });
    const health = JSON.parse(fs.readFileSync(path.join(home, "daemon-health.json"), "utf8"));
    expect(health.syncCount).toBe(1);
    expect(health.lastScanAt).toBeTruthy();
    expect(health.lastSuccessAt).toBeTruthy();
    const event = JSON.parse(fs.readFileSync(path.join(home, "mirror-events.jsonl"), "utf8").trim());
    expect(event).toMatchObject({ status: "success", sourceAgent: "codex", targetAgent: "antigravity" });
  });

  it("discovers newly created sessions through polling when no watcher event arrives", async () => {
    await start();
    addSession("created-after-start");
    await vi.advanceTimersByTimeAsync(13500);
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
  });

  it("recovers the latest failed channel on startup without an active session", async () => {
    const oldTimestamp = "2026-11-08T10:00:00Z";
    const previousEvents = [
      { timestamp: oldTimestamp, sourceAgent: "codex", workspacePath: workspace, status: "error", error: "offline" },
      { timestamp: oldTimestamp, sourceAgent: "antigravity", workspacePath: workspace, status: "error", error: "offline" },
      { timestamp: "2026-11-09T10:00:00Z", sourceAgent: "antigravity", workspacePath: workspace, status: "success" },
      { timestamp: oldTimestamp, sourceAgent: "codex", workspacePath: path.join(home, "unregistered"), status: "error", error: "offline" },
    ];
    fs.writeFileSync(path.join(home, "mirror-events.jsonl"), previousEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(mocks.discover()).toEqual([]);
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
    expect(mocks.mirror).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: workspace, source: "codex" }));
    const health = JSON.parse(fs.readFileSync(path.join(home, "daemon-health.json"), "utf8"));
    expect(health.syncCount).toBe(1);
  });

  it("schedules both source agents independently in the same workspace", async () => {
    addSession("codex", "codex");
    addSession("agy", "antigravity");
    await start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(mocks.mirror.mock.calls.map(([options]) => options.source).sort()).toEqual(["antigravity", "codex"]);
  });

  it("bounds debounce latency under continuous session writes", async () => {
    const session = addSession("streaming");
    await start();
    for (let i = 0; i < 16; i++) {
      fs.appendFileSync(session.file, "{}\n");
      watcher.emit("all", "change", session.file);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(mocks.mirror).toHaveBeenCalled();
  });

  it("records a failed mirror and keeps scanning", async () => {
    mocks.mirror.mockRejectedValueOnce(new Error("temporary RPC timeout"));
    const session = addSession("failure");
    await start();
    await vi.advanceTimersByTimeAsync(3500);
    const health = JSON.parse(fs.readFileSync(path.join(home, "daemon-health.json"), "utf8"));
    expect(health.errorCount).toBe(1);
    expect(health.lastError).toBe("temporary RPC timeout");
    expect(JSON.parse(fs.readFileSync(path.join(home, "mirror-events.jsonl"), "utf8").trim()).status).toBe("error");
    fs.appendFileSync(session.file, "{}\n");
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.mirror).toHaveBeenCalledTimes(2);
  });

  it("retries a transient failure after backoff even when the source stays unchanged", async () => {
    mocks.mirror.mockRejectedValueOnce(new Error("temporary RPC timeout"));
    addSession("retry");
    await start();
    await vi.advanceTimersByTimeAsync(32500);
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.mirror).toHaveBeenCalledTimes(2);
    const health = JSON.parse(fs.readFileSync(path.join(home, "daemon-health.json"), "utf8"));
    expect(health.syncCount).toBe(1);
  });

  it("mirrors nested working directories using their actual workspace path", async () => {
    const session = addSession("nested");
    const nested = path.join(workspace, "packages/app");
    fs.mkdirSync(nested, { recursive: true });
    session.paths = [nested];
    await start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(mocks.mirror).toHaveBeenCalledWith({ workspacePath: nested, source: "codex" });
  });

  it("ignores mirrored destination titles to prevent loopback", async () => {
    const session = addSession("destination");
    Object.assign(session, { title: "Existing session [来自 Antigravity]" });
    await start();
    await vi.advanceTimersByTimeAsync(14000);
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("backfills sessions after project discovery recovers", async () => {
    mocks.projects.mockRejectedValueOnce(new Error("temporary project listing error"));
    addSession("project-list-recovered");
    await start();
    await vi.advanceTimersByTimeAsync(73500);
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
  });

  it("rejects a second supervisor with the shared SQLite lock held", async () => {
    const lock = new Database(path.join(home, "daemon-lock.sqlite"));
    lock.exec("BEGIN EXCLUSIVE");
    try {
      const { runDaemon } = await import("../src/daemon/daemon.js");
      await expect(runDaemon()).rejects.toThrow("另一个 amux 后台正在启动或运行");
    } finally { lock.close(); }
  });

  it("rejects PID reuse by an unrelated process", async () => {
    fs.writeFileSync(path.join(home, "daemon.pid"), String(process.pid));
    mocks.command.mockReturnValue("node unrelated-app.js");
    const { daemonPid } = await import("../src/daemon/daemon.js");
    expect(daemonPid()).toBeNull();
  });

  it("stops during pending startup discovery without attaching watchers or timers", async () => {
    let finishDiscovery!: (projects: { key: string; name: string; roots: string[] }[]) => void;
    mocks.projects.mockImplementationOnce(() => new Promise((resolve) => { finishDiscovery = resolve; }));
    await start();
    expect(mocks.projects).toHaveBeenCalledTimes(1);
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    finishDiscovery([{ key: "p_test", name: "test", roots: [workspace] }]);
    await running;
    running = undefined;
    expect(mocks.watch).not.toHaveBeenCalled();
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fs.existsSync(path.join(home, "daemon.pid"))).toBe(false);
    const lock = new Database(path.join(home, "daemon-lock.sqlite"), { timeout: 0 });
    expect(() => lock.exec("BEGIN EXCLUSIVE")).not.toThrow();
    lock.close();
  });

  it("releases the SQLite lock when the PID file disappears before shutdown", async () => {
    await start();
    fs.unlinkSync(path.join(home, "daemon.pid"));
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    await running;
    running = undefined;
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const lock = new Database(path.join(home, "daemon-lock.sqlite"), { timeout: 0 });
    expect(() => lock.exec("BEGIN EXCLUSIVE")).not.toThrow();
    lock.close();
  });

  it("releases the PID file and SQLite lock on graceful shutdown", async () => {
    await start();
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    await running;
    running = undefined;
    expect(fs.existsSync(path.join(home, "daemon.pid"))).toBe(false);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    const lock = new Database(path.join(home, "daemon-lock.sqlite"), { timeout: 0 });
    expect(() => lock.exec("BEGIN EXCLUSIVE")).not.toThrow();
    lock.close();
  });
});
