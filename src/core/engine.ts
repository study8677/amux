import path from "node:path";
import type { HandoffState, NormalizedEvent, SessionRef } from "./types.js";
import type { ContextProject } from "./router.js";
import { findProjectForPath, routeSessions } from "./router.js";
import { ProjectStore } from "./store.js";
import { compact } from "./compactor/index.js";
import { loadConfig } from "./config.js";
import { exists, normRoot } from "./paths.js";
import { getHarness, getHarnesses } from "../harness/registry.js";
import { gitSnapshot, ensureGitExclude, type GitSnapshot } from "../collectors/git.js";
import { loadRegistry, syncProjects } from "../projects/sync.js";
import { projectKey } from "../projects/reconcile.js";

export interface ContextSyncResult {
  project: ContextProject;
  newEvents: Record<string, number>;
  newTurns: Record<string, number>;
  sessions: number;
  state: HandoffState | null;
  handoffFiles: string[];
  markdown?: string;
}

function normTs(e: NormalizedEvent): NormalizedEvent {
  const d = new Date(e.ts);
  return isNaN(d.getTime()) ? e : { ...e, ts: d.toISOString() };
}

/** All projects that get context sync: registry entries (or a live preview before the first project sync) + extra workspaces. */
export async function listContextProjects(extraWorkspaces: string[] = []): Promise<ContextProject[]> {
  const reg = loadRegistry();
  let entries = reg.projects;
  if (!reg.initialized || !entries.length) {
    try {
      entries = (await syncProjects({ apply: false })).plan.registry;
    } catch {
      entries = [];
    }
  }
  const projects: ContextProject[] = entries
    .filter((e) => !e.excluded)
    .map((e) => ({ key: e.key, name: e.name, roots: e.roots.filter(exists) }))
    .filter((p) => p.roots.length > 0);
  for (const ws of extraWorkspaces) {
    const n = normRoot(ws);
    const hit = projects.find((p) => p.roots.includes(n));
    if (!hit) projects.push({ key: projectKey([n]), name: path.basename(n), roots: [n] });
  }
  return projects;
}

export function projectForWorkspace(ws: string, projects: ContextProject[]): ContextProject {
  const n = normRoot(ws);
  return projects.find((p) => p.roots.includes(n)) ?? findProjectForPath(n, projects) ?? { key: projectKey([n]), name: path.basename(n), roots: [n] };
}

/** Discover sessions for all harnesses updated after `sinceMs`. */
export function discoverSessions(sinceMs = 0): SessionRef[] {
  return getHarnesses().flatMap((h) => h.listSessions(sinceMs));
}

function mergedGit(roots: string[]): GitSnapshot | undefined {
  let out: GitSnapshot | undefined;
  for (const r of roots) {
    const g = gitSnapshot(r);
    if (!g) continue;
    const prefix = roots.length > 1 ? path.basename(r) + "/" : "";
    out = out ?? { branch: g.branch, dirty: [] };
    out.dirty.push(...g.dirty.map((d) => prefix + d));
  }
  return out;
}

/**
 * Incrementally collect all sessions of a project, append to history, compact, and inject.
 * `dryRun` keeps everything in memory and returns the rendered markdown instead of writing.
 */
export async function syncProjectContext(
  project: ContextProject,
  sessions: SessionRef[],
  opts: { dryRun?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ContextSyncResult> {
  const cfg = loadConfig();
  const store = new ProjectStore(project.roots[0]);
  const cursors = opts.dryRun ? {} : store.loadCursors();
  const newEvents: Record<string, number> = {};
  const newTurns: Record<string, number> = {};
  const memory: NormalizedEvent[] = [];
  const ordered = [...sessions].sort((a, b) => a.updatedAt - b.updatedAt);

  let done = 0;
  for (const s of ordered) {
    const h = getHarness(s.harness);
    if (!h) continue;
    const ck = `${s.harness}:${s.id}`;
    let cursor = cursors[ck] ?? { offset: 0 };
    for (let guard = 0; guard < 10000; guard++) {
      const r = h.collect(s, cursor);
      cursor = r.cursor;
      const evs = r.events.map(normTs);
      const fresh = opts.dryRun ? evs : store.appendEvents(evs);
      if (opts.dryRun) memory.push(...evs);
      for (const e of fresh) {
        newEvents[e.agent] = (newEvents[e.agent] ?? 0) + 1;
        if (e.kind === "user_message") newTurns[e.agent] = (newTurns[e.agent] ?? 0) + 1;
      }
      if (!r.more) break;
    }
    cursors[ck] = cursor;
    opts.onProgress?.(++done, ordered.length);
  }

  const window = cfg.context.windowEvents * Math.max(1, getHarnesses().length);
  const events = (opts.dryRun ? memory.slice(-window * 4) : store.tailEvents(window * 2))
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-window);
  const manual = opts.dryRun ? [] : store.manualEvents();
  const hasAny = events.length > 0 || manual.length > 0;
  if (!hasAny && !opts.dryRun && !store.exists()) {
    return { project, newEvents, newTurns, sessions: sessions.length, state: null, handoffFiles: [] };
  }
  const state = await compact({ project: { name: project.name, roots: project.roots }, events, manual, git: mergedGit(project.roots) });

  if (opts.dryRun) {
    return { project, newEvents, newTurns, sessions: sessions.length, state, handoffFiles: [] };
  }
  store.saveState(state);
  store.saveCursors(cursors);
  return { project, newEvents, newTurns, sessions: sessions.length, state, handoffFiles: [] };
}

/** One-shot: sync a single workspace (used by `amux sync`, `amux init`, MCP). */
export async function syncWorkspace(ws: string, opts: { dryRun?: boolean; onProgress?: (d: number, t: number) => void } = {}) {
  const projects = await listContextProjects([ws]);
  const project = projectForWorkspace(ws, projects);
  const routed = routeSessions(discoverSessions(0), projects.some((p) => p.key === project.key) ? projects : [...projects, project]);
  return syncProjectContext(project, routed.get(project.key) ?? [], opts);
}

/** Append a manual decision / pitfall and re-compact without re-reading harness logs. */
export async function recordManual(
  ws: string,
  type: "decision" | "pitfall",
  content: string,
  reason?: string,
  agent?: string,
): Promise<{ project: ContextProject; state: HandoffState | null }> {
  const projects = await listContextProjects([ws]);
  const project = projectForWorkspace(ws, projects);
  const store = new ProjectStore(project.roots[0]);
  const ts = new Date().toISOString();
  store.appendEvents([
    {
      id: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      agent: "manual",
      sessionId: agent ?? "mcp",
      ts,
      kind: type,
      text: content,
      reason,
    },
  ]);
  const res = await syncProjectContext(project, [], {});
  return { project, state: res.state };
}
