import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { HarnessProject, SessionRef } from "../../core/types.js";
import { AMUX_HOME, CODEX_GLOBAL_RULES, CODEX_HOME, exists, normRoot } from "../../core/paths.js";
import { backupDb, cachedDb, withDb } from "../../core/sqlite.js";
import { readAppended, readFirstLine, parseJsonLine } from "../../core/jsonl.js";
import { log } from "../../core/log.js";
import type { CollectResult, Cursor, HarnessAdapter, ProjectInput, ProjectStore } from "../types.js";
import { parseCodexItems, parseCodexLines, type ThreadItemRow } from "./parser.js";
import { CodexAppServerClient, findCodexBin, listAllProjects } from "./appserver.js";

/** Find the newest `state_N.sqlite` (Codex bumps N on breaking migrations). */
export function findStateDb(): string | null {
  try {
    const files = fs
      .readdirSync(CODEX_HOME)
      .map((f) => /^state_(\d+)\.sqlite$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    return files.length ? path.join(CODEX_HOME, files[0][0]) : null;
  } catch {
    return null;
  }
}

/** Codex projects rollouts into `thread_history_N.sqlite`; old rollout files are pruned afterwards. */
export function findHistoryDb(): string | null {
  try {
    const files = fs
      .readdirSync(CODEX_HOME)
      .map((f) => /^thread_history_(\d+)\.sqlite$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    return files.length ? path.join(CODEX_HOME, files[0][0]) : null;
  } catch {
    return null;
  }
}

const HISTORY_PREFIX = "codex-history:";
const ITEM_TYPES = "('userMessage','agentMessage','commandExecution','fileChange')";

function todayDirs(): string[] {
  const dirs: string[] = [];
  for (const offset of [0, -1]) {
    const d = new Date(Date.now() + offset * 86400000);
    const p = path.join(
      CODEX_HOME,
      "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    dirs.push(p);
  }
  return dirs;
}

/** Fallback session discovery: scan rollout first lines (session_meta) when the state DB is unavailable. */
function scanRollouts(sinceMs: number): SessionRef[] {
  const root = path.join(CODEX_HOME, "sessions");
  const out: SessionRef[] = [];
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        const st = fs.statSync(p);
        if (st.mtimeMs <= sinceMs) continue;
        const meta = parseJsonLine<any>(readFirstLine(p) ?? "");
        const pl = meta?.payload;
        if (!pl?.cwd || pl.agent_role) continue;
        out.push({ harness: "codex", id: pl.id ?? e.name, paths: [normRoot(pl.cwd)], updatedAt: st.mtimeMs, file: p });
      }
    }
  };
  walk(root);
  return out;
}

class CodexProjectStore implements ProjectStore {
  private client: CodexAppServerClient | null = null;
  private backedUp = false;

  constructor(private bin?: string) {}

  async list(): Promise<HarnessProject[]> {
    const db = findStateDb();
    if (db) {
      try {
        return withDb(db, (d) => {
          const rows = d.all<{ id: string; name: string; path: string; updated_at_ms: number }>(
            `SELECT p.id, p.name, p.updated_at_ms, r.path FROM projects p
             JOIN project_roots r ON r.project_id = p.id ORDER BY p.position, r.position`,
          );
          const map = new Map<string, HarnessProject>();
          for (const r of rows) {
            const cur = map.get(r.id) ?? { harness: "codex", id: r.id, name: r.name, roots: [], updatedAt: r.updated_at_ms };
            cur.roots.push(normRoot(r.path));
            map.set(r.id, cur);
          }
          return [...map.values()];
        });
      } catch (e) {
        log("codex", `读取 projects 表失败，改用 app-server：${(e as Error).message}`, "warn");
      }
    }
    const c = await this.ensureClient();
    return (await listAllProjects(c)).map((p) => ({
      harness: "codex",
      id: p.id,
      name: p.name,
      roots: p.roots.map((r) => normRoot(r.path)),
      updatedAt: (p.updatedAt ?? 0) * 1000,
    }));
  }

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (!this.client) {
      this.client = new CodexAppServerClient(findCodexBin(this.bin));
      await this.client.start();
    }
    return this.client;
  }

  async prepareWrite(): Promise<void> {
    if (this.backedUp) return;
    const db = findStateDb();
    if (db) {
      const stamp = new Date().toISOString().slice(0, 10);
      const dest = path.join(AMUX_HOME, "backups", `codex-${path.basename(db, ".sqlite")}-${stamp}.sqlite`);
      if (!exists(dest)) {
        await backupDb(db, dest);
        log("codex", `已在线备份 ${path.basename(db)} → ${dest}`);
      }
    }
    this.backedUp = true;
    await this.ensureClient();
  }

  async create(p: ProjectInput): Promise<HarnessProject> {
    const c = await this.ensureClient();
    const metadata: Record<string, string> = { "amux.managed": "true" };
    for (const [k, v] of Object.entries(p.peers ?? {})) metadata[`amux.${k}ProjectId`] = v;
    const key = `amux:${Object.values(p.peers ?? {}).join(",") || p.roots.join("|")}`;
    const res: any = await c.request("project/create", {
      idempotencyKey: key,
      name: p.name,
      roots: p.roots.map((r) => ({ path: r })),
      metadata,
    });
    const proj = res?.project ?? res;
    return {
      harness: "codex",
      id: proj?.id ?? "",
      name: proj?.name ?? p.name,
      roots: (proj?.roots ?? p.roots.map((r) => ({ path: r }))).map((r: any) => normRoot(r.path)),
    };
  }

  async update(id: string, p: Partial<ProjectInput>): Promise<void> {
    const c = await this.ensureClient();
    await c.request("project/update", {
      projectId: id,
      ...(p.name ? { name: p.name } : {}),
      ...(p.roots ? { roots: p.roots.map((r) => ({ path: r })) } : {}),
    });
  }

  async delete(id: string): Promise<void> {
    const c = await this.ensureClient();
    await c.request("project/delete", { projectId: id });
  }

  async finishWrite(): Promise<string | void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    if (isCodexDesktopRunning()) return "Codex Desktop 正在运行：如未立即看到项目变化，请在侧边栏刷新或重启 Desktop。";
  }
}

