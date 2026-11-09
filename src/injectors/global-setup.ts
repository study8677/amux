import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGY_MCP_CONFIG, exists } from "../core/paths.js";
import { readJson, writeJson } from "../core/jsonl.js";
import { getHarnesses } from "../harness/registry.js";
import { findCodexBin } from "../harness/codex/appserver.js";
import { GLOBAL_RULE_BODY, removeBlock, upsertBlock, writeWithBackup } from "./blocks.js";

export interface SetupStep {
  step: string;
  ok: boolean;
  detail: string;
}

/** Command used by harnesses to launch the amux MCP server (absolute paths: GUI apps have a minimal PATH). */
export function mcpCommand(): { command: string; args: string[] } {
  const cli = process.argv[1] && process.argv[1].endsWith(".js") ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  return { command: process.execPath, args: [cli, "mcp"] };
}

export function setupGlobal(opts: { remove?: boolean } = {}): SetupStep[] {
  const steps: SetupStep[] = [];
  // 1) global rule blocks
  for (const h of getHarnesses()) {
    if (!h.globalRuleFile) continue;
    try {
      const prev = exists(h.globalRuleFile) ? fs.readFileSync(h.globalRuleFile, "utf8") : "";
      const next = opts.remove ? removeBlock(prev) : upsertBlock(prev, GLOBAL_RULE_BODY);
      const changed = writeWithBackup(h.globalRuleFile, next);
      steps.push({ step: `${h.displayName} 全局规则`, ok: true, detail: `${h.globalRuleFile}${changed ? "" : "（无变化）"}` });
    } catch (e) {
      steps.push({ step: `${h.displayName} 全局规则`, ok: false, detail: (e as Error).message });
    }
  }
  const { command, args } = mcpCommand();
  // 2) Codex MCP registration via the official CLI
  if (getHarnesses().some((h) => h.id === "codex")) {
    const bin = findCodexBin();
    try {
      if (opts.remove) execFileSync(bin, ["mcp", "remove", "amux"], { stdio: "pipe" });
      else {
        try {
          execFileSync(bin, ["mcp", "remove", "amux"], { stdio: "pipe" });
        } catch {
          /* not registered yet */
        }
        execFileSync(bin, ["mcp", "add", "amux", "--", command, ...args], { stdio: "pipe" });
      }
      steps.push({ step: "Codex MCP", ok: true, detail: opts.remove ? "已移除 amux" : `codex mcp add amux -- ${command} ${args.join(" ")}` });
    } catch (e) {
      steps.push({ step: "Codex MCP", ok: false, detail: `请手动执行：codex mcp add amux -- ${command} ${args.join(" ")}（${(e as Error).message.split("\n")[0]}）` });
    }
  }
  // 3) Antigravity global mcp_config.json
  if (getHarnesses().some((h) => h.id === "antigravity")) {
    try {
      const target = fs.existsSync(AGY_MCP_CONFIG) ? fs.realpathSync(AGY_MCP_CONFIG) : AGY_MCP_CONFIG;
      const cfg = readJson<{ mcpServers?: Record<string, unknown> }>(target, {});
      cfg.mcpServers = cfg.mcpServers ?? {};
      if (opts.remove) delete cfg.mcpServers.amux;
      else cfg.mcpServers.amux = { command, args };
      if (exists(target)) writeWithBackup(target, JSON.stringify(cfg, null, 2) + "\n");
      else writeJson(target, cfg);
      steps.push({ step: "Antigravity MCP", ok: true, detail: `${target}${opts.remove ? "（已移除 amux）" : ""}` });
    } catch (e) {
      steps.push({ step: "Antigravity MCP", ok: false, detail: (e as Error).message });
    }
  }
  return steps;
}
