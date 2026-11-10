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
import { discoverSessions, listContextProjects, syncProjectContext } from "../core/engine.js";
import { loadRegistry, syncProjects } from "../projects/sync.js";
import { label } from "../core/compactor/rules.js";
import type { SessionRef } from "../core/types.js";
import { ActivityTracker, ACTIVE_WINDOW_MS } from "../core/activity.js";

export const PID_FILE = path.join(AMUX_HOME, "daemon.pid");
export const LOG_FILE = path.join(AMUX_HOME, "daemon.log");
const STATE_FILE = path.join(AMUX_HOME, "daemon-state.json");

interface DaemonState {
  /** Per-harness watermark (epoch ms) of the newest session update processed. */
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

/** The long-running daemon loop: project sync + context sync for every project on this machine. */
export async function runDaemon(opts: { quiet?: boolean } = {}): Promise<void> {
  const cfg = loadConfig();
  setLogFile(LOG_FILE);
  fs.writeFileSync(PID_FILE, String(process.pid));
  const state: DaemonState = readJson<DaemonState>(STATE_FILE, { watermarks: {}, backfillDone: false });
  const harnesses = getHarnesses();
  log("amux", `守护进程启动 pid=${process.pid} · harness: ${harnesses.map((h) => h.displayName).join(", ")}`);

  let projects: ContextProject[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  const rerun = new Set<string>();
  let pendingSessions = new Map<string, SessionRef[]>();

  // ---------- project list sync ----------
  let projectTimer: NodeJS.Timeout | null = null;
  let projectSyncing = false;
  const runProjectSync = async () => {
    if (projectSyncing) return;
    projectSyncing = true;
    try {
      const reg = loadRegistry();
      if (!reg.initialized) {
        log("projects", "项目同步尚未初始化：请先执行 `amux projects sync --yes` 确认首次对齐（守护进程只做上下文同步）", "warn");
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

  // ---------- context sync ----------
  const flushProject = async (key: string) => {
    if (running.has(key)) {
      rerun.add(key);
      return;
    }
    const project = projects.find((p) => p.key === key);
    const sessions = pendingSessions.get(key) ?? [];
    pendingSessions.delete(key);
    if (!project) return;
    running.add(key);
    try {
      const res = await syncProjectContext(project, sessions);
      for (const [agent, n] of Object.entries(res.newTurns)) {
        log(`${label(agent)} → amux`, `${project.name}：捕获 ${n} 轮新对话，HANDOFF.md 已同步`);
        // 自动触发对向镜像注入
        try {
          const { mirrorLatestSession } = await import("../mirror/index.js");
          const target = agent === "codex" ? "antigravity" : "codex";
          const mirrorRes = await mirrorLatestSession({
            workspacePath: project.roots[0],
            source: agent as any,
            target,
          });
          log("amux → mirror", `${project.name}：已自动镜像到 ${label(target)}「${mirrorRes.title}」（${mirrorRes.turnCount} 轮）`);
        } catch (mirrorErr) {
          log("amux → mirror", `镜像失败：${(mirrorErr as Error).message}`, "warn");
        }
      }
      const quietEvents = Object.entries(res.newEvents).filter(([a]) => !res.newTurns[a]);
      for (const [agent, n] of quietEvents) log(`${label(agent)} → amux`, `${project.name}：${n} 条新事件，HANDOFF.md 已同步`, "debug");
    } catch (e) {
      log("amux", `${project.name} 同步失败：${(e as Error).message}`, "error");
    } finally {
      running.delete(key);
      if (rerun.delete(key)) scheduleProject(key, []);
    }
  };
  const scheduleProject = (key: string, sessions: SessionRef[]) => {
    const list = pendingSessions.get(key) ?? [];
    for (const s of sessions) if (!list.some((x) => x.harness === s.harness && x.id === s.id)) list.push(s);
    pendingSessions.set(key, list);
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void flushProject(key);
      }, cfg.context.debounceMs),
    );
  };

  const tracker = new ActivityTracker();
  let watcherRef: FSWatcher | null = null;
  const scanSessions = () => {
    const recent = discoverSessions(Date.now() - ACTIVE_WINDOW_MS);
    watcherRef?.add(ActivityTracker.files(recent));
    const changed = tracker.changed(recent);
    if (!changed.length) return;
    for (const s of changed) state.watermarks[s.harness] = Math.max(state.watermarks[s.harness] ?? 0, s.updatedAt);
    const routed = routeSessions(changed, projects);
    for (const [key, list] of routed) scheduleProject(key, list);
  };

  // ---------- startup: project sync, then full backfill ----------
  await runProjectSync();
  if (!state.backfillDone) {
    const sinceMs = cfg.context.backfillDays > 0 ? Date.now() - cfg.context.backfillDays * 86400000 : 0;
    const all = discoverSessions(sinceMs);
    const routed = routeSessions(all, projects);
    log("amux", `全量回溯：${all.length} 个会话 → ${routed.size} 个项目`);
    let i = 0;
    for (const [key, list] of routed) {
      const project = projects.find((p) => p.key === key)!;
      i++;
      try {
        const res = await syncProjectContext(project, list);
        const n = Object.values(res.newEvents).reduce((a, b) => a + b, 0);
        log("amux", `[${i}/${routed.size}] ${project.name}：${list.length} 个会话 / ${n} 条事件已导入`);
      } catch (e) {
        log("amux", `[${i}/${routed.size}] ${project.name} 回溯失败：${(e as Error).message}`, "error");
      }
    }
    for (const s of all) state.watermarks[s.harness] = Math.max(state.watermarks[s.harness] ?? 0, s.updatedAt);
    state.backfillDone = true;
    writeJson(STATE_FILE, state);
    log("amux", "全量回溯完成，进入实时监听");
  }

  // ---------- watchers ----------
  const targets = [...new Set(harnesses.flatMap((h) => h.watchTargets()))].filter(exists);
  tracker.prime(discoverSessions(Date.now() - ACTIVE_WINDOW_MS));
  const watcher: FSWatcher = watch(targets, { ignoreInitial: true, depth: 1, awaitWriteFinish: false });
  watcherRef = watcher;
  watcher.add(ActivityTracker.files(discoverSessions(Date.now() - ACTIVE_WINDOW_MS)));
  let scanTimer: NodeJS.Timeout | null = null;
  watcher.on("all", (_ev, p) => {
    if (p.startsWith(AGY_PROJECTS_DIR) || /state_\d+\.sqlite/.test(p)) scheduleProjectSync();
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanSessions, 500);
  });
  // safety net polling (missed fs events, date rollover of Codex session dirs)
  const poll = setInterval(scanSessions, 20000);
  const projectPoll = setInterval(runProjectSync, 5 * 60000);
  log("amux", `实时监听 ${targets.length} 个路径 · ${projects.length} 个项目`);

  const shutdown = async () => {
    log("amux", "守护进程退出");
    clearInterval(poll);
    clearInterval(projectPoll);
    await watcher.close();
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (opts.quiet) return;
}
