import type { ActiveFile, Decision, HandoffState, NormalizedEvent, Pitfall, Turn } from "../types.js";
import type { GitSnapshot } from "../../collectors/git.js";
import { isWithin, relToRoots } from "../paths.js";
import { dedupeBy, firstParagraph, oneLine, sentences, truncate } from "../text.js";

export interface CompactInput {
  project: { name: string; roots: string[] };
  events: NormalizedEvent[];
  manual: NormalizedEvent[];
  git?: GitSnapshot;
}

const TRIVIAL_USER =
  /^(继续|继续吧|好的?|好的呢|ok|okay|yes|y|是的?|可以|行|嗯+|对|go|proceed|approved?|continue|lgtm|谢谢|thanks?)[\s!！。.~，,]*$/i;
const NEGATION =
  /(不对|不行|错了|别这样|不是这样|回滚|撤销|还是(不行|报错|有问题|失败|不对)|没(用|效果|解决|生效)|白做了|revert|roll ?back|that'?s wrong|doesn'?t work|didn'?t work|still (fails?|broken|errors?))/i;
const CONSTRAINT = /(不要|别再|禁止|不能|不准|不需要|必须|务必|一定要|只(能|做)|don'?t|do not|never|must)/i;
const AGENT_FAIL =
  /(行不通|不可行|走不通|失败了|报错了|没有生效|未生效|仍然报错|依然报错|无法(实现|解决|运行|通过|复现|启动)|已回退|回滚了|didn'?t work|does not work|doesn'?t work|failed because|was reverted|rolled back)/i;
const AGENT_DECISION =
  /(决定(采用|使用|改为|保留|放弃|不再)|采用了?|改为|统一(使用|为)|方案(是|为|定为)|选择了|确定(使用|采用)|最终(方案|选择)|we('ll| will) use|decided to|going with|switch(ed)? to|chose to)/i;
const NOT_DECISION = /(如果你|是否|要不要|需要你|我可以|可以帮你|建议你|[？?：:]$)/;
/** Pure read-only exploration commands (their failures are rarely meaningful pitfalls). */
const EXPLORE_SEG = /^\s*(pwd|cd|ls|cat|echo|printf|rg|grep|egrep|find|fd|head|tail|sed|awk|wc|stat|file|which|type|command|tree|du|git (status|diff|log|show|grep|rev-parse|branch)|sqlite3|jq|python3? -c|node -e|sleep|true|nl)\b/;
const ERR_LINE = /(error|Error|ERROR|failed|FAILED|not found|Cannot|cannot|ENOENT|EACCES|TS\d{4}|Traceback|Exception|panic|denied|refused|错误|失败)/;
const NOISY_CMD = /^(rg|grep|egrep|test|\[|diff|ls|find|cat|head|tail|which|sed|wc|stat|file|pgrep|pkill|command|type|git (diff|grep|show|log|status)|sleep|kill)\b/;

function isTrivialUser(t: string): boolean {
  const s = t.trim();
  return s.length < 4 || TRIVIAL_USER.test(s);
}

function isExploration(cmd: string): boolean {
  const unquoted = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  const segs = unquoted.split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean);
  return segs.length > 0 && segs.every((x) => EXPLORE_SEG.test(x) || /^[A-Z_]+=/.test(x));
}

function primaryCommand(cmd: string): string {
  return cmd
    .replace(/^cd\s+\S+\s*&&\s*/, "")
    .replace(/^(sudo|env\s+\S+=\S+)\s+/, "")
    .trim();
}

function failureReason(output: string): string {
  const clean = output.replace(/[\u2800-\u28ff]/g, "").replace(/\r/g, "\n");
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (ERR_LINE.test(lines[i])) { idx = i; break; }
  if (idx < 0) return truncate(lines[lines.length - 1] ?? "非零退出码", 220);
  // short hits like `"error": {` → include the following lines for context
  let reason = lines[idx];
  for (let j = idx + 1; reason.length < 60 && j < Math.min(lines.length, idx + 4); j++) reason += " " + lines[j];
  return truncate(reason, 220);
}

/** Group events into user→agent turns per session. */
export function buildTurns(events: NormalizedEvent[]): Turn[] {
  const open = new Map<string, Turn & { _lastAgent?: string }>();
  const turns: (Turn & { _lastAgent?: string })[] = [];
  for (const e of events) {
    if (e.agent === "manual") continue;
    if (e.kind === "user_message") {
      if (isTrivialUser(e.text) && open.has(e.sessionId)) continue; // "继续" continues the same turn
      const t: Turn & { _lastAgent?: string } = {
        agent: e.agent,
        sessionId: e.sessionId,
        sessionTitle: e.sessionTitle,
        ts: e.ts,
        user: e.text,
        agentDid: "",
        files: [],
        failures: 0,
      };
      open.set(e.sessionId, t);
      turns.push(t);
      continue;
    }
    const t = open.get(e.sessionId);
    if (!t) continue;
    if (e.kind === "agent_message") t._lastAgent = e.text;
    if (e.kind === "file_change" && e.files) for (const f of e.files) if (!t.files.includes(f.path)) t.files.push(f.path);
    if ((e.kind === "command" || e.kind === "tool_error") && e.failed) t.failures++;
  }
  for (const t of turns) {
    t.agentDid = t._lastAgent ?? "";
    delete t._lastAgent;
  }
  return turns;
}

export function compactRules(input: CompactInput): HandoffState {
  const { events, manual, project } = input;
  const roots = project.roots;
  const nonManual = events.filter((e) => e.agent !== "manual");
  const last = nonManual[nonManual.length - 1];
  const turns = buildTurns(events);

  // ---- objective ----
  const lastReal = [...nonManual].reverse().find((e) => e.kind === "user_message" && !isTrivialUser(e.text));
  let currentObjective = lastReal ? `[${label(lastReal.agent)}] ${firstParagraph(lastReal.text, 420)}` : "（尚未捕获到对话）";
  const task = [...events].reverse().find((e) => e.kind === "artifact" && e.text.startsWith("任务清单"));
  if (task && lastReal && task.sessionId === lastReal.sessionId) currentObjective += `\n${oneLine(task.text, 300)}`;

  // ---- tried & failed ----
  const pitfalls: Pitfall[] = [];
  const succeeded = new Map<string, string>(); // command → ts of last success
  for (const e of nonManual) if (e.kind === "command" && !e.failed && e.command) succeeded.set(primaryCommand(e.command), e.ts);
  for (const e of nonManual) {
    if (e.kind === "command" && e.failed && e.command) {
      const cmd = primaryCommand(e.command);
      const missing = /(?:command not found|not found: command):?\s*([\w.-]+)|zsh:\d+: command not found: ([\w.-]+)/.exec(e.text);
      if (missing) {
        const tool = missing[1] ?? missing[2];
        pitfalls.push({ attempt: `使用 \`${tool}\` 命令`, reason: `环境中没有 ${tool}（command not found），请换用其他工具`, source: e.agent, ts: e.ts });
        continue;
      }
      if (/not a git repository/.test(e.text)) continue;
      if (isExploration(cmd) || NOISY_CMD.test(cmd)) continue;
      if (!e.text.trim() && e.exitCode === 1) continue;
      const okTs = succeeded.get(cmd);
      if (okTs && okTs > e.ts) continue; // fixed later
      pitfalls.push({ attempt: `运行 \`${truncate(cmd.replace(/\s+/g, " "), 140)}\``, reason: failureReason(e.text), source: e.agent, ts: e.ts });
    } else if (e.kind === "tool_error" && !/^(read_file|view_file|list_dir|grep_search|find_by_name|read_url_content)/.test(e.text)) {
      pitfalls.push({ attempt: oneLine(e.text.split(":")[0], 120), reason: oneLine(e.text, 200), source: e.agent, ts: e.ts });
    }
  }
  // user rejections → previous agent action in that session failed
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!NEGATION.test(t.user)) continue;
    const prev = [...turns.slice(0, i)].reverse().find((p) => p.sessionId === t.sessionId);
    if (prev?.agentDid)
      pitfalls.push({ attempt: oneLine(prev.agentDid, 160), reason: `用户否定：${oneLine(t.user, 160)}`, source: t.agent, ts: t.ts });
  }
  // agent self-reports (turn-final answers only, to skip narration)
  const selfReports: Pitfall[] = [];
  for (const t of turns)
    for (const s of sentences(t.agentDid))
      if (AGENT_FAIL.test(s) && s.length <= 240 && !NOT_DECISION.test(s))
        selfReports.push({ attempt: oneLine(s, 200), reason: "Agent 自述", source: t.agent, ts: t.ts });
  pitfalls.push(...selfReports.slice(-4));

  const manualPitfalls: Pitfall[] = manual
    .filter((m) => m.kind === "pitfall")
    .map((m) => ({ attempt: m.text, reason: m.reason ?? "手动记录", source: "manual", ts: m.ts }));
  const triedAndFailed = [
    ...manualPitfalls.reverse(),
    ...dedupeBy(pitfalls.sort((a, b) => b.ts.localeCompare(a.ts)), (p) => p.attempt, 0.55),
  ].slice(0, 10);

  // ---- decisions ----
  const decisions: Decision[] = manual
    .filter((m) => m.kind === "decision")
    .reverse()
    .map((m) => ({ text: m.text, source: "manual", ts: m.ts }));
  const auto: Decision[] = [];
  for (const e of nonManual) {
    if (e.kind === "decision") {
      // enrich "approved implementation_plan.md" with the plan summary of that session
      const plan = [...events].reverse().find((a) => a.kind === "artifact" && a.sessionId === e.sessionId && a.text.startsWith("implementation_plan"));
      auto.push({ text: plan ? `已批准计划 — ${oneLine(plan.text, 220)}` : e.text, source: e.agent, ts: e.ts });
    } else if (e.kind === "user_message" && CONSTRAINT.test(e.text) && e.text.length <= 600) {
      const s = sentences(e.text).find((x) => CONSTRAINT.test(x));
      if (s) auto.push({ text: `用户约束：${oneLine(s, 180)}`, source: e.agent, ts: e.ts });
    }
  }
  for (const t of turns)
    for (const s of sentences(t.agentDid))
      if (AGENT_DECISION.test(s) && s.length <= 220 && !NOT_DECISION.test(s)) auto.push({ text: oneLine(s, 200), source: t.agent, ts: t.ts });
  decisions.push(...dedupeBy(auto.sort((a, b) => b.ts.localeCompare(a.ts)), (d) => d.text, 0.5));

  // ---- active files ----
  const scores = new Map<string, ActiveFile & { score: number }>();
  const turnOf = (e: NormalizedEvent) => [...turns].reverse().find((t) => t.sessionId === e.sessionId && t.ts <= e.ts);
  nonManual.forEach((e, idx) => {
    if (e.kind !== "file_change" || !e.files) return;
    for (const f of e.files) {
      const abs = f.path.normalize("NFC");
      if (!roots.some((r) => isWithin(abs, r))) continue;
      const rel = relToRoots(abs, roots);
      const cur = scores.get(rel);
      const w = 1 + idx / Math.max(1, nonManual.length);
      const t = turnOf(e);
      scores.set(rel, {
        path: rel,
        intent: t ? oneLine(t.user, 90) : f.op,
        lastTouchedBy: e.agent,
        ts: e.ts,
        score: (cur?.score ?? 0) + w,
      });
    }
  });
  let activeFiles: ActiveFile[] = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ score: _s, ...f }) => f);
  if (input.git) {
    for (const d of input.git.dirty.slice(0, 20)) {
      if (activeFiles.length >= 15) break;
      if (!activeFiles.some((f) => f.path === d || f.path.endsWith("/" + d)))
        activeFiles.push({ path: d, intent: "未提交改动（git）", lastTouchedBy: "git", ts: new Date().toISOString() });
    }
  }

  const sessions: Record<string, number> = {};
  for (const e of nonManual) sessions[e.agent] = (sessions[e.agent] ?? 0) + 0;
  const seen = new Set<string>();
  for (const e of nonManual) {
    const k = `${e.agent}:${e.sessionId}`;
    if (!seen.has(k)) {
      seen.add(k);
      sessions[e.agent] = (sessions[e.agent] ?? 0) + 1;
    }
  }

  return {
    version: 1,
    project,
    lastActiveAgent: last ? last.agent : null,
    updatedAt: new Date().toISOString(),
    currentObjective,
    decisions: decisions.slice(0, 12),
    triedAndFailed,
    activeFiles,
    recentTurns: turns
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(-5)
      .map((t) => ({ ...t, user: oneLine(t.user, 220), agentDid: firstParagraph(t.agentDid, 320), files: t.files.map((f) => relToRoots(f, roots)).slice(0, 8) })),
    git: input.git ? { branch: input.git.branch, dirty: input.git.dirty.slice(0, 30) } : undefined,
    compactor: "rules",
    stats: { events: events.length, sessions },
  };
}

export function label(agent: string): string {
  return agent === "codex" ? "Codex" : agent === "antigravity" ? "Antigravity" : agent === "manual" ? "手动" : agent;
}
