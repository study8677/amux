import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { watch, type FSWatcher } from "chokidar";
import Database from "better-sqlite3";
import { AMUX_HOME, exists, isWithin } from "../core/paths.js";
import { loadConfig } from "../core/config.js";
import { log, setLogFile, setQuiet } from "../core/log.js";
import { writeJson, readTailLines, parseJsonLine } from "../core/jsonl.js";
import { getHarnesses } from "../harness/registry.js";
import { routeSessions, type ContextProject } from "../core/router.js";
import { discoverSessions, listContextProjects } from "../core/engine.js";
import { loadRegistry, syncProjects } from "../projects/sync.js";
import { ActivityTracker, ACTIVE_WINDOW_MS } from "../core/activity.js";
import { mirrorLatestSession } from "../mirror/index.js";
import { reconcileMirrorDuplicates } from "../mirror/dedup.js";
import { isMirrorTarget } from "../mirror/state.js";

export const PID_FILE = path.join(AMUX_HOME, "daemon.pid");
export const LOG_FILE = path.join(AMUX_HOME, "daemon.log");
export const HEALTH_FILE = path.join(AMUX_HOME, "daemon-health.json");
const EVENTS_FILE = path.join(AMUX_HOME, "mirror-events.jsonl");

export function daemonPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /\bdaemon\s+run\b/.test(command) ? pid : null;
  } catch { return null; }
}

