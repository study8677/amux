import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/jsonl.js";
import { AMUX_HOME, exists } from "../core/paths.js";

export const START = "<!-- AMUX:START -->";
export const END = "<!-- AMUX:END -->";

/** Insert or replace an AMUX marker block inside `content` (idempotent). */
export function upsertBlock(content: string, body: string): string {
  const block = `${START}\n${body.trim()}\n${END}`;
  const s = content.indexOf(START);
  const e = content.indexOf(END);
  if (s >= 0 && e > s) return content.slice(0, s) + block + content.slice(e + END.length);
  const sep = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block + "\n";
}

export function removeBlock(content: string): string {
  const s = content.indexOf(START);
  const e = content.indexOf(END);
  if (s < 0 || e < s) return content;
  return (content.slice(0, s).replace(/\n+$/, "\n") + content.slice(e + END.length).replace(/^\n+/, "")).replace(/^\n$/, "");
}

/** Back up a file once (first modification by amux), then write. */
export function writeWithBackup(file: string, next: string): boolean {
  const prev = exists(file) ? fs.readFileSync(file, "utf8") : "";
  if (prev === next) return false;
  if (exists(file)) {
    const bdir = path.join(AMUX_HOME, "backups");
    fs.mkdirSync(bdir, { recursive: true });
    const dest = path.join(bdir, `${path.basename(path.dirname(file))}-${path.basename(file)}.${Date.now()}.bak`);
    fs.copyFileSync(file, dest);
  }
  writeFileAtomic(file, next);
  return true;
}

export const GLOBAL_RULE_BODY = `## amux context handoff
本机由 amux 在多个 AI 编程 Agent（Codex / Antigravity …）之间同步上下文。
- 开始任何任务前：如果当前工作区根目录存在 \`.amux/HANDOFF.md\`，先阅读它（或调用 MCP 工具 \`get_handoff_context\` 并传入工作区绝对路径），重点关注 “Tried & Failed”，不要重复已经失败或被用户否决的方案。
- 做出重要设计决策、或确认某个方案走不通时：调用 \`record_decision_or_pitfall\` 记录，供下一个 Agent 接力。`;

export function projectRuleBody(): string {
  return `## amux context handoff
本项目由 amux 在 Codex / Antigravity 之间同步上下文。开始任务前：
1. 阅读 \`.amux/HANDOFF.md\`（或调用 MCP 工具 \`get_handoff_context\`），尤其是 “Tried & Failed”。
2. 做出重要决策或踩坑后，调用 \`record_decision_or_pitfall\` 记录。
@[amux handoff](.amux/HANDOFF.md)`;
}
