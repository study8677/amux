import { describe, expect, it } from "vitest";
import { parseCodexItems, parseCodexLines, unwrapShell } from "../src/harness/codex/parser.js";
import { cleanAgyUserText, decodeArg, parseAgyLines } from "../src/harness/antigravity/parser.js";
import { routeSessions } from "../src/core/router.js";
import { removeBlock, upsertBlock } from "../src/injectors/blocks.js";
import { compactRules } from "../src/core/compactor/rules.js";
import type { NormalizedEvent, SessionRef } from "../src/core/types.js";

const ctx = { sessionId: "s1", sessionTitle: "t", cwd: "/w" };

describe("codex rollout parser", () => {
  const lines = [
    JSON.stringify({ timestamp: "2026-11-09T10:00:00Z", type: "session_meta", payload: { cwd: "/w" } }),
    JSON.stringify({
      timestamp: "2026-11-09T10:00:01Z",
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "# Files mentioned by the user:\n## My request:\n修复构建" }] } },
    }),
    JSON.stringify({
      timestamp: "2026-11-09T10:00:02Z",
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "AgentMessage", id: "m0", phase: "commentary", content: [{ type: "Text", text: "我先看看" }] } },
    }),
    JSON.stringify({
      timestamp: "2026-11-09T10:00:03Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "pnpm build"], status: "failed", exit_code: 1, aggregated_output: "ok\nerror TS2345: bad", parsed_cmd: [] },
      },
    }),
    JSON.stringify({
      timestamp: "2026-11-09T10:00:04Z",
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "FileChange", id: "f1", changes: { "/w/a.ts": { type: "update" }, "/w/b.ts": { type: "add" } } } },
    }),
    JSON.stringify({ timestamp: "2026-11-09T10:00:05Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } }),
  ];
  it("extracts user / command / file events and skips commentary + injected messages", () => {
    const ev = parseCodexLines(lines, ctx);
    expect(ev.map((e) => e.kind)).toEqual(["user_message", "command", "file_change"]);
    expect(ev[0].text).toBe("修复构建");
    expect(ev[1]).toMatchObject({ command: "pnpm build", failed: true, exitCode: 1 });
    expect(ev[2].files).toEqual([
      { path: "/w/a.ts", op: "edit" },
      { path: "/w/b.ts", op: "create" },
    ]);
  });

  it("parses thread_history items", () => {
    const ev = parseCodexItems(
      [
        { item_type: "userMessage", created_at_ms: 1, item_json: JSON.stringify({ id: "u", content: [{ type: "text", text: "hi there" }] }) },
        { item_type: "commandExecution", created_at_ms: 2, item_json: JSON.stringify({ id: "c", command: "/bin/zsh -lc 'npm test'", status: "failed", exitCode: 2, aggregatedOutput: "Error: x" }) },
        { item_type: "commandExecution", created_at_ms: 3, item_json: JSON.stringify({ id: "r", command: "/bin/zsh -lc 'npm test'", status: "inProgress" }) },
        { item_type: "fileChange", created_at_ms: 4, item_json: JSON.stringify({ id: "f", changes: [{ path: "/w/x.ts", kind: { type: "add" } }] }) },
      ],
      ctx,
    );
    expect(ev.map((e) => e.kind)).toEqual(["user_message", "command", "file_change"]);
    expect(ev[1].command).toBe("npm test");
  });

  it("unwraps shell invocations", () => {
    expect(unwrapShell(`/bin/zsh -lc 'git status'`)).toBe("git status");
    expect(unwrapShell(`/bin/bash -c "ls -la"`)).toBe("ls -la");
  });
});

