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
import * as mirrorIndex from "../mirror/index.js";
import { mirrorLatestSession } from "../mirror/index.js";
import { reconcileMirrorDuplicates, shouldSkipMirroredSession } from "../mirror/dedup.js";

export const PID_FILE = path.join(AMUX_HOME, "daemon.pid");
export const LOG_FILE = path.join(AMUX_HOME, "daemon.log");
export const HEALTH_FILE = path.join(AMUX_HOME, "daemon-health.json");
const EVENTS_FILE = path.join(AMUX_HOME, "mirror-events.jsonl");

function isBenignEmptyError(error: unknown): boolean {
  if ("isBenignEmptyMirrorError" in mirrorIndex && typeof mirrorIndex.isBenignEmptyMirrorError === "function") {
    return mirrorIndex.isBenignEmptyMirrorError(error);
  }
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /没有可提取的有效对话(?:内容|轮次)|既未找到 Codex 会话，也未找到 Antigravity 会话|未找到 (?:Codex|Antigravity) 在工作区 .* 的活跃会话/.test(msg);
}

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

interface PendingMirrorJob {
  workspacePath: string;
  source: "codex" | "antigravity";
  project: string;
  due: number;
  first: number;
  attempts: number;
  sessionId?: string;
  pinSessionId?: boolean;
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
  const pending = new Map<string, PendingMirrorJob>();
  const watchedTargets = new Set<string>();
  let stopping = false;
  let draining = false;
  let scanning = false;
  let projectSyncing = false;
  let tracker = new ActivityTracker();
  let watcher: FSWatcher | undefined;

  const currentWatchTargets = () =>
    [...new Set(getHarnesses().flatMap((harness) => harness.watchTargets()))].filter(exists);

  const syncWatchTargets = () => {
    if (!watcher || typeof (watcher as { add?: unknown }).add !== "function") return;
    const fresh: string[] = [];
    for (const target of currentWatchTargets()) {
      if (!watchedTargets.has(target)) {
        watchedTargets.add(target);
        fresh.push(target);
      }
    }
    if (fresh.length > 0) watcher.add(fresh);
  };

  const schedule = (
    workspacePath: string,
    source: "codex" | "antigravity",
    project: string,
    attempts = 0,
    sessionId?: string
  ) => {
    const baseKey = `${source}:${workspacePath}`;
    const existingBase = pending.get(baseKey);

    if (!sessionId || !existingBase || existingBase.sessionId === sessionId) {
      const first = existingBase?.first ?? Date.now();
      pending.set(baseKey, {
        workspacePath,
        source,
        project,
        first,
        attempts,
        sessionId: sessionId ?? existingBase?.sessionId,
        pinSessionId: existingBase?.pinSessionId ?? false,
        due: Math.min(Date.now() + cfg.context.debounceMs, first + 15000),
      });
      return;
    }

    // Multiple distinct sessions in the same workspace changed concurrently: pin both so neither overwrites the other
    existingBase.pinSessionId = true;
    const sessionKey = `${baseKey}#${sessionId}`;
    const first = pending.get(sessionKey)?.first ?? Date.now();
    pending.set(sessionKey, {
      workspacePath,
      source,
      project,
      first,
      attempts,
      sessionId,
      pinSessionId: true,
      due: Math.min(Date.now() + cfg.context.debounceMs, first + 15000),
    });
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
      syncWatchTargets();
      const changed = tracker.changed(discoverSessions(Date.now() - ACTIVE_WINDOW_MS));
      const routed = routeSessions(changed, projects);
      for (const [key, sessions] of routed) {
        const project = projects.find((candidate) => candidate.key === key);
        if (!project) continue;
        for (const session of sessions) {
          const source: "codex" | "antigravity" | null = session.harness === "codex" ? "codex" : session.harness === "antigravity" ? "antigravity" : null;
          if (!source) continue;
          if (shouldSkipMirroredSession(source, session.id, session.title, session.file)) continue;
          const workspace = session.paths.find((candidate) => project.roots.some((root) => isWithin(candidate, root)));
          if (workspace) schedule(workspace, source, project.name, 0, session.id);
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
          const mirrorOpts =
            job.pinSessionId && job.sessionId
              ? { workspacePath: job.workspacePath, source: job.source, sourceSessionId: job.sessionId }
              : { workspacePath: job.workspacePath, source: job.source };
          const result = await mirrorLatestSession(mirrorOpts);
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
          if (isBenignEmptyError(error)) {
            // Newly created blank chat tabs have no turns yet; wait for real file activity instead of marking degraded
            continue;
          }
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
  const previousChannels = new Map<string, { sourceAgent: "codex" | "antigravity"; workspacePath: string; status: string; error?: string }>();
  for (const line of readTailLines(EVENTS_FILE, 2000)) {
    const event = parseJsonLine<{ sourceAgent: "codex" | "antigravity"; workspacePath: string; status: string; error?: string }>(line);
    if (!event?.workspacePath || !["codex", "antigravity"].includes(event.sourceAgent)) continue;
    previousChannels.set(`${event.sourceAgent}:${event.workspacePath}`, event);
  }
  for (const event of previousChannels.values()) {
    if (event.status !== "error") continue;
    if (event.error && isBenignEmptyError(event.error)) continue;
    const project = projects.find((candidate) => candidate.roots.some((root) => isWithin(event.workspacePath, root)));
    if (project) schedule(event.workspacePath, event.sourceAgent, project.name, 1);
  }
  const initialTargets = currentWatchTargets();
  for (const t of initialTargets) watchedTargets.add(t);
  watcher = watch(initialTargets, { ignoreInitial: true, depth: 1 });
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
