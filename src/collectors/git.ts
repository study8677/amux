import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { exists } from "../core/paths.js";

export interface GitSnapshot {
  branch?: string;
  dirty: string[];
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  } catch {
    return null;
  }
}

/** `git status` snapshot for one root (undefined when not a git repo). */
export function gitSnapshot(root: string): GitSnapshot | undefined {
  if (!exists(root)) return undefined;
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) return undefined;
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]) ?? "";
  const dirty = status
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((f) => !f.startsWith(".amux/") && !f.startsWith(".amux"));
  return { branch, dirty };
}

/** Path of `.git/info/exclude` for a root (handles worktrees / submodules via rev-parse). */
export function gitExcludeFile(root: string): string | null {
  const gitDir = git(root, ["rev-parse", "--git-common-dir"])?.trim();
  if (!gitDir) return null;
  return path.join(path.isAbsolute(gitDir) ? gitDir : path.join(root, gitDir), "info", "exclude");
}

/** Ensure `pattern` is listed in `.git/info/exclude`. Returns true when added. */
export function ensureGitExclude(root: string, pattern: string): boolean {
  const file = gitExcludeFile(root);
  if (!file) return false;
  let content = "";
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    /* new file */
  }
  if (content.split("\n").some((l) => l.trim() === pattern)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (content && !content.endsWith("\n") ? "\n" : "") + `# added by amux\n${pattern}\n`);
  return true;
}
