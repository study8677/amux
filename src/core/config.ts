import path from "node:path";
import { AMUX_HOME } from "./paths.js";
import { readJson, writeJson } from "./jsonl.js";

export interface AmuxConfig {
  projects: {
    /** Root paths (or names) that must never be synced. */
    exclude: string[];
    /** Propagate deletions across harnesses (with guardrails). */
    propagateDeletes: boolean;
    /** Max deletions applied automatically per reconcile cycle. */
    maxAutoDeletes: number;
  };
  context: {
    /** Backfill horizon in days for the first run; 0 = full history. */
    backfillDays: number;
    /** Debounce (ms) after the last change before re-compacting a project. */
    debounceMs: number;
    /** Events per agent considered by the compactor. */
    windowEvents: number;
  };
  codexBin?: string;
}

export const DEFAULT_CONFIG: AmuxConfig = {
  projects: { exclude: [], propagateDeletes: true, maxAutoDeletes: 2 },
  context: { backfillDays: 0, debounceMs: 3000, windowEvents: 400 },
};

export const CONFIG_FILE = path.join(AMUX_HOME, "config.json");

export function loadConfig(): AmuxConfig {
  const raw = readJson<Partial<AmuxConfig>>(CONFIG_FILE, {});
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    projects: { ...DEFAULT_CONFIG.projects, ...(raw.projects ?? {}) },
    context: { ...DEFAULT_CONFIG.context, ...(raw.context ?? {}) },
  };
}

export function saveConfig(cfg: AmuxConfig): void {
  writeJson(CONFIG_FILE, cfg);
}
