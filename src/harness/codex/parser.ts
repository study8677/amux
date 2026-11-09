import path from "node:path";
import type { FileOp, NormalizedEvent } from "../../core/types.js";
import { parseJsonLine } from "../../core/jsonl.js";
import { tailLines, truncate } from "../../core/text.js";

const ITEM_RE = /"item":\{"type":"(UserMessage|AgentMessage|CommandExecution|FileChange)"/;
const LEGACY_RE = /"type":"(user_message|agent_message|exec_command_end|patch_apply_end)"/;

const LIMITS = { user: 4000, agent: 3000, output: 1200 };

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Strip Codex Desktop wrappers around the real user request. */
export function cleanCodexUserText(t: string): string {
  let s = t;
  const req = s.indexOf("## My request:");
  if (req >= 0) s = s.slice(req + "## My request:".length);
  s = s.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "");
  s = s.replace(/<app-context>[\s\S]*?<\/app-context>/g, "");
  return s.trim();
}

function shellCommand(cmd: unknown): string {
  if (Array.isArray(cmd)) {
    const i = cmd.findIndex((x) => x === "-lc" || x === "-c");
    if (i >= 0 && typeof cmd[i + 1] === "string") return cmd[i + 1];
    return cmd.join(" ");
  }
  return typeof cmd === "string" ? cmd : "";
}

