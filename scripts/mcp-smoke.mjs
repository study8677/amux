// MCP end-to-end smoke test: spawn `amux mcp` over stdio and call the tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { fileURLToPath } from "node:url";
import path from "node:path";

// usage: node scripts/mcp-smoke.mjs [workspace]
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = process.argv[2] ?? repo;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${repo}/dist/cli.js`, "mcp"],
  env: { ...process.env },
});
const client = new Client({ name: "amux-smoke", version: "0.0.1" });
await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const rec = await client.callTool({
  name: "record_decision_or_pitfall",
  arguments: { workspace, type: "pitfall", content: "用 better-sqlite3 打开 thread_history_1.sqlite 的 file: URI", reason: "better-sqlite3 不支持 URI 文件名，需用 node:sqlite + immutable=1", agent: "antigravity" },
});
console.log("record:", rec.content[0].text);

const ctx = await client.callTool({ name: "get_handoff_context", arguments: { workspace, caller: "antigravity", turns: 2 } });
const md = ctx.content[0].text;
console.log("handoff head:\n" + md.split("\n").slice(0, 12).join("\n"));
console.log("detailed turns chars:", ctx.content[1].text.length);
await client.close();
