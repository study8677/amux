import path from "node:path";
import type { FileOp, NormalizedEvent } from "../../core/types.js";
import { parseJsonLine } from "../../core/jsonl.js";
import { tailLines, truncate } from "../../core/text.js";

const LIMITS = { user: 4000, agent: 3000, output: 1200 };

const EDIT_TOOLS: Record<string, string[]> = {
  write_file: ["Path"],
  edit_file: ["Path"],
  write_to_file: ["TargetFile"],
  replace_file_content: ["TargetFile"],
  multi_replace_file_content: ["TargetFile"],
};
const RUN_TOOLS = new Set(["run_command"]);

/** Antigravity encodes tool args as JSON strings inside JSON (`"Path": "\"/abs\""`). */
export function decodeArg(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || s.startsWith("{") || s.startsWith("[") || s === "true" || s === "false") {
    try {
      return JSON.parse(s);
    } catch {
      return v;
    }
  }
  return v;
}

/** Extract the real user request from an Antigravity USER_INPUT step. */
export function cleanAgyUserText(content: string): { text: string; approvedArtifact?: string } {
  let approvedArtifact: string | undefined;
  const ap = /Comments on artifact URI:\s*(\S+)[\s\S]*?The user has approved this document/.exec(content);
  if (ap) approvedArtifact = path.basename(ap[1]);
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  let text = m ? m[1] : content;
  text = text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .replace(/Comments on artifact URI:[\s\S]*?(?=<USER_REQUEST>|$)/g, "")
    .trim();
  return { text, approvedArtifact };
}

interface PendingCall {
  name: string;
  command?: string;
  file?: string;
}

export interface AgyParseState {
  pending: PendingCall[];
}

/**
 * Parse Antigravity `transcript.jsonl` lines.
 * Tool results (GENERIC steps) follow the PLANNER_RESPONSE that issued the calls, in order;
 * the queue of outstanding calls is carried in `state` across incremental reads.
 */
export function parseAgyLines(
  lines: string[],
  ctx: { sessionId: string; sessionTitle?: string },
  state: AgyParseState,
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const line of lines) {
    const o = parseJsonLine<any>(line);
    if (!o) continue;
    const ts: string = o.created_at ?? new Date().toISOString();
    const id = `agy:${ctx.sessionId}:${o.step_index}`;
    const base = { agent: "antigravity" as const, sessionId: ctx.sessionId, sessionTitle: ctx.sessionTitle, ts };

    switch (o.type) {
      case "USER_INPUT": {
        state.pending = [];
        const { text, approvedArtifact } = cleanAgyUserText(String(o.content ?? ""));
        if (approvedArtifact)
          out.push({ ...base, id: id + ":approve", kind: "decision", text: `用户批准了 ${approvedArtifact}` });
        if (text) out.push({ ...base, id, kind: "user_message", text: truncate(text, LIMITS.user) });
        break;
      }
      case "PLANNER_RESPONSE": {
        const text = typeof o.content === "string" ? o.content.trim() : "";
        if (text) out.push({ ...base, id, kind: "agent_message", text: truncate(text, LIMITS.agent) });
        const calls: any[] = Array.isArray(o.tool_calls) ? o.tool_calls : [];
        const edits: { path: string; op: FileOp }[] = [];
        for (const tc of calls) {
          const name = String(tc?.name ?? "");
          const args: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(tc?.args ?? {})) args[k] = decodeArg(v);
          const pc: PendingCall = { name };
          if (EDIT_TOOLS[name]) {
            const key = EDIT_TOOLS[name].find((k) => typeof args[k] === "string");
            if (key) {
              const fp = String(args[key]);
              const op: FileOp = name.startsWith("write") && !args.Overwrite && !args.Append ? "create" : "edit";
              edits.push({ path: fp, op });
              pc.file = fp;
            }
          } else if (RUN_TOOLS.has(name)) {
            pc.command = String(args.CommandLine ?? "");
          }
          state.pending.push(pc);
        }
        if (edits.length)
          out.push({
            ...base,
            id: id + ":edits",
            kind: "file_change",
            text: edits.map((e) => `${e.op} ${e.path}`).join("\n"),
            files: edits,
          });
        break;
      }
      case "GENERIC": {
        // every GENERIC row (DONE / RUNNING / ERROR / INVALID) is the result of exactly one queued tool call
        const call = state.pending.shift();
        if (o.status === "RUNNING") break; // backgrounded command: no exit code yet
        const content = String(o.content ?? "");
        if (call?.command !== undefined) {
          const m = /exited with code (-?\d+)/.exec(content);
          const exitCode = m ? Number(m[1]) : undefined;
          const failed = o.status === "ERROR" || (exitCode !== undefined && exitCode !== 0);
          if (exitCode !== undefined || failed) {
            const body = content.replace(/^Created At:.*\n?|^Completed At:.*\n?/gm, "");
            out.push({
              ...base,
              id,
              kind: "command",
              command: truncate(call.command, 600),
              exitCode,
              failed,
              text: failed ? tailLines(body, 30).slice(-LIMITS.output) : "",
            });
          }
        } else if (o.status === "ERROR") {
          const err = String(o.error ?? content);
          out.push({
            ...base,
            id,
            kind: "tool_error",
            text: truncate(`${call?.name ?? "tool"}${call?.file ? ` ${call.file}` : ""}: ${err}`, 600),
            failed: true,
          });
        }
        break;
      }
      default:
        break; // SYSTEM_MESSAGE / CHECKPOINT / ERROR_MESSAGE (infra noise) are ignored
    }
  }
  return out;
}

/** Summarize brain artifacts (task.md / implementation_plan.md) into a short text. */
export function summarizeArtifact(name: string, content: string): string {
  const lines = content.split("\n");
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "").trim() ?? name;
  if (name === "task.md") {
    const open = lines.filter((l) => /^\s*[-*]\s+\[\s\]/.test(l)).map((l) => l.replace(/^\s*[-*]\s+\[\s\]\s*/, "").trim());
    const done = lines.filter((l) => /^\s*[-*]\s+\[[xX]\]/.test(l)).length;
    return `任务清单「${title}」：已完成 ${done} 项，未完成 ${open.length} 项${open.length ? "：" + open.slice(0, 8).join("；") : ""}`;
  }
  const heads = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
  return `${name}「${title}」${heads.length ? "：" + heads.slice(0, 8).join(" / ") : ""}`;
}
