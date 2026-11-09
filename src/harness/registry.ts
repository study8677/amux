import type { HarnessAdapter } from "./types.js";
import { createCodexAdapter } from "./codex/index.js";
import { createAntigravityAdapter } from "./antigravity/index.js";
import { loadConfig } from "../core/config.js";

let cached: HarnessAdapter[] | null = null;

/** All harness adapters installed on this machine. Add new adapters here. */
export function getHarnesses(): HarnessAdapter[] {
  if (cached) return cached;
  const cfg = loadConfig();
  const all = [createCodexAdapter({ codexBin: cfg.codexBin }), createAntigravityAdapter()];
  cached = all.filter((h) => h.detect());
  return cached;
}

export function getHarness(id: string): HarnessAdapter | undefined {
  return getHarnesses().find((h) => h.id === id);
}
