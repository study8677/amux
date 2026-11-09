import path from "node:path";
import type { HandoffState } from "../core/types.js";
import { writeFileAtomic } from "../core/jsonl.js";
import { fmtDateTime, truncate } from "../core/text.js";
import { label } from "../core/compactor/rules.js";
import { ensureDir } from "../core/paths.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Render a compact, LLM-friendly handoff document. */
export function renderHandoff(s: HandoffState): string {
  const L: string[] = [];
  L.push(`# amux Handoff — ${s.project.name}`);
  L.push(
    `> 自动生成，请勿手改 · 更新于 ${fmtDateTime(s.updatedAt)} · 上一个 Agent：**${s.lastActiveAgent ? label(s.lastActiveAgent) : "—"}** · 提取器：${s.compactor}` +
      ` · 会话数：${Object.entries(s.stats.sessions).map(([k, v]) => `${label(k)} ${v}`).join(" / ") || "0"}`,
  );
  if (s.project.roots.length > 1) L.push(`> 根目录：${s.project.roots.map((r) => "`" + r + "`").join("、")}`);
  L.push("");
  L.push("## 🎯 Current Objective");
  L.push(s.currentObjective || "—");
  L.push("");
  L.push("## ⛔ Tried & Failed（不要重复踩坑）");
  if (s.triedAndFailed.length)
    for (const p of s.triedAndFailed) L.push(`- ${p.attempt} → ${truncate(p.reason, 200)} _(${label(p.source)}, ${fmtDateTime(p.ts)})_`);
  else L.push("- 暂无记录");
  L.push("");
  L.push("## ✅ Decisions & Constraints");
  if (s.decisions.length) for (const d of s.decisions) L.push(`- ${d.text} _(${label(d.source)})_`);
  else L.push("- 暂无记录");
  L.push("");
  L.push("## 📂 Active Files");
  if (s.activeFiles.length) {
    L.push("| File | Intent | By |", "|---|---|---|");
    for (const f of s.activeFiles) L.push(`| \`${esc(f.path)}\` | ${esc(truncate(f.intent, 90))} | ${label(f.lastTouchedBy)} |`);
  } else L.push("- 暂无");
  L.push("");
  L.push("## 🔁 Recent Turns");
  if (s.recentTurns.length)
    s.recentTurns.forEach((t, i) => {
      L.push(`${i + 1}. **[${label(t.agent)} ${fmtDateTime(t.ts)}]** ${t.sessionTitle ? `_${truncate(t.sessionTitle, 40)}_ · ` : ""}User: ${t.user}`);
      if (t.agentDid) L.push(`   → Agent: ${t.agentDid}`);
      const extra = [t.files.length ? `改动 ${t.files.slice(0, 5).map((f) => "`" + f + "`").join(", ")}` : "", t.failures ? `${t.failures} 次失败命令` : ""].filter(Boolean);
      if (extra.length) L.push(`   · ${extra.join(" · ")}`);
    });
  else L.push("- 暂无");
  if (s.git) {
    L.push("");
    L.push("## 🧾 Git");
    L.push(`branch \`${s.git.branch ?? "?"}\` · ${s.git.dirty.length ? `未提交：${s.git.dirty.slice(0, 15).map((d) => "`" + d + "`").join(", ")}${s.git.dirty.length > 15 ? " …" : ""}` : "工作区干净"}`);
  }
  L.push("");
  L.push("---");
  L.push("_更多细节：调用 MCP 工具 `get_handoff_context`；记录决策/踩坑：`record_decision_or_pitfall`。_");
  return L.join("\n") + "\n";
}

export function writeHandoff(s: HandoffState, roots: string[]): string[] {
  const md = renderHandoff(s);
  const written: string[] = [];
  for (const r of roots) {
    const dir = path.join(r, ".amux");
    try {
      ensureDir(dir);
      writeFileAtomic(path.join(dir, "HANDOFF.md"), md);
      written.push(path.join(dir, "HANDOFF.md"));
    } catch {
      /* root may be read-only / missing */
    }
  }
  return written;
}
