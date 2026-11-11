import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ request: vi.fn(), prepare: vi.fn(), validate: vi.fn(), record: vi.fn() }));
vi.mock('../src/mirror/antigravity-api.js', () => ({ antigravityRequest: api.request }));
vi.mock('../src/mirror/antigravity-storage.js', () => ({ prepareNativeImport: api.prepare, validateNativeStorageFormat: api.validate }));
vi.mock('../src/mirror/project-resolver.js', () => ({ findAntigravityProjectId: () => 'native-project' }));
vi.mock('../src/mirror/state.js', () => ({ recordMirrorTarget: api.record, sessionFingerprint: () => 'content-hash' }));

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amux-mirror-tests-'));
const session = { sourceAgent: 'codex' as const, targetAgent: 'antigravity' as const,
  sourceSessionId: 'source', workspacePath: '/tmp/project', title: '原生验收',
  turns: [{ role: 'user' as const, text: '验收短语', timestamp: 1 }, { role: 'assistant' as const, text: '已收到', timestamp: 2 }] };
let target = '';
let wrongContent = false;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('AMUX_HOME', path.join(directory, 'amux'));
  vi.stubEnv('AMUX_AGY_HOME', path.join(directory, 'agy'));
  vi.clearAllMocks();
  wrongContent = false;
  api.prepare.mockImplementation(async (_template, id, imported, dir) => {
    target = id;
    expect(imported.turns[0].text).toBe('验收短语');
    return path.join(dir, `${id}.db`);
  });
  api.request.mockImplementation(async (method, body) => {
    if (method === 'StartCascade') return { cascadeId: body.cascadeId };
    if (method === 'LoadSharedTrajectory') return { cascadeId: target };
    if (method === 'GetCascadeTrajectory') return {
      numTotalSteps: 2,
      trajectory: { metadata: { projectId: 'native-project' }, steps: [
        { userInput: { userResponse: '验收短语', items: [{ text: wrongContent ? '' : '验收短语' }] } },
        { plannerResponse: { response: '已收到' } },
      ] },
    };
    if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { [target]: {} } };
    return {};
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('native Antigravity mirror', () => {
  it('creates a persistent native template, binds the project and verifies rendered user content', async () => {
    const { mirrorToAntigravity } = await import('../src/mirror/to-antigravity.js');
    const result = await mirrorToAntigravity(session);
    const request = api.request.mock.calls.find(([method]) => method === 'StartCascade')?.[1];
    expect(request.projectEnvConfig).toEqual({ projectId: 'native-project' });
    expect(request.baseTrajectoryIdentifier).toBeUndefined();
    expect(api.request.mock.calls.some(([method]) => method === 'LoadSharedTrajectory')).toBe(true);
    expect(api.record).toHaveBeenCalledWith(target, 'antigravity', 'source', 2,
      expect.objectContaining({ nativeStorageVersion: 2, nativeReadbackVerifiedAt: expect.any(Number) }));
    expect(result.nativeReadbackVerified).toBe(true);
  });

  it('does not record success when the user bubble is empty despite a matching userResponse', async () => {
    wrongContent = true;
    const { mirrorToAntigravity } = await import('../src/mirror/to-antigravity.js');
    await expect(mirrorToAntigravity(session)).rejects.toThrow('不匹配');
    expect(api.record).not.toHaveBeenCalled();
  });
});
