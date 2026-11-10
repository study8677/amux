import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "chokidar";
import { AMUX_HOME, AGY_PROJECTS_DIR, exists } from "../core/paths.js";
import { loadConfig } from "../core/config.js";
import { log, setLogFile } from "../core/log.js";
import { readJson, writeJson } from "../core/jsonl.js";
import { getHarnesses } from "../harness/registry.js";
import { routeSessions, type ContextProject } from "../core/router.js";
import { discoverSessions, listContextProjects } from "../core/engine.js";
import { loadRegistry, syncProjects } from "../projects/sync.js";
import { label } from "../core/compactor/rules.js";
import type { SessionRef } from "../core/types.js";
import { ActivityTracker, ACTIVE_WINDOW_MS } from "../core/activity.js";
import { mirrorLatestSession } from "../mirror/index.js";

export const PID_FILE = path.join(AMUX_HOME, "daemon.pid");
export const LOG_FILE = path.join(AMUX_HOME, "daemon.log");
const STATE_FILE = path.join(AMUX_HOME, "daemon-state.json");

interface DaemonState {
  watermarks: Record<string, number>;
  backfillDone: boolean;
}

export function daemonPid(): number | null {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return null;
  }
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Detach a background daemon process. */
export function startDaemonDetached(cliPath: string): number {
  fs.mkdirSync(AMUX_HOME, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [cliPath, "daemon", "run", "--quiet"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return child.pid ?? 0;
}

export function stopDaemon(): boolean {
  const pid = daemonPid();
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  return true;
}

/** Run the supervisor in the current process (blocking). */
export async function runDaemon(opts: { quiet?: boolean } = {}): Promise<void> {
  fs.mkdirSync(AMUX_HOME, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  setLogFile(LOG_FILE);

  const cleanup = () => {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
    log("daemon", "amux daemon 已停止");
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  log("daemon", `amux daemon 启动 (PID: ${process.pid})`);

  const cfg = loadConfig();
  let projects: ContextProject[] = await listContextProjects();

  // ---------- project sync ----------
  let projectTimer: NodeJS.Timeout | null = null;
  let projectSyncing = false;
  const runProjectSync = async () => {
    if (projectSyncing) return;
    projectSyncing = true;
    try {
      const reg = loadRegistry();
      if (!reg.initialized) {
        log("projects", "项目同步尚未初始化：请先执行 `amux projects sync --yes` 确认首次对齐", "warn");
      } else {
        const res = await syncProjects({ apply: true });
        if (res.plan.heldDeletes.length)
          log("projects", `有 ${res.plan.heldDeletes.length} 个删除超过自动阈值，已暂停：执行 \`amux projects sync --yes\` 确认`, "warn");
        for (const h of res.hints) log("projects", h);
      }
      projects = await listContextProjects();
    } catch (e) {
      log("projects", `项目同步失败：${(e as Error).message}`, "error");
    } finally {
      projectSyncing = false;
    }
  };
  const scheduleProjectSync = () => {
    if (projectTimer) clearTimeout(projectTimer);
    projectTimer = setTimeout(runProjectSync, 2000);
  };

  // ---------- thread mirror ----------
  const running = new Set<string>();
  const rerun = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const lastMirroredSignature = new Map<string, string>();

  const flushProject = async (key: string) => {
    if (running.has(key)) {
      rerun.add(key);
      return;
    }
    const project = projects.find((p) => p.key === key);
    if (!project || !project.roots.length) return;

    running.add(key);
    try {
      const ws = project.roots[0];
      const mirrorRes = await mirrorLatestSession({
        workspacePath: ws,
      });

      const signature = `${mirrorRes.targetAgent}:${mirrorRes.targetSessionId}:${mirrorRes.turnCount}`;
      if (lastMirroredSignature.get(key) !== signature) {
        lastMirroredSignature.set(key, signature);
        const targetName = mirrorRes.targetAgent === "codex" ? "OpenAI Codex" : "Google Antigravity";
        log("amux → mirror", `${project.name}：已自动将最新会话克隆至 ${targetName}「${mirrorRes.title}」（${mirrorRes.turnCount} 轮）`);
      }
    } catch (e) {
      log("amux → mirror", `${project.name} 镜像失败：${(e as Error).message}`, "warn");
    } finally {
      running.delete(key);
      if (rerun.delete(key)) scheduleProject(key);
    }
  };

  const scheduleProject = (key: string) => {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void flushProject(key);
      }, cfg.context.debounceMs)
    );
  };

  // ---------- file watchers ----------
  const targets = [...new Set(getHarnesses().flatMap((h) => h.watchTargets()))].filter(exists);
  const tracker = new ActivityTracker();
  let watchers: FSWatcher[] = [];

  const attachWatchers = () => {
    for (const w of watchers) void w.close();
    watchers = [];

    const harnessWatcher = watch(targets, { ignoreInitial: true, depth: 1 });
    harnessWatcher.on("all", (_event, filePath) => {
      if (filePath.startsWith(AGY_PROJECTS_DIR) || filePath.includes("state_")) scheduleProjectSync();
      const recent = routeSessions(discoverSessions(Date.now() - ACTIVE_WINDOW_MS), projects);
      for (const [key] of recent) scheduleProject(key);
    });
    watchers.push(harnessWatcher);

    const activeSessions = discoverSessions(Date.now() - ACTIVE_WINDOW_MS);
    tracker.prime(activeSessions);
    const activeFiles = ActivityTracker.files(activeSessions);
    if (activeFiles.length) {
      const activeWatcher = watch(activeFiles, { ignoreInitial: true });
      activeWatcher.on("all", () => {
        const fresh = discoverSessions(Date.now() - ACTIVE_WINDOW_MS);
        const changed = tracker.changed(fresh);
        if (!changed.length) return;
        const routed = routeSessions(changed, projects);
        for (const [key] of routed) scheduleProject(key);
      });
      watchers.push(activeWatcher);
    }
  };

  attachWatchers();
  const refreshInterval = setInterval(attachWatchers, 60000);

  log("daemon", `正在监听 ${projects.length} 个项目的对话事件与项目配置（防抖 ${cfg.context.debounceMs / 1000}s）`);

  await new Promise<void>(() => {});
  clearInterval(refreshInterval);
}
