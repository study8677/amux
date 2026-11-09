import path from "node:path";
import type { HarnessProject, UnifiedProject } from "../core/types.js";
import { AMUX_HOME } from "../core/paths.js";
import { readJson, writeJson } from "../core/jsonl.js";
import { loadConfig } from "../core/config.js";
import { log } from "../core/log.js";
import { getHarnesses } from "../harness/registry.js";
import { reconcile, type Action, type Plan } from "./reconcile.js";

export const REGISTRY_FILE = path.join(AMUX_HOME, "registry.json");

export interface RegistryFile {
  version: 1;
  /** Set after the first confirmed `amux projects sync --yes`; the daemon only auto-applies afterwards. */
  initialized: boolean;
  updatedAt: string;
  projects: UnifiedProject[];
}

export function loadRegistry(): RegistryFile {
  return readJson<RegistryFile>(REGISTRY_FILE, { version: 1, initialized: false, updatedAt: "", projects: [] });
}

export function saveRegistry(r: RegistryFile): void {
  r.updatedAt = new Date().toISOString();
  writeJson(REGISTRY_FILE, r);
}

export interface SyncResult {
  plan: Plan;
  applied: { action: Action; ok: boolean; error?: string }[];
  hints: string[];
  current: Record<string, HarnessProject[]>;
}

export async function listAllProjects(): Promise<{ current: Record<string, HarnessProject[]>; failed: string[] }> {
  const current: Record<string, HarnessProject[]> = {};
  const failed: string[] = [];
  for (const h of getHarnesses()) {
    if (!h.projects) continue;
    try {
      current[h.id] = await h.projects.list();
    } catch (e) {
      failed.push(h.id);
      current[h.id] = [];
      log(h.id, `读取项目列表失败：${(e as Error).message}`, "warn");
    }
  }
  return { current, failed };
}

/** Compute (and optionally apply) a project sync across all installed harnesses. */
export async function syncProjects(opts: { apply: boolean; confirmDeletes?: boolean; propagateDeletes?: boolean }): Promise<SyncResult> {
  const cfg = loadConfig();
  const reg = loadRegistry();
  const harnesses = getHarnesses().filter((h) => h.projects);
  const { current, failed } = await listAllProjects();
  const unreliable = [
    ...failed,
    ...harnesses
      .map((h) => h.id)
      .filter((h) => (current[h] ?? []).length === 0 && reg.projects.some((p) => p.ids[h])),
  ];
  const plan = reconcile(current, reg.projects, {
    harnesses: harnesses.map((h) => h.id),
    exclude: cfg.projects.exclude,
    propagateDeletes: opts.propagateDeletes ?? cfg.projects.propagateDeletes,
    maxAutoDeletes: cfg.projects.maxAutoDeletes,
    unreliable,
    confirmDeletes: opts.confirmDeletes,
  });
  const result: SyncResult = { plan, applied: [], hints: [], current };
  if (!opts.apply) return result;

  const byKey = new Map(plan.registry.map((e) => [e.key, e]));
  const origByKey = new Map(reg.projects.map((e) => [e.key, e]));
  const prepared = new Set<string>();
  for (const action of plan.actions) {
    const h = harnesses.find((x) => x.id === action.harness);
    if (!h?.projects) continue;
    try {
      if (!prepared.has(h.id)) {
        await h.projects.prepareWrite?.();
        prepared.add(h.id);
      }
      const entry = byKey.get(action.key);
      if (action.type === "create") {
        const created = await h.projects.create({ name: action.name, roots: action.roots, peers: action.peers });
        if (entry && created.id) {
          entry.ids[h.id] = created.id;
          if (entry.lastSynced) {
            entry.lastSynced.ids[h.id] = created.id;
            entry.lastSynced.names[h.id] = created.name;
          }
        }
        log("projects", `${h.displayName} 新建项目「${action.name}」(${action.roots.join(", ")})`);
      } else if (action.type === "update") {
        await h.projects.update(action.id, { name: action.name, roots: action.roots });
        log("projects", `${h.displayName} 更新项目「${action.name ?? entry?.name}」${action.roots ? " 根目录 → " + action.roots.join(", ") : ""}`);
      } else {
        await h.projects.delete(action.id);
        log("projects", `${h.displayName} 删除项目「${action.name}」（${action.reason}）`, "warn");
      }
      result.applied.push({ action, ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      result.applied.push({ action, ok: false, error: msg });
      log("projects", `${h.displayName} ${action.type} 失败：${msg}`, "error");
      // roll back the sync base so the next cycle retries instead of reverting the other side
      const entry = byKey.get(action.key);
      if (entry) entry.lastSynced = origByKey.get(action.key)?.lastSynced;
    }
  }
  for (const id of prepared) {
    const hint = await harnesses.find((x) => x.id === id)?.projects?.finishWrite?.();
    if (hint) result.hints.push(hint);
  }
  saveRegistry({ ...reg, initialized: true, projects: plan.registry });
  return result;
}
