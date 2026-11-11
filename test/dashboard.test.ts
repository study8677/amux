import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "node /project/amux/dist/cli.js daemon run --quiet") }));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "amux-dashboard-"));
const previousHome = process.env.AMUX_HOME;
let status: typeof import("../src/dashboard/status.js").getDashboardStatus;
let startDashboard: typeof import("../src/dashboard/index.js").startDashboard;
const now = Date.now();
const write = (file: string, value: unknown) => fs.writeFileSync(path.join(home, file), JSON.stringify(value));

beforeAll(async () => {
  process.env.AMUX_HOME = home;
  vi.resetModules();
  status = (await import("../src/dashboard/status.js")).getDashboardStatus;
  startDashboard = (await import("../src/dashboard/index.js")).startDashboard;
});
beforeEach(() => {
  vi.mocked(execFileSync).mockReturnValue("node /project/amux/dist/cli.js daemon run --quiet");
  for (const file of fs.readdirSync(home)) fs.rmSync(path.join(home, file), { recursive: true });
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.AMUX_HOME;
  else process.env.AMUX_HOME = previousHome;
  fs.rmSync(home, { recursive: true });
});

function healthyDaemon() {
  fs.writeFileSync(path.join(home, "daemon.pid"), String(process.pid));
  write("daemon-health.json", { pid: process.pid, heartbeatAt: new Date(now).toISOString() });
}

describe("dashboard health evidence", () => {
  it("reports a stopped daemon when only an old heartbeat remains", () => {
    write("daemon-health.json", { pid: process.pid, heartbeatAt: new Date(now).toISOString() });
    expect(status(now).state).toBe("stopped");
  });
  it("requires a fresh heartbeat belonging to the live daemon", () => {
    healthyDaemon();
    expect(status(now).state).toBe("running");
    expect(status(now + 46000).state).toBe("degraded");
    write("daemon-health.json", { pid: process.pid + 1, heartbeatAt: new Date(now).toISOString() });
    expect(status(now).state).toBe("degraded");
  });
  it("shows recent sync failures as degraded even with a live heartbeat", () => {
    healthyDaemon();
    write("daemon-health.json", { pid: process.pid, heartbeatAt: new Date(now).toISOString(), lastErrorAt: new Date(now).toISOString(), lastError: "mirror failed" });
    expect(status(now).state).toBe("degraded");
  });
  it("does not accept an unrelated process reusing the PID", () => {
    healthyDaemon();
    vi.mocked(execFileSync).mockReturnValue("node some-other-server.js");
    expect(status(now).state).toBe("stopped");
  });
  it("keeps a failed project degraded when another project succeeds", () => {
    healthyDaemon();
    const failed = { timestamp: new Date(now - 1000).toISOString(), status: "error", sourceAgent: "codex", workspacePath: "/project-a", error: "native read failed" };
    const succeeded = { timestamp: new Date(now).toISOString(), status: "success", sourceAgent: "codex", workspacePath: "/project-b", nativeReadbackVerified: true };
    write("daemon-health.json", { pid: process.pid, heartbeatAt: new Date(now).toISOString(), lastErrorAt: failed.timestamp, lastSuccessAt: succeeded.timestamp });
    fs.writeFileSync(path.join(home, "mirror-events.jsonl"), [failed, succeeded].map((event) => JSON.stringify(event)).join("\n"));
    expect(status(now).state).toBe("degraded");
    expect(status(now).unresolvedErrors).toHaveLength(1);
    expect(status(now).events[0].nativeReadbackVerified).toBe(true);
    fs.appendFileSync(path.join(home, "mirror-events.jsonl"), "\n" + JSON.stringify({ ...succeeded, workspacePath: "/project-a" }));
    expect(status(now).state).toBe("running");
  });
  it("keeps each direction's failure separate within one project", () => {
    healthyDaemon();
    const events = [
      { timestamp: new Date(now - 1000).toISOString(), status: "error", sourceAgent: "codex", workspacePath: "/project-a" },
      { timestamp: new Date(now).toISOString(), status: "success", sourceAgent: "antigravity", workspacePath: "/project-a" },
    ];
    fs.writeFileSync(path.join(home, "mirror-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
    expect(status(now).state).toBe("degraded");
  });
  it("keeps historical records distinct from current successful writes", () => {
    write("mirror-state.json", { sourceSyncMap: { old: { targetAgent: "codex", targetSessionId: "target", turnCount: 2, updatedAt: now - 10000 } } });
    fs.writeFileSync(path.join(home, "mirror-events.jsonl"), JSON.stringify({ timestamp: new Date(now).toISOString(), status: "error", error: "timeout" }) + '\n{"partial":');
    const result = status(now);
    expect(result.events.map((event) => event.status)).toEqual(["error", "historical"]);
    expect(result.lastMirrorAt).toBe(new Date(now - 10000).toISOString());
  });
  it("serves the UI and truthful health through read-only HTTP routes", async () => {
    const server = await startDashboard({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP address required");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("运行概览");
      const health = await fetch(url + "/healthz");
      expect(health.status).toBe(503);
      expect((await health.json() as { state: string }).state).toBe("stopped");
      expect((await fetch(url + "/api/status", { method: "POST" })).status).toBe(405);
      const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        http.get(url + "/api/status", { headers: { Host: "external.example" } }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        }).on("error", reject);
      });
      expect(foreignHostStatus).toBe(403);
      expect((await fetch(url + "/api/status", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
