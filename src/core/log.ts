import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { fmtTime } from "./text.js";

export type LogLevel = "info" | "warn" | "error" | "debug";

let logFile: string | null = null;
let quiet = false;
/** When true, log to stderr (MCP stdio mode must never write to stdout). */
let useStderr = false;

export function setLogFile(file: string | null): void {
  logFile = file;
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
}
export function setQuiet(q: boolean): void {
  quiet = q;
}
export function setStderr(v: boolean): void {
  useStderr = v;
}

const tagColor: Record<string, (s: string) => string> = {
  codex: pc.cyan,
  antigravity: pc.magenta,
  projects: pc.yellow,
  amux: pc.green,
  mcp: pc.blue,
};

export function log(tag: string, msg: string, level: LogLevel = "info"): void {
  if (level === "debug" && !process.env.AMUX_DEBUG) return;
  const ts = fmtTime();
  const plain = `[${ts}] [${tag}] ${msg}`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, plain + "\n");
    } catch {
      /* ignore */
    }
  }
  if (quiet) return;
  const color = tagColor[tag.toLowerCase().split(/\s|→/)[0]] ?? pc.white;
  const lvl = level === "error" ? pc.red : level === "warn" ? pc.yellow : (s: string) => s;
  const line = `${pc.dim(`[${ts}]`)} ${color(`[${tag}]`)} ${lvl(msg)}`;
  if (useStderr || level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}