export function isCodexDesktopRunning(): boolean {
  try {
    const out = execFileSync("pgrep", ["-f", "Codex Framework.framework"], { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function createCodexAdapter(opts: { codexBin?: string } = {}): HarnessAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    globalRuleFile: CODEX_GLOBAL_RULES,
    detect: () => exists(CODEX_HOME),
    projects: new CodexProjectStore(opts.codexBin),

    listSessions(sinceMs: number): SessionRef[] {
      const db = findStateDb();
      if (db) {
        try {
          return withDb(db, (d) =>
            d
              .all<{ id: string; cwd: string; title: string; rollout_path: string; updated_at_ms: number | null; updated_at: number }>(
                `SELECT id, cwd, title, rollout_path, updated_at_ms, updated_at FROM threads
                 WHERE archived = 0 AND agent_role IS NULL AND COALESCE(updated_at_ms, updated_at * 1000) > ?`,
                sinceMs,
              )
              .map((r) => ({
                harness: "codex",
                id: r.id,
                title: (r.title || "").split("\n")[0].slice(0, 120),
                paths: [normRoot(r.cwd)],
                updatedAt: r.updated_at_ms ?? r.updated_at * 1000,
                // live rollout when present, otherwise the projected history DB
                file: r.rollout_path && exists(r.rollout_path) ? r.rollout_path : HISTORY_PREFIX + r.id,
              })),
          );
        } catch (e) {
          log("codex", `读取 threads 失败，改为扫描 rollout：${(e as Error).message}`, "warn");
        }
      }
      return scanRollouts(sinceMs);
    },

    collect(session: SessionRef, cursor: Cursor): CollectResult {
      if (session.file.startsWith(HISTORY_PREFIX)) {
        const db = findHistoryDb();
        if (!db) return { events: [], cursor, more: false };
        const since = Number(cursor.extra?.ordinal ?? -1);
        const BATCH = 3000;
        let rows: (ThreadItemRow & { ord: number })[] = [];
        try {
          rows = cachedDb(db).all<ThreadItemRow & { ord: number }>(
            `SELECT item_type, item_json, created_at_ms, MAX(rollout_ordinal, updated_at_ordinal) AS ord FROM thread_items
             WHERE thread_id = ? AND item_type IN ${ITEM_TYPES} AND MAX(rollout_ordinal, updated_at_ordinal) > ?
             ORDER BY ord LIMIT ${BATCH}`,
            session.id,
            since,
          );
        } catch (e) {
          log("codex", `读取 thread_history 失败：${(e as Error).message}`, "warn");
          return { events: [], cursor, more: false };
        }
        const events = parseCodexItems(rows, { sessionId: session.id, sessionTitle: session.title, cwd: session.paths[0] });
        const last = rows.length ? rows[rows.length - 1].ord : since;
        return { events, cursor: { offset: 0, extra: { ordinal: last } }, more: rows.length === BATCH };
      }
      const r = readAppended(session.file, cursor.offset);
      const events = parseCodexLines(r.lines, {
        sessionId: session.id,
        sessionTitle: session.title,
        cwd: session.paths[0],
      });
      return { events, cursor: { offset: r.newOffset }, more: r.more };
    },

    watchTargets(): string[] {
      const db = findStateDb();
      return [...(db ? [db + "-wal", db] : []), ...todayDirs().filter(exists)];
    },
  };
}
