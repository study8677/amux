import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AMUX_HOME } from "../core/paths.js";

interface DaemonHealth {
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  lastScanAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  projects?: number;
  activeJobs?: number;
  syncCount?: number;
  errorCount?: number;
}

interface MirrorEvent {
  timestamp: string;
  sourceAgent?: string;
  targetAgent?: string;
  sourceSessionId?: string;
  targetSessionId?: string;
  title?: string;
  workspacePath?: string;
  turnCount?: number;
  status: string;
  error?: string;
  nativeReadbackVerified?: boolean;
}

interface RegistryProject {
  key: string;
  name: string;
  roots: string[];
  ids?: Record<string, string>;
  excluded?: boolean;
  lastSynced?: { at?: string };
}

function readJson<T>(file: string, fallback: T, warnings: string[]): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(AMUX_HOME, file), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${file} 读取失败`);
    return fallback;
  }
}

/** Bound reads so long-running installations keep a lightweight dashboard. */
function readTail(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(AMUX_HOME, file), "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function getDashboardStatus(now = Date.now()) {
  const warnings: string[] = [];
  const health = readJson<DaemonHealth>("daemon-health.json", {}, warnings);
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(path.join(AMUX_HOME, "daemon.pid"), "utf8").trim());
  } catch { /* A stopped daemon may have no PID file. */ }
  let alive = false;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 });
      alive = /\bdaemon\s+run\b/.test(command);
    } catch { /* Process has exited. */ }
  }
  const heartbeatAgeMs = health.heartbeatAt ? now - Date.parse(health.heartbeatAt) : null;
  const healthy = alive && health.pid === pid && heartbeatAgeMs !== null && Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs >= -5000 && heartbeatAgeMs <= 45000;
  const unresolvedError = Boolean(health.lastErrorAt && (!health.lastSuccessAt || Date.parse(health.lastErrorAt) > Date.parse(health.lastSuccessAt)));
  const events: MirrorEvent[] = [];
  for (const line of readTail("mirror-events.jsonl").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as MirrorEvent;
      if (event.timestamp && event.status) events.push(event);
    } catch { /* An in-progress final append is retried on the next refresh. */ }
  }
  const syncState = readJson<{ sourceSyncMap?: Record<string, { targetAgent: string; targetSessionId: string; turnCount: number; updatedAt: number }> }>("mirror-state.json", {}, warnings);
  const knownTargets = new Set(events.map((e) => e.targetSessionId));
  for (const [sourceId, sync] of Object.entries(syncState.sourceSyncMap ?? {})) {
    if (knownTargets.has(sync.targetSessionId)) continue;
    events.push({
      timestamp: new Date(sync.updatedAt).toISOString(),
      sourceAgent: sync.targetAgent === "codex" ? "antigravity" : "codex",
      targetAgent: sync.targetAgent,
      sourceSessionId: sourceId,
      targetSessionId: sync.targetSessionId,
      turnCount: sync.turnCount,
      status: "historical",
    });
  }
  events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const latestByProject = new Map<string, MirrorEvent>();
  for (const event of events) {
    if (event.status !== "success" && event.status !== "error" && event.status !== "skipped") continue;
    const key = JSON.stringify([event.sourceAgent, event.workspacePath ?? event.sourceSessionId ?? event.title]);
    if (!latestByProject.has(key)) latestByProject.set(key, event);
  }
  const unresolvedErrors = [...latestByProject.values()].filter((event) => event.status === "error");
  const state: "stopped" | "degraded" | "running" = !alive ? "stopped" : !healthy || unresolvedError || unresolvedErrors.length > 0 ? "degraded" : "running";
  const verification = readJson<{ verifiedAt?: string; agent?: string; sessionId?: string; modelContinuation?: boolean; persistedReply?: boolean; independentReload?: boolean }>("verification.json", {}, warnings);
  const registry = readJson<{ initialized?: boolean; updatedAt?: string; projects?: RegistryProject[] }>("registry.json", {}, warnings);
  const projects = (registry.projects ?? []).map((project) => ({
    key: project.key,
    name: project.name,
    roots: project.roots,
    codex: Boolean(project.ids?.codex),
    antigravity: Boolean(project.ids?.antigravity),
    excluded: Boolean(project.excluded),
    lastSyncedAt: project.lastSynced?.at ?? null,
  }));
  return {
    checkedAt: new Date(now).toISOString(),
    verification,
    state,
    alive,
    pid: alive ? pid : null,
    health,
    heartbeatAgeMs,
    warnings,
    unresolvedErrors,
    lastMirrorAt: events.find((event) => event.status === "success" || event.status === "historical")?.timestamp ?? null,
    registryInitialized: Boolean(registry.initialized),
    registryUpdatedAt: registry.updatedAt ?? null,
    projects,
    events: events.slice(0, 60),
    logs: readTail("daemon.log").split("\n").filter(Boolean).slice(-30),
  };
}
