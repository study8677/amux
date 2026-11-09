import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Minimal synchronous read-only DB facade over better-sqlite3 (or node:sqlite fallback). */
export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
}

type BetterSqlite = typeof import("better-sqlite3");
let BetterCtor: BetterSqlite | null | undefined;

function loadBetter(): BetterSqlite | null {
  if (BetterCtor !== undefined) return BetterCtor;
  try {
    BetterCtor = require("better-sqlite3") as BetterSqlite;
  } catch {
    BetterCtor = null;
  }
  return BetterCtor;
}

function openBetter(file: string): Db {
  const Ctor = loadBetter();
  if (!Ctor) throw new Error("better-sqlite3 unavailable");
  const db = new Ctor(file, { readonly: true, fileMustExist: true, timeout: 3000 });
  return {
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}

function openNodeSqlite(file: string): Db {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (f: string | URL, o?: object) => any };
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}

/**
 * Open via `file:...?immutable=1` (node:sqlite supports URI filenames). Used for WAL databases that
 * currently have no -shm/-wal (fully checkpointed), where a plain read-only open fails with SQLITE_CANTOPEN.
 */
function openImmutable(file: string): Db {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (f: string | URL, o?: object) => any };
  const url = new URL("file://");
  url.pathname = file;
  url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url, { readOnly: true });
  return {
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}

const SNAPSHOT_MAX = 256 * 1024 * 1024;

/** Copy db (+wal) into a temp snapshot dir to read databases we cannot open in place. */
function snapshot(file: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amux-snap-"));
  const dest = path.join(dir, path.basename(file));
  fs.copyFileSync(file, dest);
  for (const ext of ["-wal"]) {
    if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, dest + ext);
  }
  return dest;
}

/**
 * Open a SQLite database strictly read-only, never taking write locks on the harness' own files.
 * 1) better-sqlite3 readonly  2) node:sqlite readonly  3) immutable URI (checkpointed WAL dbs without -shm)
 * 4) snapshot copy (small files only).
 */
export function openReadonly(file: string): Db {
  const openers = loadBetter() ? [openBetter, openNodeSqlite] : [openNodeSqlite];
  let lastErr: unknown;
  for (const open of openers) {
    try {
      return open(file);
    } catch (e) {
      lastErr = e;
    }
  }
  const walActive = fs.existsSync(file + "-wal") && fs.statSync(file + "-wal").size > 0;
  if (!walActive) {
    try {
      return openImmutable(file);
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    if (fs.statSync(file).size > SNAPSHOT_MAX) throw lastErr;
    const snap = snapshot(file);
    const db = (loadBetter() ? openBetter : openNodeSqlite)(snap);
    return {
      all: db.all,
      close: () => {
        db.close();
        fs.rmSync(path.dirname(snap), { recursive: true, force: true });
      },
    };
  } catch (e2) {
    lastErr = e2;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Short-lived connection cache for hot loops (closed automatically after `ttlMs` idle). */
const cache = new Map<string, { db: Db; timer: NodeJS.Timeout }>();
export function cachedDb(file: string, ttlMs = 5000): Db {
  const hit = cache.get(file);
  const arm = (db: Db) =>
    setTimeout(() => {
      cache.delete(file);
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }, ttlMs).unref();
  if (hit) {
    clearTimeout(hit.timer);
    hit.timer = arm(hit.db);
    return hit.db;
  }
  const db = openReadonly(file);
  cache.set(file, { db, timer: arm(db) });
  return db;
}

export function withDb<T>(file: string, fn: (db: Db) => T): T {
  const db = openReadonly(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Online backup of a live SQLite DB (safe while the owning app is running). */
export async function backupDb(src: string, dest: string): Promise<void> {
  const Ctor = loadBetter();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (Ctor) {
    const db = new Ctor(src, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      await db.backup(dest);
    } finally {
      db.close();
    }
    return;
  }
  fs.copyFileSync(src, dest);
  if (fs.existsSync(src + "-wal")) fs.copyFileSync(src + "-wal", dest + "-wal");
}