export function startDaemonDetached(cliPath: string): number {
  fs.mkdirSync(AMUX_HOME, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  try {
    const child = spawn(process.execPath, [cliPath, "daemon", "run", "--quiet"], {
      detached: true, stdio: ["ignore", out, out], env: process.env,
    });
    child.unref();
    return child.pid ?? 0;
  } finally { fs.closeSync(out); }
}

export function stopDaemon(): boolean {
  const pid = daemonPid();
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  return true;
}

export async function runDaemon(opts: { quiet?: boolean } = {}): Promise<void> {
  fs.mkdirSync(AMUX_HOME, { recursive: true });
  if (daemonPid()) throw new Error("amux 后台已在运行");
  // Hold an OS-released SQLite lock for the lifetime of this supervisor.
  const lock = new Database(path.join(AMUX_HOME, "daemon-lock.sqlite"), { timeout: 0 });
  try { lock.exec("BEGIN EXCLUSIVE"); } catch {
    lock.close();
    throw new Error("另一个 amux 后台正在启动或运行");
  }
  try { fs.unlinkSync(PID_FILE); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.writeFileSync(PID_FILE, String(process.pid), { flag: "wx" });
  setLogFile(LOG_FILE);
  setQuiet(!!opts.quiet);
  const cfg = loadConfig();
  const health = {
    pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: "", lastScanAt: "",
    lastSuccessAt: "", lastErrorAt: "", lastError: "", projects: 0, activeJobs: 0,
    syncCount: 0, errorCount: 0,
  };
  const heartbeat = () => {
    health.heartbeatAt = new Date().toISOString();
    writeJson(HEALTH_FILE, health);
  };
  const recordError = (error: unknown) => {
    health.lastError = error instanceof Error ? error.message : String(error);
    health.lastErrorAt = new Date().toISOString();
    health.errorCount++;
    heartbeat();
  };
  let projects: ContextProject[] = [];
  const pending = new Map<string, { workspacePath: string; source: "codex" | "antigravity"; project: string; due: number; first: number; attempts: number }>();
  let stopping = false;
  let draining = false;
  let scanning = false;
  let projectSyncing = false;
  let tracker = new ActivityTracker();
  let watcher: FSWatcher | undefined;

  const schedule = (workspacePath: string, source: "codex" | "antigravity", project: string, attempts = 0) => {
    const key = `${source}:${workspacePath}`;
    const first = pending.get(key)?.first ?? Date.now();
    pending.set(key, { workspacePath, source, project, first, attempts,
      due: Math.min(Date.now() + cfg.context.debounceMs, first + 15000) });
  };
  const refreshProjects = async (apply = false) => {
    if (projectSyncing) return;
    projectSyncing = true;
    try {
      if (apply && loadRegistry().initialized) {
        const result = await syncProjects({ apply: true });
        const failures = result.applied.filter((action) => !action.ok);
        if (failures.length) throw new Error(failures.map((action) => action.error).join("\n"));
        if (result.plan.heldDeletes.length) log("projects", `已暂停 ${result.plan.heldDeletes.length} 个待确认删除`, "warn");
      }
      const nextProjects = await listContextProjects();
      if (JSON.stringify(nextProjects) !== JSON.stringify(projects)) tracker = new ActivityTracker();
      projects = nextProjects;
      health.projects = projects.length;
    } catch (error) { recordError(error); log("projects", health.lastError, "error"); }
    finally { projectSyncing = false; }
  };
  const scan = () => {
    if (stopping || scanning) return;
    scanning = true;
    try {
      const changed = tracker.changed(discoverSessions(Date.now() - ACTIVE_WINDOW_MS));
      const routed = routeSessions(changed, projects);
      for (const [key, sessions] of routed) {
        const project = projects.find((candidate) => candidate.key === key);
        if (!project) continue;
        for (const session of sessions) {
          if (session.harness !== "codex" && session.harness !== "antigravity") continue;
          if (isMirrorTarget(session.id) || /\[来自 (Codex|Antigravity)\]/.test(session.title ?? "")) continue;
          const workspace = session.paths.find((candidate) => project.roots.some((root) => isWithin(candidate, root)));
          if (workspace) schedule(workspace, session.harness as "codex" | "antigravity", project.name);
        }
      }
      health.lastScanAt = new Date().toISOString();
      heartbeat();
    } catch (error) { recordError(error); log("daemon", health.lastError, "error"); }
    finally { scanning = false; }
  };
  const drain = async () => {
    if (draining || stopping) return;
    draining = true;
    try {
      for (const [key, job] of pending) {
        if (stopping) break;
        if (job.due > Date.now()) continue;
        pending.delete(key);
        health.activeJobs = 1;
        heartbeat();
        try {
          const result = await mirrorLatestSession({ workspacePath: job.workspacePath, source: job.source });
          if (result.skipped && job.attempts > 0) {
            health.lastSuccessAt = new Date().toISOString();
            fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ...result, sourceAgent: job.source,
              timestamp: health.lastSuccessAt, status: "skipped" }) + "\n");
          }
          if (!result.skipped) {
            health.lastSuccessAt = new Date().toISOString();
            health.syncCount++;
            fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ...result, sourceAgent: job.source,
              timestamp: health.lastSuccessAt, status: "success" }) + "\n");
            log("mirror", `${job.project} → ${result.targetAgent}「${result.title}」（${result.turnCount} 条消息）`);
          }
        } catch (error) {
          recordError(error);
          fs.appendFileSync(EVENTS_FILE, JSON.stringify({ timestamp: health.lastErrorAt,
            sourceAgent: job.source, targetAgent: job.source === "codex" ? "antigravity" : "codex",
            workspacePath: job.workspacePath, title: job.project, status: "error", error: health.lastError }) + "\n");
          log("mirror", `${job.project} 镜像失败 ${health.lastError}`, "warn");
          if (!pending.has(key)) pending.set(key, { ...job, attempts: job.attempts + 1,
            due: Date.now() + Math.min(300000, 30000 * 2 ** Math.min(job.attempts, 4)) });
        } finally { health.activeJobs = 0; heartbeat(); }
      }
    } finally { draining = false; }
  };

  const timers: NodeJS.Timeout[] = [];
  let resolveStopped: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    timers.forEach(clearInterval);
    await watcher?.close();
    // Let a current mirror finish before releasing ownership.
    while (draining) await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("daemon", String(error), "warn");
    } finally { lock.close(); }
    log("daemon", "amux 后台已停止");
    resolveStopped!();
  };
  process.once("SIGINT", () => { void cleanup(); });
  process.once("SIGTERM", () => { void cleanup(); });
  heartbeat();
  log("daemon", `amux 后台启动 PID ${process.pid}`);
  await refreshProjects();
  if (stopping) return;
  try {
    const cleaned = await reconcileMirrorDuplicates();
    if (cleaned.antigravityDeleted > 0 || cleaned.codexArchived > 0) {
      log("mirror", `已清理历史重复会话（Antigravity 删除 ${cleaned.antigravityDeleted} 个，Codex 归档 ${cleaned.codexArchived} 个）`);
    }
  } catch (error) {
    log("mirror", `清理历史重复会话失败：${error instanceof Error ? error.message : String(error)}`, "warn");
  }
  if (stopping) return;
  scan();
  // Recover failed channels even when their source is older than the active-session window.
  const previousChannels = new Map<string, { sourceAgent: "codex" | "antigravity"; workspacePath: string; status: string }>();
  for (const line of readTailLines(EVENTS_FILE, 2000)) {
    const event = parseJsonLine<{ sourceAgent: "codex" | "antigravity"; workspacePath: string; status: string }>(line);
    if (!event?.workspacePath || !["codex", "antigravity"].includes(event.sourceAgent)) continue;
    previousChannels.set(`${event.sourceAgent}:${event.workspacePath}`, event);
  }
  for (const event of previousChannels.values()) {
    if (event.status !== "error") continue;
    const project = projects.find((candidate) => candidate.roots.some((root) => isWithin(event.workspacePath, root)));
    if (project) schedule(event.workspacePath, event.sourceAgent, project.name, 1);
  }
  const targets = [...new Set(getHarnesses().flatMap((harness) => harness.watchTargets()))].filter(exists);
  watcher = watch(targets, { ignoreInitial: true, depth: 1 });
  let watchTimer: NodeJS.Timeout | undefined;
  watcher.on("all", () => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => { watchTimer = undefined; scan(); }, 1000);
  });
  watcher.on("error", (error) => { recordError(error); log("daemon", health.lastError, "error"); });
  timers.push(setInterval(heartbeat, 5000));
  timers.push(setInterval(scan, 10000));
  timers.push(setInterval(() => { void drain(); }, 500));
  timers.push(setInterval(() => { void refreshProjects(true); }, 60000));
  log("daemon", `监听 ${projects.length} 个项目，10 秒扫描兜底，5 秒健康心跳`);
  await stopped;
  if (watchTimer) clearTimeout(watchTimer);
}
