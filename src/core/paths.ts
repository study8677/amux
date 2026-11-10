import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = os.homedir();

export const AMUX_HOME = process.env.AMUX_HOME ?? path.join(home, ".amux");
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(home, ".codex");
export const AGY_HOME = process.env.AMUX_AGY_HOME ?? path.join(home, ".gemini", "antigravity");
export const AGY_SUMMARIES_DB = path.join(AGY_HOME, "conversation_summaries.db");
export const ANTIGRAVITY_APP_DATA = AGY_HOME;
export const ANTIGRAVITY_SUMMARIES_DB = AGY_SUMMARIES_DB;
export const AGY_PROJECTS_DIR =
  process.env.AMUX_AGY_PROJECTS_DIR ?? path.join(home, ".gemini", "config", "projects");
export const AGY_MCP_CONFIG =
  process.env.AMUX_AGY_MCP_CONFIG ?? path.join(home, ".gemini", "config", "mcp_config.json");
export const AGY_GLOBAL_RULES = process.env.AMUX_AGY_GLOBAL_RULES ?? path.join(home, ".gemini", "GEMINI.md");
export const CODEX_GLOBAL_RULES = process.env.AMUX_CODEX_GLOBAL_RULES ?? path.join(CODEX_HOME, "AGENTS.md");

export const HOME_DIR = home;

/** Normalize a path or file:// URI into a canonical absolute path (realpath when it exists, NFC, no trailing slash). */
export function normRoot(input: string): string {
  let p = input.trim();
  if (p.startsWith("file://")) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = decodeURIComponent(p.replace(/^file:\/\//, ""));
    }
  }
  if (p.startsWith("~")) p = path.join(home, p.slice(1));
  p = path.resolve(p);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    /* keep as-is when it does not exist */
  }
  p = p.normalize("NFC");
  if (p.length > 1 && p.endsWith(path.sep)) p = p.slice(0, -1);
  return p;
}

/** True when `child` equals `parent` or is inside it. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Make a path relative to the first matching root (for display). */
export function relToRoots(p: string, roots: string[]): string {
  const n = p.normalize("NFC");
  for (const r of roots) {
    if (isWithin(n, r)) {
      const rel = path.relative(r, n);
      return roots.length > 1 ? path.join(path.basename(r), rel) : rel || ".";
    }
  }
  return n.startsWith(home) ? "~" + n.slice(home.length) : n;
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Resolve the workspace for project-scoped commands. */
export function resolveWorkspace(opt?: string): string {
  if (opt) return normRoot(opt);
  if (process.env.AMUX_WORKSPACE) return normRoot(process.env.AMUX_WORKSPACE);
  let dir = normRoot(process.cwd());
  // walk up to find .amux or .git
  let cur = dir;
  while (true) {
    if (exists(path.join(cur, ".amux")) || exists(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dir;
}
