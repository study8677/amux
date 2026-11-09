import type { SessionRef } from "./types.js";
import { isWithin } from "./paths.js";

export interface ContextProject {
  key: string;
  name: string;
  roots: string[];
}

/**
 * Route sessions to projects by the *longest* matching root, so a session in
 * `~/Projects/ddn/AI-GrowFlow` belongs to AI-GrowFlow, not to its parent `ddn`.
 */
export function routeSessions(sessions: SessionRef[], projects: ContextProject[]): Map<string, SessionRef[]> {
  const out = new Map<string, SessionRef[]>();
  const roots = projects.flatMap((p) => p.roots.map((r) => ({ r, key: p.key })));
  roots.sort((a, b) => b.r.length - a.r.length);
  for (const s of sessions) {
    let best: { key: string; len: number } | null = null;
    for (const sp of s.paths) {
      const hit = roots.find(({ r }) => isWithin(sp, r));
      if (hit && (!best || hit.r.length > best.len)) best = { key: hit.key, len: hit.r.length };
    }
    if (!best) continue;
    const list = out.get(best.key) ?? [];
    list.push(s);
    out.set(best.key, list);
  }
  return out;
}

export function findProjectForPath(p: string, projects: ContextProject[]): ContextProject | undefined {
  let best: { proj: ContextProject; len: number } | undefined;
  for (const proj of projects)
    for (const r of proj.roots)
      if (isWithin(p, r) && (!best || r.length > best.len)) best = { proj, len: r.length };
  return best?.proj;
}