describe("antigravity transcript parser", () => {
  it("decodes double-encoded args and pairs GENERIC results with queued tool calls", () => {
    const rows = [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-09T10:00:00Z", content: "<USER_REQUEST>\n加个按钮\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-09T10:00:01Z",
        tool_calls: [
          { name: "read_file", args: { Path: '"/w/a.ts"' } },
          { name: "run_command", args: { CommandLine: '"npm run build"' } },
          { name: "edit_file", args: { Path: '"/w/a.ts"' } },
        ],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "file content" },
      { step_index: 3, type: "GENERIC", status: "DONE", content: "Command exited with code 2.\nerror: boom" },
      { step_index: 4, type: "GENERIC", status: "DONE", content: "ok" },
    ].map((r) => JSON.stringify(r));
    const state = { pending: [] };
    const ev = parseAgyLines(rows, { sessionId: "a1" }, state);
    expect(ev.map((e) => e.kind)).toEqual(["user_message", "file_change", "command"]);
    expect(ev[0].text).toBe("加个按钮");
    expect(ev[2]).toMatchObject({ command: "npm run build", exitCode: 2, failed: true });
    expect(state.pending).toHaveLength(0);
  });

  it("recognizes artifact approvals", () => {
    const r = cleanAgyUserText("Comments on artifact URI: file:///x/implementation_plan.md\n\nThe user has approved this document.\n\n<USER_REQUEST>\n\n</USER_REQUEST>");
    expect(r).toEqual({ text: "", approvedArtifact: "implementation_plan.md" });
    expect(decodeArg('"/a b"')).toBe("/a b");
  });
});

describe("router", () => {
  it("routes sessions to the longest matching root", () => {
    const s = (id: string, p: string): SessionRef => ({ harness: "codex", id, paths: [p], updatedAt: 0, file: "" });
    const r = routeSessions([s("1", "/p/ddn/app/src"), s("2", "/p/ddn/other"), s("3", "/elsewhere")], [
      { key: "ddn", name: "ddn", roots: ["/p/ddn"] },
      { key: "app", name: "app", roots: ["/p/ddn/app"] },
    ]);
    expect(r.get("app")?.map((x) => x.id)).toEqual(["1"]);
    expect(r.get("ddn")?.map((x) => x.id)).toEqual(["2"]);
  });
});

describe("marker blocks", () => {
  it("upserts idempotently and preserves user content", () => {
    const base = "1.中文回复我\n";
    const once = upsertBlock(base, "hello");
    expect(upsertBlock(once, "hello")).toBe(once);
    expect(once.startsWith("1.中文回复我\n")).toBe(true);
    expect(upsertBlock(once, "world")).toContain("world");
    expect(removeBlock(once).trim()).toBe("1.中文回复我");
  });
});

describe("rule compactor", () => {
  const e = (i: number, agent: string, kind: NormalizedEvent["kind"], text: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    id: String(i),
    agent,
    sessionId: agent + "-s",
    ts: `2026-11-09T10:00:${String(i).padStart(2, "0")}Z`,
    kind,
    text,
    ...extra,
  });
  it("captures objective, failures, user rejections and hot files", () => {
    const s = compactRules({
      project: { name: "p", roots: ["/w"] },
      manual: [],
      events: [
        e(1, "codex", "user_message", "把登录改成 OAuth"),
        e(2, "codex", "command", "", { command: "pnpm build", failed: true, exitCode: 1, text: "error TS2345: Argument of type" }),
        e(3, "codex", "file_change", "", { files: [{ path: "/w/src/auth.ts", op: "edit" }] }),
        e(4, "codex", "agent_message", "已改用 passport 实现 OAuth。"),
        e(5, "codex", "user_message", "不对，回滚，不要用 passport"),
        e(6, "codex", "command", "", { command: "rg foo", failed: true, exitCode: 1, text: "" }),
        e(7, "antigravity", "user_message", "继续实现 OAuth，用 next-auth"),
      ],
    });
    expect(s.lastActiveAgent).toBe("antigravity");
    expect(s.currentObjective).toContain("next-auth");
    expect(s.triedAndFailed.some((p) => p.attempt.includes("pnpm build") && p.reason.includes("TS2345"))).toBe(true);
    expect(s.triedAndFailed.some((p) => p.reason.startsWith("用户否定"))).toBe(true);
    expect(s.triedAndFailed.some((p) => p.attempt.includes("rg foo"))).toBe(false);
    expect(s.activeFiles[0].path).toBe("src/auth.ts");
    expect(s.decisions.some((d) => d.text.includes("不要用 passport"))).toBe(true);
  });
});
