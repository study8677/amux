import path from "node:path";
import type { HarnessProject, UnifiedProject } from "../core/types.js";
import { HOME_DIR, exists as fsExists } from "../core/paths.js";
import { hashString } from "../core/text.js";

export type Action =
  | { type: "create"; harness: string; key: string; name: string; roots: string[]; peers: Record<string, string> }
  | { type: "update"; harness: string; key: string; id: string; name?: string; roots?: string[] }
  | { type: "delete"; harness: string; key: string; id: string; name: string; reason: string };

export interface Plan {
  registry: UnifiedProject[];
  actions: Action[];
  /** Deletions withheld by guardrails (need explicit confirmation). */
  heldDeletes: Action[];
  /** Entries removed from the registry (unlinked or deleted everywhere). */
  removed: { key: string; name: string; reason: string }[];
  skipped: { key: string; name: string; harness?: string; reason: string }[];
}

export interface ReconcileOptions {
  harnesses: string[];
  exclude: string[];
  propagateDeletes: boolean;
  maxAutoDeletes: number;
  /** Harnesses whose project list could not be read reliably (no deletions inferred). */
  unreliable?: string[];
  /** Skip the maxAutoDeletes guard (user confirmed). */
  confirmDeletes?: boolean;
  /** Override for tests. */
  exists?: (p: string) => boolean;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;
const union = (...lists: string[][]) => {
  const out: string[] = [];
  for (const l of lists) for (const x of l) if (!out.includes(x)) out.push(x);
  return out;
};

export function projectKey(roots: string[]): string {
  return "p_" + hashString([...roots].sort().join("|"));
}

function isExcluded(name: string, roots: string[], exclude: string[]): boolean {
  return exclude.some((e) => e === name || roots.includes(e));
}

function isDangerousRoot(r: string): boolean {
  return r === "/" || r === HOME_DIR || r === path.dirname(HOME_DIR);
}

/**
 * N-way project reconciliation (pure; performs no I/O besides optional `exists`).
 *
 * 1. Keep existing registry links; drop ids that vanished (→ delete propagation / unlink).
 * 2. Attach unassigned projects to registry entries by root overlap.
 * 3. Pair remaining projects across harnesses greedily (overlap desc, same name first).
 * 4. Same-harness duplicates with identical root sets become aliases.
 * 5. 3-way merge of name/roots against `lastSynced`; missing harness copies are created.
 */
export function reconcile(
  current: Record<string, HarnessProject[]>,
  registryIn: UnifiedProject[],
  opts: ReconcileOptions,
): Plan {
  const existsFn = opts.exists ?? fsExists;
  const registry: UnifiedProject[] = structuredClone(registryIn);
  const plan: Plan = { registry, actions: [], heldDeletes: [], removed: [], skipped: [] };
  const byId = new Map<string, HarnessProject>();
  for (const h of opts.harnesses) for (const p of current[h] ?? []) byId.set(`${h}:${p.id}`, p);
  const assigned = new Set<string>();

  // ---- 1. existing links ----
  const deletions: { entry: UnifiedProject; gone: string[] }[] = [];
  for (const e of registry) {
    const gone: string[] = [];
    for (const [h, id] of Object.entries(e.ids)) {
      if (!opts.harnesses.includes(h)) continue;
      if (byId.has(`${h}:${id}`)) assigned.add(`${h}:${id}`);
      else gone.push(h);
    }
    e.aliases = (e.aliases ?? []).filter((a) => {
      const ok = byId.has(`${a.harness}:${a.id}`);
      if (ok) assigned.add(`${a.harness}:${a.id}`);
      return ok;
    });
    if (gone.length) deletions.push({ entry: e, gone });
  }

  // ---- delete detection ----
  const deleteActions: Action[] = [];
  for (const { entry, gone } of deletions) {
    const reliableGone = gone.filter((h) => !(opts.unreliable ?? []).includes(h));
    for (const h of gone) if (!reliableGone.includes(h)) assigned.add(`${h}:${entry.ids[h]}`); // keep link, can't tell
    if (!reliableGone.length) continue;
    const wasSynced = reliableGone.every((h) => entry.lastSynced?.ids?.[h] === entry.ids[h]);
    const survivors = Object.entries(entry.ids).filter(([h, id]) => byId.has(`${h}:${id}`));
    if (opts.propagateDeletes && wasSynced && !entry.excluded) {
      for (const [h, id] of survivors)
        deleteActions.push({
          type: "delete",
          harness: h,
          key: entry.key,
          id,
          name: byId.get(`${h}:${id}`)!.name,
          reason: `在 ${reliableGone.join("/")} 中已被删除`,
        });
      for (const a of entry.aliases ?? []) assigned.add(`${a.harness}:${a.id}`);
      for (const h of reliableGone) delete entry.ids[h];
      (entry as any).__deleting = true;
    } else {
      for (const h of reliableGone) delete entry.ids[h];
      if (entry.lastSynced) for (const h of reliableGone) delete entry.lastSynced.ids[h];
      // remember the opt-out so the project is not re-created on that side
      entry.detached = union(entry.detached ?? [], reliableGone);
      plan.skipped.push({ key: entry.key, name: entry.name, reason: `已在 ${reliableGone.join("/")} 删除，解除该侧同步` });
    }
  }

  // ---- 2 & 3. attach / pair unassigned ----
  const unassigned = () =>
    opts.harnesses.flatMap((h) => (current[h] ?? []).filter((p) => !assigned.has(`${h}:${p.id}`)));

  type Cand = { p: HarnessProject; e: UnifiedProject; ov: number; nameEq: boolean };
  const cands: Cand[] = [];
  for (const p of unassigned())
    for (const e of registry) {
      if ((e as any).__deleting || e.ids[p.harness]) continue;
      const ov = overlap(p.roots, e.roots);
      if (ov) cands.push({ p, e, ov, nameEq: p.name === e.name });
    }
  cands.sort((a, b) => b.ov - a.ov || Number(b.nameEq) - Number(a.nameEq));
  for (const c of cands) {
    const k = `${c.p.harness}:${c.p.id}`;
    if (assigned.has(k) || c.e.ids[c.p.harness]) continue;
    c.e.ids[c.p.harness] = c.p.id;
    assigned.add(k);
  }

  // cross-harness pairing among remaining projects
  const rest = unassigned();
  const pairs: { a: HarnessProject; b: HarnessProject; ov: number; nameEq: boolean }[] = [];
  for (let i = 0; i < rest.length; i++)
    for (let j = i + 1; j < rest.length; j++) {
      const a = rest[i];
      const b = rest[j];
      if (a.harness === b.harness) continue;
      const ov = overlap(a.roots, b.roots);
      if (ov) pairs.push({ a, b, ov, nameEq: a.name === b.name });
    }
  pairs.sort((x, y) => y.ov - x.ov || Number(y.nameEq) - Number(x.nameEq));
  const groupOf = new Map<string, UnifiedProject>();
  const newEntry = (p: HarnessProject): UnifiedProject => {
    const e: UnifiedProject = { key: projectKey(p.roots), name: p.name, roots: [...p.roots], ids: { [p.harness]: p.id } };
    registry.push(e);
    groupOf.set(`${p.harness}:${p.id}`, e);
    assigned.add(`${p.harness}:${p.id}`);
    return e;
  };
  for (const { a, b } of pairs) {
    const ka = `${a.harness}:${a.id}`;
    const kb = `${b.harness}:${b.id}`;
    const ga = groupOf.get(ka);
    const gb = groupOf.get(kb);
    if (ga && gb) continue;
    if (!ga && !gb) {
      if (assigned.has(ka) || assigned.has(kb)) continue;
      const e = newEntry(a);
      e.ids[b.harness] = b.id;
      groupOf.set(kb, e);
      assigned.add(kb);
    } else {
      const g = (ga ?? gb)!;
      const other = ga ? b : a;
      const ko = `${other.harness}:${other.id}`;
      if (assigned.has(ko) || g.ids[other.harness]) continue;
      g.ids[other.harness] = other.id;
      groupOf.set(ko, g);
      assigned.add(ko);
    }
  }

  // ---- 4. aliases & singletons ----
  for (const p of unassigned()) {
    const host = registry.find(
      (e) => !(e as any).__deleting && e.ids[p.harness] && e.ids[p.harness] !== p.id && sameSet(e.roots, p.roots),
    );
    if (host) {
      host.aliases = [...(host.aliases ?? []), { harness: p.harness, id: p.id, name: p.name }];
      assigned.add(`${p.harness}:${p.id}`);
      plan.skipped.push({ key: host.key, name: p.name, harness: p.harness, reason: `与「${host.name}」根目录相同，作为别名` });
    } else newEntry(p);
  }

  // ---- 5. merge & create ----
  const now = new Date().toISOString();
  for (const e of registry) {
    if ((e as any).__deleting) continue;
    const present = Object.entries(e.ids).filter(([h, id]) => byId.has(`${h}:${id}`));
    if (!present.length) {
      plan.removed.push({ key: e.key, name: e.name, reason: "所有工具中都已不存在" });
      (e as any).__drop = true;
      continue;
    }
    const projs = present.map(([h, id]) => byId.get(`${h}:${id}`)!);
    e.excluded = isExcluded(e.name, union(...projs.map((p) => p.roots)), opts.exclude) || projs.some((p) => isExcluded(p.name, p.roots, opts.exclude));
    if (e.excluded) {
      plan.skipped.push({ key: e.key, name: e.name, reason: "在 projects.exclude 中" });
      continue;
    }

    // 3-way merge
    const base = e.lastSynced;
    let targetName: string | undefined;
    let targetRoots: string[];
    if (!base) {
      targetRoots = union(...projs.map((p) => p.roots));
    } else {
      const changedRoots = projs.filter((p) => !sameSet(p.roots, base.roots));
      targetRoots = changedRoots.length ? union(...changedRoots.map((p) => p.roots)) : base.roots;
      const changedName = projs
        .filter((p) => base.names[p.harness] !== undefined && base.names[p.harness] !== p.name)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      if (changedName.length) targetName = changedName[0].name;
    }
    e.roots = targetRoots;
    if (targetName) e.name = targetName;
    else e.name = projs[0].name;

    for (const p of projs) {
      const upd: { name?: string; roots?: string[] } = {};
      if (targetName && p.name !== targetName) upd.name = targetName;
      if (!sameSet(p.roots, targetRoots)) upd.roots = targetRoots.filter((r) => existsFn(r) || p.roots.includes(r));
      if (upd.roots && sameSet(upd.roots, p.roots)) delete upd.roots;
      if (upd.name || upd.roots) plan.actions.push({ type: "update", harness: p.harness, key: e.key, id: p.id, ...upd });
    }

    // create in harnesses lacking a copy
    const missing = opts.harnesses.filter((h) => !e.ids[h] && !(e.detached ?? []).includes(h));
    if (missing.length) {
      const liveRoots = targetRoots.filter((r) => existsFn(r));
      if (!liveRoots.length) {
        plan.skipped.push({ key: e.key, name: e.name, reason: "根目录在磁盘上已不存在" });
      } else if (liveRoots.some(isDangerousRoot)) {
        plan.skipped.push({ key: e.key, name: e.name, reason: "根目录过宽（/ 或 home）" });
      } else {
        for (const h of missing)
          plan.actions.push({ type: "create", harness: h, key: e.key, name: e.name, roots: liveRoots, peers: { ...e.ids } });
      }
    }
    e.lastSynced = {
      names: Object.fromEntries(projs.map((p) => [p.harness, targetName ?? p.name])),
      roots: targetRoots,
      at: now,
      ids: { ...e.ids },
    };
  }

  // ---- delete guardrails ----
  if (deleteActions.length) {
    if (!opts.confirmDeletes && deleteActions.length > opts.maxAutoDeletes) {
      plan.heldDeletes = deleteActions;
      // keep held entries exactly as they were until the user confirms
      for (let i = 0; i < registry.length; i++)
        if ((registry[i] as any).__deleting) {
          const orig = registryIn.find((o) => o.key === registry[i].key);
          if (orig) registry[i] = structuredClone(orig);
        }
    } else {
      plan.actions.push(...deleteActions);
      for (const e of registry)
        if ((e as any).__deleting) {
          plan.removed.push({ key: e.key, name: e.name, reason: "删除已同步到其他工具" });
          (e as any).__drop = true;
        }
    }
  }

  plan.registry = registry
    .filter((e) => !(e as any).__drop)
    .map((e) => {
      const { __deleting: _d, __drop: _x, ...rest } = e as any;
      return rest as UnifiedProject;
    });
  return plan;
}
