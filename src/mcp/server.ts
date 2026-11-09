import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setStderr, log } from "../core/log.js";
import { resolveWorkspace } from "../core/paths.js";
import { listContextProjects, projectForWorkspace, recordManual, syncWorkspace } from "../core/engine.js";
import { ProjectStore } from "../core/store.js";
import { buildTurns, label } from "../core/compactor/rules.js";
import { renderHandoff } from "../injectors/handoff-md.js";
import { truncate } from "../core/text.js";

const WS_DESC =
  "Absolute path of the current project/workspace root (REQUIRED in practice: the MCP server's cwd is usually not your project).";

export async function startMcpServer(): Promise<void> {
  setStderr(true);
  const server = new McpServer({ name: "amux", version: "0.1.0" });

  server.registerTool(
    "get_handoff_context",
    {
      title: "Get cross-agent handoff context",
      description:
        "Return the latest amux handoff state for a project: current objective, decisions, tried-and-failed approaches (do NOT repeat them), hot files, plus the last N detailed turns from the OTHER agent harness (e.g. Codex when you are Antigravity). Call this at the start of a task.",
      inputSchema: {
        workspace: z.string().optional().describe(WS_DESC),
        turns: z.number().int().min(1).max(20).optional().describe("How many detailed turns to include (default 5)."),
        caller: z.string().optional().describe("Your harness id, e.g. 'codex' or 'antigravity' (used to pick the other agent's turns)."),
      },
    },
    async ({ workspace, turns = 5, caller }) => {
      const ws = resolveWorkspace(workspace);
      const res = await syncWorkspace(ws);
      const store = new ProjectStore(res.project.roots[0]);
      const events = store.tailEvents(3000).sort((a, b) => a.ts.localeCompare(b.ts));
      const all = buildTurns(events);
      const other = caller ? all.filter((t) => t.agent !== caller) : all;
      const detailed = (other.length ? other : all).slice(-turns).map((t) => ({
        agent: label(t.agent),
        session: t.sessionTitle,
        ts: t.ts,
        user: truncate(t.user, 1500),
        agent_reply: truncate(t.agentDid, 1500),
        files: t.files.slice(0, 15),
        failed_commands: t.failures,
      }));
      const md = res.state ? renderHandoff(res.state) : "(amux 尚未捕获到该项目的对话)";
      return {
        content: [
          { type: "text", text: md },
          { type: "text", text: "## Detailed recent turns\n" + JSON.stringify(detailed, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "record_decision_or_pitfall",
    {
      title: "Record a decision or pitfall",
      description:
        "Write an important design decision, user constraint, or a failed/rejected approach into the amux bus so the next agent (in any harness) sees it in HANDOFF.md.",
      inputSchema: {
        workspace: z.string().optional().describe(WS_DESC),
        type: z.enum(["decision", "pitfall"]),
        content: z.string().min(3).describe("The decision, or the approach that failed."),
        reason: z.string().optional().describe("For pitfalls: why it failed / was rejected."),
        agent: z.string().optional().describe("Your harness id, e.g. 'codex' or 'antigravity'."),
      },
    },
    async ({ workspace, type, content, reason, agent }) => {
      const ws = resolveWorkspace(workspace);
      const { project, state } = await recordManual(ws, type, content, reason, agent);
      return {
        content: [
          {
            type: "text",
            text: `已记录到 ${project.name}（${type}）。当前共 ${state?.decisions.length ?? 0} 条决策、${state?.triedAndFailed.length ?? 0} 条踩坑记录，HANDOFF.md 已刷新。`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List amux projects",
      description: "List projects unified across agent harnesses (name + root paths).",
      inputSchema: {},
    },
    async () => {
      const projects = await listContextProjects();
      return { content: [{ type: "text", text: JSON.stringify(projects.map((p) => ({ name: p.name, roots: p.roots })), null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("mcp", "amux MCP server ready (stdio)");
}

export { projectForWorkspace };
