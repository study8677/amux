import type { HandoffState, Turn } from "../types.js";
import type { CompactInput } from "./rules.js";
import { compactRules, buildTurns, label } from "./rules.js";
import { truncate } from "../text.js";
import { log } from "../log.js";

export function llmConfigured(): boolean {
  return !!process.env.AMUX_LLM_API_KEY;
}

function transcriptDigest(turns: Turn[], failures: string[]): string {
  const parts = turns.slice(-12).map(
    (t, i) =>
      `### Turn ${i + 1} [${label(t.agent)} · ${t.ts}]\nUSER: ${truncate(t.user, 800)}\nAGENT: ${truncate(t.agentDid, 900)}${
        t.files.length ? `\nFILES: ${t.files.slice(0, 10).join(", ")}` : ""
      }${t.failures ? `\nFAILED_COMMANDS: ${t.failures}` : ""}`,
  );
  return parts.join("\n\n") + (failures.length ? `\n\n### Failed attempts (raw)\n${failures.join("\n")}` : "");
}

/**
 * LLM-assisted compaction (OpenAI-compatible Chat Completions).
 * Falls back to the rule-based result on any error / timeout / invalid JSON.
 */
export async function compactLlm(input: CompactInput): Promise<HandoffState> {
  const draft = compactRules(input);
  const key = process.env.AMUX_LLM_API_KEY;
  if (!key) return draft;
  const base = (process.env.AMUX_LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.AMUX_LLM_MODEL ?? "gpt-4o-mini";
  const turns = buildTurns(input.events);
  const prompt = `你是 amux 的上下文蒸馏器。根据多个 AI 编程 Agent（Codex / Antigravity）在同一项目中的最近对话，输出供下一个 Agent 接力的交接状态。
只输出 JSON：{"currentObjective": string, "decisions": string[], "triedAndFailed": [{"attempt": string, "reason": string}], "fileIntents": {"<path>": "<intent>"}}
要求：中文；具体、可执行；triedAndFailed 只保留确实失败/被用户否决且尚未解决的方案；decisions 只保留已敲定的设计决策与用户约束；各列表不超过 10 条。

## 规则提取草稿
${JSON.stringify({ currentObjective: draft.currentObjective, decisions: draft.decisions.map((d) => d.text), triedAndFailed: draft.triedAndFailed, activeFiles: draft.activeFiles.map((f) => f.path) }, null, 1)}

## 最近对话
${transcriptDigest(turns, draft.triedAndFailed.map((p) => `- ${p.attempt} → ${p.reason}`))}`.slice(0, 24000);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body: any = await res.json();
    const out = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
    const now = new Date().toISOString();
    const lastAgent = draft.lastActiveAgent ?? "manual";
    const manualDecisions = draft.decisions.filter((d) => d.source === "manual");
    const manualPitfalls = draft.triedAndFailed.filter((p) => p.source === "manual");
    return {
      ...draft,
      currentObjective: typeof out.currentObjective === "string" && out.currentObjective ? out.currentObjective : draft.currentObjective,
      decisions: Array.isArray(out.decisions)
        ? [...manualDecisions, ...out.decisions.filter((d: unknown) => typeof d === "string").map((text: string) => ({ text, source: lastAgent, ts: now }))].slice(0, 12)
        : draft.decisions,
      triedAndFailed: Array.isArray(out.triedAndFailed)
        ? [
            ...manualPitfalls,
            ...out.triedAndFailed
              .filter((p: any) => p && typeof p.attempt === "string")
              .map((p: any) => ({ attempt: p.attempt, reason: String(p.reason ?? ""), source: lastAgent, ts: now })),
          ].slice(0, 10)
        : draft.triedAndFailed,
      activeFiles: draft.activeFiles.map((f) => ({ ...f, intent: out.fileIntents?.[f.path] ?? f.intent })),
      compactor: "llm",
    };
  } catch (e) {
    log("amux", `LLM 压缩失败，回退规则提取：${(e as Error).message}`, "warn");
    return draft;
  }
}

export async function compact(input: CompactInput): Promise<HandoffState> {
  return llmConfigured() ? compactLlm(input) : compactRules(input);
}
