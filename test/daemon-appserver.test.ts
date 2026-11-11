import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

it("disables shell snapshots only for amux's app-server process", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    if (request.id) child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
  });
  child.stdin.on("finish", () => { queueMicrotask(() => child.emit("exit", 0)); });
  spawn.mockReturnValue(child);
  const { CodexAppServerClient } = await import("../src/harness/codex/appserver.js");
  const client = new CodexAppServerClient("/fake/codex");
  try {
    await client.start();
    expect(spawn).toHaveBeenCalledWith("/fake/codex", ["app-server", "--disable", "shell_snapshot"], expect.objectContaining({
      stdio: ["pipe", "pipe", "pipe"],
      env: expect.any(Object),
    }));
  } finally {
    await client.stop();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
