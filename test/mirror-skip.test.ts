import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ db: '', last: {} as any, extract: vi.fn(), mirror: vi.fn() }));
vi.mock('../src/harness/codex/index.js', () => ({ findStateDb: () => mocked.db }));
vi.mock('../src/mirror/state.js', () => ({ getLastSync: () => mocked.last, isMirrorTarget: () => false,
  sessionFingerprint: (session: any) => session.turns[0].text }));
vi.mock('../src/mirror/extract-codex.js', () => ({ extractCodexSession: mocked.extract }));
vi.mock('../src/mirror/to-antigravity.js', () => ({ mirrorToAntigravity: mocked.mirror }));

let directory = '';
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amux-skip-tests-'));
  vi.stubEnv('AMUX_AGY_HOME', path.join(directory, 'agy'));
  vi.stubEnv('AMUX_HOME', path.join(directory, 'state'));
  mocked.db = path.join(directory, 'state.sqlite');
  const rollout = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(rollout, '');
  const db = new Database(mocked.db);
  db.exec('CREATE TABLE threads (id TEXT, title TEXT, name TEXT, rollout_path TEXT, updated_at_ms INTEGER, created_at_ms INTEGER, cwd TEXT, archived INTEGER, agent_role TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)').run('source', 'test', 'test', rollout, Date.now(), Date.now(), '/tmp/project');
  db.close();
  mocked.extract.mockResolvedValue({ sourceAgent: 'codex', targetAgent: 'antigravity', sourceSessionId: 'source',
    workspacePath: '/tmp/project', title: 'test', turns: [{ role: 'user', text: 'current-content', timestamp: 1 }] });
  mocked.mirror.mockResolvedValue({ targetAgent: 'antigravity', targetSessionId: 'new-target', title: 'test', turnCount: 1 });
  mocked.last = { targetAgent: 'antigravity', targetSessionId: 'old-target', turnCount: 1,
    fingerprint: 'current-content', nativeReadbackVerifiedAt: 1, nativeStorageVersion: 2 };
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

it('repairs a same-content historical target whose native DB is missing', async () => {
  const { mirrorLatestSession } = await import('../src/mirror/index.js');
  await mirrorLatestSession({ workspacePath: '/tmp/project', source: 'codex' });
  expect(mocked.mirror).toHaveBeenCalledOnce();
});

it('upgrades old inline-storage mirrors even when their DB exists', async () => {
  fs.mkdirSync(path.join(directory, 'agy', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'agy', 'conversations', 'old-target.db'), '');
  mocked.last.nativeStorageVersion = 1;
  const { mirrorLatestSession } = await import('../src/mirror/index.js');
  await mirrorLatestSession({ workspacePath: '/tmp/project', source: 'codex' });
  expect(mocked.mirror).toHaveBeenCalledOnce();
});

it('syncs edited content when the number of turns is unchanged', async () => {
  fs.mkdirSync(path.join(directory, 'agy', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'agy', 'conversations', 'old-target.db'), '');
  mocked.last.fingerprint = 'old-content';
  const { mirrorLatestSession } = await import('../src/mirror/index.js');
  await mirrorLatestSession({ workspacePath: '/tmp/project', source: 'codex' });
  expect(mocked.mirror).toHaveBeenCalledOnce();
});

it('skips a verified persistent mirror with identical content', async () => {
  fs.mkdirSync(path.join(directory, 'agy', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'agy', 'conversations', 'old-target.db'), '');
  const { mirrorLatestSession } = await import('../src/mirror/index.js');
  const result = await mirrorLatestSession({ workspacePath: '/tmp/project', source: 'codex' });
  expect(result.skipped).toBe(true);
  expect(mocked.mirror).not.toHaveBeenCalled();
});

it('selects the user conversation even when a child agent was updated more recently', async () => {
  const db = new Database(mocked.db);
  const original = db.prepare('SELECT * FROM threads WHERE id = ?').get('source') as any;
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)').run(
    'child', '', null, original.rollout_path, Date.now() + 10000, Date.now(), '/tmp/project', 'explorer');
  db.close();
  const { mirrorLatestSession } = await import('../src/mirror/index.js');
  await mirrorLatestSession({ workspacePath: '/tmp/project', source: 'codex' });
  expect(mocked.extract.mock.calls[0][1]).toBe('source');
});
