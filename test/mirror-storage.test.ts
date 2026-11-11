import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it('builds an isolated native import with visible user items and preserved workspace metadata', async () => {
  vi.resetModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amux-storage-tests-'));
  const conversations = path.join(root, 'agy', 'conversations');
  const imports = path.join(root, 'imports');
  fs.mkdirSync(conversations, { recursive: true });
  fs.mkdirSync(imports);
  vi.stubEnv('AMUX_AGY_HOME', path.join(root, 'agy'));
  const templateId = '11111111-1111-4111-8111-111111111111';
  const destinationId = '22222222-2222-4222-8222-222222222222';
  const originalTrajectoryId = '33333333-3333-4333-8333-333333333333';
  const template = new Database(path.join(conversations, `${templateId}.db`));
  template.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
  `);
  template.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, 1)').run(originalTrajectoryId, templateId);
  const metadata = Buffer.from(`workspace=file:///tmp/project;root=${templateId};project=native-project`);
  template.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', metadata);
  template.close();
  const { prepareNativeImport } = await import('../src/mirror/antigravity-storage.js');
  const output = await prepareNativeImport(templateId, destinationId, {
    sourceAgent: 'codex', targetAgent: 'antigravity', sourceSessionId: 'source', workspacePath: '/tmp/project', title: 'test',
    turns: [{ role: 'user', text: '用户验收短语', timestamp: 1 }, { role: 'assistant', text: '助手验收回复', timestamp: 2 }],
  }, imports);
  const db = new Database(output, { readonly: true });
  const identity = db.prepare('SELECT * FROM trajectory_meta').get() as any;
  expect(identity.cascade_id).toBe(destinationId);
  expect(identity.trajectory_id).not.toBe(originalTrajectoryId);
  const savedMetadata = (db.prepare('SELECT data FROM trajectory_metadata_blob').get() as any).data.toString();
  expect(savedMetadata).toBe(`workspace=file:///tmp/project;root=${destinationId};project=native-project`);
  const steps = db.prepare('SELECT step_payload FROM steps ORDER BY idx').all() as Array<{ step_payload: Buffer }>;
  // Native userInput carries both user_response and items[0].text for model context and visible bubbles.
  expect(steps[0].step_payload.toString().split('用户验收短语')).toHaveLength(3);
  expect(steps[1].step_payload.includes(Buffer.from('助手验收回复'))).toBe(true);
  db.close();
  const source = new Database(path.join(conversations, `${templateId}.db`), { readonly: true });
  expect((source.prepare('SELECT COUNT(*) AS count FROM steps').get() as any).count).toBe(0);
  expect((source.prepare('SELECT cascade_id FROM trajectory_meta').get() as any).cascade_id).toBe(templateId);
  source.close();
});
