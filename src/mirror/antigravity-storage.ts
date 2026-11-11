import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ANTIGRAVITY_APP_DATA } from '../core/paths.js';
import type { MirrorSession } from './types.js';

// Fields match gemini_coder.Trajectory / exa.cortex_pb from Antigravity 2.31.
// Only clean text turns are persisted. The native API supplies identity and workspace metadata.
function varint(value: number): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  while (n > 127n) { bytes.push(Number(n & 127n) | 128); n >>= 7n; }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}
function integer(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}
function field(number: number, value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function timestamp(iso: string): Buffer {
  const ms = Date.parse(iso);
  return Buffer.concat([integer(1, Math.floor(ms / 1000)), integer(2, (ms % 1000) * 1e6)]);
}

/** Stop before importing if the installed native storage layout has changed. */
export function validateNativeStorageFormat(templateId: string): void {
  const sample = path.join(ANTIGRAVITY_APP_DATA, 'conversations', `${templateId}.db`);
  const db = new Database(sample, { readonly: true, fileMustExist: true });
  try {
    const expected: Record<string, string[]> = {
      steps: ['idx', 'step_type', 'status', 'has_subtrajectory', 'metadata', 'error_details', 'permissions', 'task_details', 'render_info', 'step_payload', 'step_format'],
      trajectory_meta: ['trajectory_id', 'cascade_id', 'trajectory_type', 'source'],
      trajectory_metadata_blob: ['id', 'data'],
    };
    for (const [table, columns] of Object.entries(expected)) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (JSON.stringify(actual.map((column) => column.name)) !== JSON.stringify(columns)) {
        throw new Error(`Antigravity 原生存储结构已变化 (${table})，镜像已暂停`);
      }
    }
    const formats = db.prepare('SELECT DISTINCT step_format FROM steps').all() as Array<{ step_format: number }>;
    if (formats.some((row) => row.step_format !== 0)) throw new Error('Antigravity 原生步骤编码已变化，镜像已暂停');
  } finally { db.close(); }
}

/** Build a new import from the app's own SQLite template, preserving native metadata. */
export async function prepareNativeImport(templateId: string, id: string, session: MirrorSession, directory: string): Promise<string> {
  const sourcePath = path.join(ANTIGRAVITY_APP_DATA, 'conversations', `${templateId}.db`);
  const output = path.join(directory, `${id}.db`);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try { await source.backup(output); } finally { source.close(); }
  const db = new Database(output);
  try {
    db.transaction(() => {
      const count = db.prepare('SELECT COUNT(*) AS count FROM steps').get() as { count: number };
      if (count.count !== 0) throw new Error('原生镜像模板已产生对话，停止导入');
      db.prepare('UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?').run(crypto.randomUUID(), id);
      const metadata = db.prepare('SELECT id, data FROM trajectory_metadata_blob').all() as Array<{ id: string; data: Buffer }>;
      for (const row of metadata) {
        // UUIDs have equal UTF-8 lengths, preserving protobuf field framing.
        const replaced = Buffer.from(row.data.toString('latin1').split(templateId).join(id), 'latin1');
        db.prepare('UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?').run(replaced, row.id);
      }
      const insert = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)');
      session.turns.forEach((turn, index) => {
        const user = turn.role === 'user';
        const type = user ? 14 : 15;
        const meta = field(1, timestamp(new Date(turn.timestamp || Date.now()).toISOString()));
        const content = user ? Buffer.concat([field(2, turn.text), field(3, field(1, turn.text))]) : field(1, turn.text);
        const payload = Buffer.concat([integer(1, type), integer(4, 3), field(5, meta), field(user ? 19 : 20, content)]);
        insert.run(index, type, meta, payload);
      });
    })();
  } finally { db.close(); }
  return output;
}
