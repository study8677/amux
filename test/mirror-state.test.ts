import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amux-state-tests-'));
afterEach(() => vi.unstubAllEnvs());

it('retains legacy JSON and notices edits from another process', async () => {
  vi.resetModules();
  const home = path.join(directory, 'legacy');
  fs.mkdirSync(home);
  vi.stubEnv('AMUX_HOME', home);
  fs.writeFileSync(path.join(home, 'mirror-state.json'), JSON.stringify({
    mirroredTargets: { old: { agent: 'codex', sourceId: 'old-source', turnCount: 1, createdAt: 1 } },
    sourceSyncMap: { 'old-source': { targetAgent: 'codex', targetSessionId: 'old', turnCount: 1, updatedAt: 1 } },
  }));
  const state = await import('../src/mirror/state.js');
  expect(state.isMirrorTarget('old')).toBe(true);
  state.recordMirrorTarget('new', 'antigravity', 'new-source', 2, { nativeStorageVersion: 2 });
  expect(state.getLastSync('old-source')?.targetSessionId).toBe('old');
  const edited = JSON.parse(fs.readFileSync(path.join(home, 'mirror-state.json'), 'utf8'));
  edited.mirroredTargets.external = { agent: 'codex', sourceId: 'external-source', turnCount: 1, createdAt: 1 };
  fs.writeFileSync(path.join(home, 'mirror-state.json'), JSON.stringify(edited));
  expect(state.isMirrorTarget('external')).toBe(true);
});

it('fingerprints detect same-length conversation edits', async () => {
  vi.resetModules();
  const { sessionFingerprint } = await import('../src/mirror/state.js');
  const session = { sourceAgent: 'codex' as const, targetAgent: 'antigravity' as const,
    sourceSessionId: 's', workspacePath: '/tmp', title: 't', turns: [{ role: 'user' as const, text: 'first', timestamp: 1 }] };
  expect(sessionFingerprint(session)).not.toBe(sessionFingerprint({ ...session, turns: [{ ...session.turns[0], text: 'edited' }] }));
  expect(sessionFingerprint(session)).toBe(sessionFingerprint({ ...session, turns: [{ ...session.turns[0], timestamp: 2 }] }));
});

it('merges concurrent process writes without losing targets', async () => {
  const home = path.join(directory, 'concurrent');
  const modulePath = new URL('../src/mirror/state.ts', import.meta.url).href;
  await Promise.all(Array.from({ length: 5 }, (_, index) => new Promise<void>((resolve, reject) => {
    const script = `import { recordMirrorTarget } from ${JSON.stringify(modulePath)}; recordMirrorTarget('target-${index}', 'codex', 'source-${index}', 2);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, AMUX_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(error)));
  })));
  const state = JSON.parse(fs.readFileSync(path.join(home, 'mirror-state.json'), 'utf8'));
  expect(Object.keys(state.mirroredTargets)).toHaveLength(5);
  expect(Object.keys(state.sourceSyncMap)).toHaveLength(5);
});