function cwdPath(cwd: unknown, fallback?: string): string | undefined {
  if (typeof cwd !== "string") return fallback;
  return cwd.startsWith("file://") ? decodeURIComponent(cwd.replace(/^file:\/\//, "")) : cwd;
}

const changeOp = (t: unknown): FileOp => (t === "add" ? "create" : t === "delete" ? "delete" : "edit");

/** `/bin/zsh -lc 'cmd'` → `cmd` (thread_items stores the full shell invocation as one string). */
export function unwrapShell(cmd: string): string {
  const m = /^\/bin\/(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/.exec(cmd.trim());
  if (!m) return cmd;
  let s = m[1].trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  return s.replace(/'"'"'/g, "'").replace(/\\"/g, '"');
}

export interface ThreadItemRow {
  item_type: string;
  item_json: string;
  created_at_ms: number;
}

/** Parse rows of Codex `thread_history_*.sqlite → thread_items` (camelCase item schema). */
export function parseCodexItems(
  rows: ThreadItemRow[],
  ctx: { sessionId: string; sessionTitle?: string; cwd?: string },
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const row of rows) {
    const it = parseJsonLine<any>(row.item_json);
    if (!it) continue;
    const ts = new Date(row.created_at_ms).toISOString();
    const base = { agent: "codex" as const, sessionId: ctx.sessionId, sessionTitle: ctx.sessionTitle, ts };
    const id = `codex:${ctx.sessionId}:${it.id}`;
    switch (row.item_type) {
      case "userMessage": {
        const text = cleanCodexUserText(textOf(it.content));
        if (text) out.push({ ...base, id, kind: "user_message", text: truncate(text, LIMITS.user) });
        break;
      }
      case "agentMessage": {
        if (it.phase === "commentary" || typeof it.text !== "string" || !it.text) break;
        out.push({ ...base, id, kind: "agent_message", text: truncate(it.text, LIMITS.agent) });
        break;
      }
      case "commandExecution": {
        if (it.status !== "completed" && it.status !== "failed") break; // still running; picked up when updated
        const command = unwrapShell(String(it.command ?? ""));
        const cwd = typeof it.cwd === "string" ? it.cwd : ctx.cwd;
        const exitCode = typeof it.exitCode === "number" ? it.exitCode : undefined;
        const failed = it.status === "failed" || (exitCode !== undefined && exitCode !== 0);
        const files = Array.isArray(it.commandActions)
          ? it.commandActions
              .filter((c: any) => c?.type === "read" && typeof c.path === "string")
              .map((c: any) => ({ path: cwd ? path.resolve(cwd, c.path) : c.path, op: "read" as FileOp }))
          : [];
        out.push({
          ...base,
          id,
          kind: "command",
          command: truncate(command, 600),
          exitCode,
          failed,
          text: failed ? tailLines(String(it.aggregatedOutput ?? ""), 30).slice(-LIMITS.output) : "",
          files: files.length ? files : undefined,
        });
        break;
      }
      case "fileChange": {
        if (it.status && it.status !== "completed") break;
        const changes: any[] = Array.isArray(it.changes) ? it.changes : [];
        const files = changes
          .filter((c) => typeof c?.path === "string")
          .map((c) => ({ path: c.path as string, op: changeOp(c.kind?.type) }));
        if (files.length)
          out.push({ ...base, id, kind: "file_change", text: files.map((f) => `${f.op} ${f.path}`).join("\n"), files });
        break;
      }
    }
  }
  return out;
}

/**
 * Parse Codex rollout JSONL lines into normalized events.
 * Primary format: `event_msg/item_completed` (Codex >= 0.15x). Legacy `event_msg/*_end` events are also supported.
 */
export function parseCodexLines(
  lines: string[],
  ctx: { sessionId: string; sessionTitle?: string; cwd?: string },
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const line of lines) {
    const isItem = ITEM_RE.test(line);
    const isLegacy = !isItem && LEGACY_RE.test(line) && line.includes('"event_msg"');
    if (!isItem && !isLegacy) continue;
    const o = parseJsonLine<any>(line);
    if (!o || o.type !== "event_msg") continue;
    const p = o.payload ?? {};
    const ts: string = o.timestamp ?? new Date().toISOString();
    const base = { agent: "codex" as const, sessionId: ctx.sessionId, sessionTitle: ctx.sessionTitle, ts };
    const ord = o.ordinal ?? `${ts}`;

    if (isItem && p.type === "item_completed") {
      const it = p.item ?? {};
      const id = `codex:${ctx.sessionId}:${it.id ?? ord}`;
      switch (it.type) {
        case "UserMessage": {
          const text = cleanCodexUserText(textOf(it.content));
          if (text) out.push({ ...base, id, kind: "user_message", text: truncate(text, LIMITS.user) });
          break;
        }
        case "AgentMessage": {
          if (it.phase === "commentary") break;
          const text = textOf(it.content);
          if (text) out.push({ ...base, id, kind: "agent_message", text: truncate(text, LIMITS.agent) });
          break;
        }
        case "CommandExecution": {
          const command = shellCommand(it.command);
          const cwd = cwdPath(it.cwd, ctx.cwd);
          const exitCode = typeof it.exit_code === "number" ? it.exit_code : undefined;
          const failed = it.status === "failed" || (exitCode !== undefined && exitCode !== 0);
          const files = Array.isArray(it.parsed_cmd)
            ? it.parsed_cmd
                .filter((c: any) => c?.type === "read" && typeof c.path === "string")
                .map((c: any) => ({ path: cwd ? path.resolve(cwd, c.path) : c.path, op: "read" as FileOp }))
            : [];
          out.push({
            ...base,
            id,
            kind: "command",
            command: truncate(command, 600),
            exitCode,
            failed,
            text: failed ? tailLines(String(it.aggregated_output ?? ""), 30).slice(-LIMITS.output) : "",
            files: files.length ? files : undefined,
          });
          break;
        }
        case "FileChange": {
          const changes = it.changes && typeof it.changes === "object" ? it.changes : {};
          const files = Object.entries(changes).map(([fp, v]: [string, any]) => ({ path: fp, op: changeOp(v?.type) }));
          if (files.length)
            out.push({ ...base, id, kind: "file_change", text: files.map((f) => `${f.op} ${f.path}`).join("\n"), files });
          break;
        }
      }
      continue;
    }

    // ---- legacy rollout format ----
    const id = `codex:${ctx.sessionId}:${p.type}:${ord}:${p.call_id ?? ""}`;
    if (p.type === "user_message" && typeof p.message === "string") {
      const text = cleanCodexUserText(p.message);
      if (text) out.push({ ...base, id, kind: "user_message", text: truncate(text, LIMITS.user) });
    } else if (p.type === "agent_message" && typeof p.message === "string") {
      out.push({ ...base, id, kind: "agent_message", text: truncate(p.message, LIMITS.agent) });
    } else if (p.type === "exec_command_end") {
      const exitCode = typeof p.exit_code === "number" ? p.exit_code : undefined;
      const failed = exitCode !== undefined && exitCode !== 0;
      const outText = String(p.aggregated_output ?? `${p.stdout ?? ""}\n${p.stderr ?? ""}`);
      out.push({
        ...base,
        id,
        kind: "command",
        command: truncate(shellCommand(p.command), 600),
        exitCode,
        failed,
        text: failed ? tailLines(outText, 30).slice(-LIMITS.output) : "",
      });
    } else if (p.type === "patch_apply_end" && p.changes && typeof p.changes === "object") {
      const files = Object.entries(p.changes).map(([fp, v]: [string, any]) => ({
        path: fp,
        op: changeOp(v?.type ?? (v?.add ? "add" : v?.delete ? "delete" : "update")),
      }));
      if (files.length)
        out.push({ ...base, id, kind: "file_change", text: files.map((f) => `${f.op} ${f.path}`).join("\n"), files });
    }
  }
  return out;
}
