import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME } from "../../core/paths.js";

const DESKTOP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const DESKTOP_CODEX_ALT = "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex";

/** Locate a codex binary that supports the experimental project API. */
export function findCodexBin(override?: string): string {
  if (override) return override;
  if (process.env.AMUX_CODEX_BIN) return process.env.AMUX_CODEX_BIN;
  for (const p of [DESKTOP_CODEX, DESKTOP_CODEX_ALT]) if (fs.existsSync(p)) return p;
  return "codex";
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal JSON-RPC client for `codex app-server` (stdio).
 * Writes go through Codex' own code path (migrations, locks, idempotency keys) — amux never writes Codex SQLite directly.
 */
export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private stderr = "";

  constructor(private bin: string = findCodexBin()) {}

  async start(): Promise<void> {
    if (this.proc) return;
    // Mirror imports and project updates can initialize under launchd without a login-shell snapshot.
    const proc = spawn(this.bin, ["app-server", "--disable", "shell_snapshot"], {
      env: { ...process.env, CODEX_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => this.onData(d));
    proc.stderr.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    proc.on("exit", (code) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`codex app-server exited (${code}): ${this.stderr.trim().slice(-500)}`));
      }
      this.pending.clear();
      this.proc = null;
    });
    proc.on("error", (e) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    });
    await this.request("initialize", {
      clientInfo: { name: "amux", title: "amux (Agent Multiplexer)", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id) && ("result" in msg || "error" in msg)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`codex ${msg.error.code ?? ""}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  }

  private notify(method: string, params?: unknown): void {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
    if (!this.proc) return Promise.reject(new Error("codex app-server not started"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timeout on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.stdin.end();
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        p.kill("SIGTERM");
        r();
      }, 1500);
      p.on("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

export interface CodexApiProject {
  id: string;
  name: string;
  roots: { path: string }[];
  metadata?: Record<string, string>;
  position?: number;
  updatedAt?: number;
}

export async function listAllProjects(client: CodexAppServerClient): Promise<CodexApiProject[]> {
  const out: CodexApiProject[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const res: { data: CodexApiProject[]; nextCursor?: string | null } = await client.request("project/list", {
      limit: 100,
      cursor,
    });
    out.push(...res.data);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

export function codexStateDb(): string {
  return path.join(CODEX_HOME, "state_5.sqlite");
}
