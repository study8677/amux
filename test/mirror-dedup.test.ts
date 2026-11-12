import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agyRequest: vi.fn(),
  prepareImport: vi.fn(),
  validateStorage: vi.fn(),
  codexStart: vi.fn(),
  codexStop: vi.fn(),
  codexRequest: vi.fn(),
}));

vi.mock('../src/mirror/antigravity-api.js', () => ({
  antigravityRequest: mocks.agyRequest,
}));
vi.mock('../src/mirror/antigravity-storage.js', () => ({
  prepareNativeImport: mocks.prepareImport,
  validateNativeStorageFormat: mocks.validateStorage,
}));
vi.mock('../src/mirror/project-resolver.js', () => ({
  findAntigravityProjectId: () => 'proj-agy',
  findCodexProjectId: () => 'proj-codex',
}));
vi.mock('../src/harness/codex/appserver.js', () => ({
  findCodexBin: () => 'codex',
  listAllProjects: async () => [],
  CodexAppServerClient: class {
    async start() {
      return mocks.codexStart();
    }
    async stop() {
      return mocks.codexStop();
    }
    async request(method: string, params: any) {
      return mocks.codexRequest(method, params);
    }
  },
}));

let rootDir = '';
let amuxHome = '';
let agyHome = '';
let codexHome = '';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amux-dedup-tests-'));
  amuxHome = path.join(rootDir, 'amux');
  agyHome = path.join(rootDir, 'agy');
  codexHome = path.join(rootDir, 'codex');
  fs.mkdirSync(amuxHome, { recursive: true });
  fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  vi.stubEnv('AMUX_HOME', amuxHome);
  vi.stubEnv('AMUX_AGY_HOME', agyHome);
  vi.stubEnv('CODEX_HOME', codexHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function writeCodexRollout(
  filePath: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  extraItems: any[] = []
) {
  const lines: any[] = [
    { type: 'session_meta', payload: { id: path.basename(filePath, '.jsonl'), cwd: '/tmp/ws' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# AGENTS.md instructions for /tmp/ws\n\n<INSTRUCTIONS>\nFollow repo rules.\n</INSTRUCTIONS>',
          },
        ],
      },
    },
    { type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    ...turns.map((t) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role: t.role,
        content: [{ type: t.role === 'user' ? 'input_text' : 'output_text', text: t.text }],
      },
    })),
    ...extraItems,
  ];
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('duplicate mirror prevention & cleanup', () => {
  it('deletes untouched prior Antigravity mirror target when re-mirroring updated turns', async () => {
    const trajectories = new Map<string, Array<{ role: 'user' | 'assistant'; text: string }>>();
    const deletedIds: string[] = [];

    mocks.prepareImport.mockImplementation(async (_templateId, id, session, dir) => {
      trajectories.set(id, session.turns.map((t: any) => ({ role: t.role, text: t.text })));
      const dbPath = path.join(dir, `${id}.db`);
      fs.writeFileSync(dbPath, 'sqlite');
      fs.symlinkSync(dbPath, path.join(agyHome, 'conversations', `${id}.db`));
      return dbPath;
    });

    mocks.agyRequest.mockImplementation(async (method: string, body: any) => {
      if (method === 'StartCascade') return { cascadeId: body.cascadeId };
      if (method === 'LoadSharedTrajectory') {
        const id = path.basename(body.path, '.db');
        return { cascadeId: id };
      }
      if (method === 'GetCascadeTrajectory') {
        const turns = trajectories.get(body.cascadeId);
        if (!turns) throw new Error('Antigravity GetCascadeTrajectory HTTP 404');
        return {
          numTotalSteps: turns.length,
          trajectory: {
            metadata: { projectId: 'proj-agy' },
            steps: turns.map((t) =>
              t.role === 'user'
                ? { userInput: { userResponse: t.text, items: [{ text: t.text }] } }
                : { plannerResponse: { response: t.text } }
            ),
          },
        };
      }
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: Object.fromEntries([...trajectories.keys()].map((id) => [id, {}])),
        };
      }
      if (method === 'DeleteCascadeTrajectory') {
        if (trajectories.has(body.cascadeId)) {
          deletedIds.push(body.cascadeId);
          trajectories.delete(body.cascadeId);
        }
        return {};
      }
      return {};
    });

    const { mirrorToAntigravity } = await import('../src/mirror/to-antigravity.js');
    const state = await import('../src/mirror/state.js');

    const first = await mirrorToAntigravity({
      sourceAgent: 'codex',
      targetAgent: 'antigravity',
      sourceSessionId: 'codex-src-1',
      workspacePath: '/tmp/ws',
      title: 'Review implementation plan',
      turns: [
        { role: 'user', text: 'review plan', timestamp: 1 },
        { role: 'assistant', text: 'looks good', timestamp: 2 },
      ],
    });

    expect(trajectories.size).toBe(1);
    expect(fs.existsSync(path.join(amuxHome, 'imports', `${first.targetSessionId}.db`))).toBe(true);

    const second = await mirrorToAntigravity({
      sourceAgent: 'codex',
      targetAgent: 'antigravity',
      sourceSessionId: 'codex-src-1',
      workspacePath: '/tmp/ws',
      title: 'Review implementation plan',
      turns: [
        { role: 'user', text: 'review plan', timestamp: 1 },
        { role: 'assistant', text: 'looks good', timestamp: 2 },
        { role: 'user', text: 'apply fix', timestamp: 3 },
        { role: 'assistant', text: 'done', timestamp: 4 },
      ],
    });

    // Only the latest session remains active; the first snapshot was deleted cleanly
    expect(deletedIds).toContain(first.targetSessionId);
    expect([...trajectories.keys()]).toEqual([second.targetSessionId]);
    expect(fs.existsSync(path.join(amuxHome, 'imports', `${first.targetSessionId}.db`))).toBe(false);
    expect(state.isMirrorTarget(first.targetSessionId)).toBe(true);
    expect(state.getPriorMirrorTargets('codex-src-1', 'antigravity', second.targetSessionId)).toHaveLength(0);
  });

  it('preserves prior Antigravity mirror target when user continued chatting in it', async () => {
    const trajectories = new Map<string, Array<{ role: 'user' | 'assistant'; text: string }>>();
    const deletedIds: string[] = [];

    mocks.prepareImport.mockImplementation(async (_templateId, id, session, dir) => {
      trajectories.set(id, session.turns.map((t: any) => ({ role: t.role, text: t.text })));
      const dbPath = path.join(dir, `${id}.db`);
      fs.writeFileSync(dbPath, 'sqlite');
      return dbPath;
    });

    mocks.agyRequest.mockImplementation(async (method: string, body: any) => {
      if (method === 'StartCascade') return { cascadeId: body.cascadeId };
      if (method === 'LoadSharedTrajectory') return { cascadeId: path.basename(body.path, '.db') };
      if (method === 'GetCascadeTrajectory') {
        const turns = trajectories.get(body.cascadeId) ?? [];
        return {
          numTotalSteps: turns.length,
          trajectory: {
            metadata: { projectId: 'proj-agy' },
            steps: turns.map((t) =>
              t.role === 'user'
                ? { userInput: { userResponse: t.text, items: [{ text: t.text }] } }
                : { plannerResponse: { response: t.text } }
            ),
          },
        };
      }
      if (method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: Object.fromEntries([...trajectories.keys()].map((id) => [id, {}])) };
      }
      if (method === 'DeleteCascadeTrajectory') {
        if (trajectories.has(body.cascadeId)) deletedIds.push(body.cascadeId);
        return {};
      }
      return {};
    });

    const { mirrorToAntigravity } = await import('../src/mirror/to-antigravity.js');
    const first = await mirrorToAntigravity({
      sourceAgent: 'codex',
      targetAgent: 'antigravity',
      sourceSessionId: 'codex-src-2',
      workspacePath: '/tmp/ws',
      title: 'Feature Plan',
      turns: [{ role: 'user', text: 'hello', timestamp: 1 }],
    });

    // Simulate user continuing directly inside the mirrored Antigravity session
    trajectories.get(first.targetSessionId)!.push(
      { role: 'user', text: 'user follow-up in antigravity' },
      { role: 'assistant', text: 'antigravity reply' }
    );

    await mirrorToAntigravity({
      sourceAgent: 'codex',
      targetAgent: 'antigravity',
      sourceSessionId: 'codex-src-2',
      workspacePath: '/tmp/ws',
      title: 'Feature Plan',
      turns: [
        { role: 'user', text: 'hello', timestamp: 1 },
        { role: 'assistant', text: 'codex reply', timestamp: 2 },
      ],
    });

    expect(deletedIds).not.toContain(first.targetSessionId);
  });

  it('archives untouched prior Codex thread on re-mirror and preserves user-continued thread', async () => {
    let seq = 0;
    const threads = new Map<string, { path: string; archived: boolean }>();

    mocks.codexRequest.mockImplementation(async (method: string, params: any) => {
      if (method === 'thread/start') {
        const id = `codex-target-${++seq}`;
        const rollout = path.join(codexHome, `${id}.jsonl`);
        writeCodexRollout(rollout, []);
        threads.set(id, { path: rollout, archived: false });
        return { thread: { id } };
      }
      if (method === 'thread/name/set') return {};
      if (method === 'thread/inject_items') {
        const info = threads.get(params.threadId)!;
        const turns = params.items.map((item: any) => ({
          role: item.role,
          text: item.content[0].text,
        }));
        writeCodexRollout(info.path, turns);
        return {};
      }
      if (method === 'thread/read') {
        const info = threads.get(params.threadId);
        return { thread: { id: params.threadId, path: info?.path, archived: info?.archived ?? false } };
      }
      if (method === 'thread/archive') {
        const info = threads.get(params.threadId);
        if (info) info.archived = true;
        return {};
      }
      return {};
    });

    const { mirrorToCodex } = await import('../src/mirror/to-codex.js');

    const t1 = await mirrorToCodex({
      sourceAgent: 'antigravity',
      targetAgent: 'codex',
      sourceSessionId: 'agy-src-1',
      workspacePath: '/tmp/ws',
      title: 'Optimization',
      turns: [{ role: 'user', text: 'turn 1', timestamp: 1 }],
    });
    expect(threads.get(t1.targetSessionId)?.archived).toBe(false);

    const t2 = await mirrorToCodex({
      sourceAgent: 'antigravity',
      targetAgent: 'codex',
      sourceSessionId: 'agy-src-1',
      workspacePath: '/tmp/ws',
      title: 'Optimization',
      turns: [
        { role: 'user', text: 'turn 1', timestamp: 1 },
        { role: 'assistant', text: 'turn 2', timestamp: 2 },
      ],
    });
    expect(threads.get(t1.targetSessionId)?.archived).toBe(true);
    expect(threads.get(t2.targetSessionId)?.archived).toBe(false);

    // Simulate user continuing in t2 with a tool execution
    writeCodexRollout(
      threads.get(t2.targetSessionId)!.path,
      [
        { role: 'user', text: 'turn 1' },
        { role: 'assistant', text: 'turn 2' },
        { role: 'user', text: 'continue here' },
      ],
      [{ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }]
    );

    const t3 = await mirrorToCodex({
      sourceAgent: 'antigravity',
      targetAgent: 'codex',
      sourceSessionId: 'agy-src-1',
      workspacePath: '/tmp/ws',
      title: 'Optimization',
      turns: [
        { role: 'user', text: 'turn 1', timestamp: 1 },
        { role: 'assistant', text: 'turn 2', timestamp: 2 },
        { role: 'user', text: 'turn 3 in agy', timestamp: 3 },
      ],
    });

    expect(threads.get(t2.targetSessionId)?.archived).toBe(false);
    expect(threads.get(t3.targetSessionId)?.archived).toBe(false);
  });

  it('reconciles historical v1/v2 duplicates, subagent mirrors, and untracked identical copies', async () => {
    const state = await import('../src/mirror/state.js');
    const turns = [
      { role: 'user' as const, text: 'review plan', timestamp: 1 },
      { role: 'assistant' as const, text: 'plan reviewed', timestamp: 2 },
    ];
    const fp = state.sessionFingerprint({
      sourceAgent: 'codex',
      targetAgent: 'antigravity',
      sourceSessionId: 'src-review',
      workspacePath: '/tmp/ws',
      title: 'Review implementation plan',
      turns,
    });

    // 1. Historical v1 + v2 duplicate in mirror-state.json (the exact screenshot scenario)
    state.recordMirrorTarget('agy-old-v1', 'antigravity', 'src-review', 2, {
      fingerprint: fp,
      nativeReadbackVerifiedAt: 100,
    });
    state.recordMirrorTarget('agy-new-v2', 'antigravity', 'src-review', 2, {
      fingerprint: fp,
      nativeReadbackVerifiedAt: 200,
      nativeStorageVersion: 2,
    });

    // 2. Subagent mirror target in mirror-state.json (Codex subagent with agent_role = NULL, thread_source = 'subagent')
    state.recordMirrorTarget('agy-subagent-target', 'antigravity', 'codex-subagent-source', 2, {
      fingerprint: fp,
      nativeReadbackVerifiedAt: 300,
      nativeStorageVersion: 2,
    });

    fs.writeFileSync(path.join(agyHome, 'conversations', 'agy-new-v2.db'), 'v2');

    // Create Codex state_5.sqlite with subagent thread + untracked duplicate [来自 Antigravity] threads
    const codexDbPath = path.join(codexHome, 'state_5.sqlite');
    const rolloutKeep = path.join(codexHome, 'keep.jsonl');
    const rolloutDup = path.join(codexHome, 'dup.jsonl');
    writeCodexRollout(rolloutKeep, turns);
    writeCodexRollout(rolloutDup, turns);

    const codexDb = new Database(codexDbPath);
    codexDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        title TEXT,
        name TEXT,
        rollout_path TEXT,
        archived INTEGER,
        agent_role TEXT,
        thread_source TEXT,
        agent_path TEXT,
        source TEXT,
        updated_at_ms INTEGER,
        created_at_ms INTEGER
      );
    `);
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, 100, 1)')
      .run('codex-subagent-source', '/tmp/ws', '', null, rolloutKeep, 'subagent', '/root/worker', '{"subagent":{}}');
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, 200, 2)')
      .run('codex-untracked-dup', '/tmp/ws', '', 'Task [来自 Antigravity]', rolloutDup, 'user', 'vscode');
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, 300, 3)')
      .run('codex-tracked-keep', '/tmp/ws', '', 'Task [来自 Antigravity]', rolloutKeep, 'user', 'vscode');
    codexDb.close();

    state.recordMirrorTarget('codex-tracked-keep', 'codex', 'agy-real-source', 2, {
      fingerprint: fp,
      nativeReadbackVerifiedAt: 300,
    });

    const liveAgy = new Set(['agy-old-v1', 'agy-new-v2', 'agy-subagent-target']);
    const archivedCodex: string[] = [];

    mocks.agyRequest.mockImplementation(async (method: string, body: any) => {
      if (method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: Object.fromEntries([...liveAgy].map((id) => [id, {}])) };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          numTotalSteps: 2,
          trajectory: {
            steps: [
              { userInput: { userResponse: 'review plan', items: [{ text: 'review plan' }] } },
              { plannerResponse: { response: 'plan reviewed' } },
            ],
          },
        };
      }
      if (method === 'DeleteCascadeTrajectory') {
        liveAgy.delete(body.cascadeId);
        return {};
      }
      return {};
    });

    mocks.codexRequest.mockImplementation(async (method: string, params: any) => {
      if (method === 'thread/archive') {
        archivedCodex.push(params.threadId);
        return {};
      }
      return {};
    });

    const { reconcileMirrorDuplicates } = await import('../src/mirror/dedup.js');
    const result = await reconcileMirrorDuplicates();

    expect(result.antigravityDeleted).toBe(2);
    expect([...liveAgy]).toEqual(['agy-new-v2']);
    expect(state.getLastSync('codex-subagent-source')).toBeNull();
    expect(result.codexArchived).toBe(1);
    expect(archivedCodex).toEqual(['codex-untracked-dup']);
  });

  it('ignores Codex thread_source=subagent and Antigravity parent_conversation_id subagents and matches Unicode workspaces', async () => {
    const unicodeWorkspace = path.join(rootDir, '中文项目');
    fs.mkdirSync(unicodeWorkspace, { recursive: true });
    const realWorkspace = fs.realpathSync.native(unicodeWorkspace).normalize('NFC');

    // Antigravity DB with a newer child subagent and an older root user conversation in a Chinese path
    const agyDb = new Database(path.join(agyHome, 'conversation_summaries.db'));
    agyDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        last_modified_time TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER
      );
    `);
    const encodedUri = JSON.stringify([pathToFileURL(realWorkspace).href]);
    const writeTranscript = (id: string, userText: string) => {
      const dir = path.join(agyHome, 'brain', id, '.system_generated', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'transcript.jsonl'),
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-12T00:00:00Z', content: userText }) + '\n'
      );
    };
    writeTranscript('agy-root', 'root user prompt');
    writeTranscript('agy-child', 'subagent internal prompt');

    agyDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)')
      .run('agy-root', 'Root Conversation', encodedUri, '2026-11-12 01:00:00.000000+00:00', '', 0);
    agyDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)')
      .run('agy-child', '', encodedUri, '2026-11-12 02:00:00.000000+00:00', 'agy-root', 1);
    agyDb.close();

    // Codex DB with ONLY a subagent thread (agent_role IS NULL, thread_source = 'subagent')
    const codexDb = new Database(path.join(codexHome, 'state_5.sqlite'));
    const subRollout = path.join(codexHome, 'sub.jsonl');
    writeCodexRollout(subRollout, [{ role: 'user', text: 'subagent task' }]);
    codexDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        title TEXT,
        name TEXT,
        rollout_path TEXT,
        archived INTEGER,
        agent_role TEXT,
        thread_source TEXT,
        agent_path TEXT,
        source TEXT,
        updated_at_ms INTEGER,
        created_at_ms INTEGER
      );
    `);
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, 1)')
      .run('codex-sub', realWorkspace, '', null, subRollout, 'subagent', '/root/sub', '{"subagent":{}}', Date.now() + 99999);
    codexDb.close();

    const rolloutTarget = path.join(codexHome, 'mirrored.jsonl');
    mocks.codexRequest.mockImplementation(async (method: string, params: any) => {
      if (method === 'thread/start') return { thread: { id: 'mirrored-thread' } };
      if (method === 'thread/name/set') return {};
      if (method === 'thread/inject_items') {
        writeCodexRollout(
          rolloutTarget,
          params.items.map((i: any) => ({ role: i.role, text: i.content[0].text }))
        );
        return {};
      }
      if (method === 'thread/read') return { thread: { id: 'mirrored-thread', path: rolloutTarget, archived: false } };
      return {};
    });

    const { mirrorLatestSession } = await import('../src/mirror/index.js');
    // Auto-source selection should ignore Codex subagent AND ignore Antigravity child subagent, picking agy-root!
    const res = await mirrorLatestSession({ workspacePath: realWorkspace });
    expect(res.sourceSessionId).toBe('agy-root');
    expect(res.targetAgent).toBe('codex');
    expect(res.title).toBe('Root Conversation [来自 Antigravity]');
  });

  it('serializes concurrent mirrorLatestSession calls on the same workspace so only one session is created', async () => {
    const ws = path.join(rootDir, 'concurrent-ws');
    fs.mkdirSync(ws, { recursive: true });
    const realWs = fs.realpathSync.native(ws).normalize('NFC');

    const codexDb = new Database(path.join(codexHome, 'state_5.sqlite'));
    const rollout = path.join(codexHome, 'src.jsonl');
    writeCodexRollout(rollout, [
      { role: 'user', text: 'concurrent question' },
      { role: 'assistant', text: 'concurrent answer' },
    ]);
    codexDb.exec(
      'CREATE TABLE threads (id TEXT, title TEXT, name TEXT, rollout_path TEXT, updated_at_ms INTEGER, created_at_ms INTEGER, cwd TEXT, archived INTEGER, agent_role TEXT)'
    );
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)')
      .run('concurrent-src', 'Concurrent Test', 'Concurrent Test', rollout, Date.now(), 1, realWs);
    codexDb.close();

    let createdCount = 0;
    const trajectories = new Map<string, any>();

    mocks.prepareImport.mockImplementation(async (_templateId, id, session, dir) => {
      createdCount++;
      await new Promise((r) => setTimeout(r, 40));
      trajectories.set(id, session.turns);
      const dbPath = path.join(dir, `${id}.db`);
      fs.writeFileSync(dbPath, 'sqlite');
      fs.symlinkSync(dbPath, path.join(agyHome, 'conversations', `${id}.db`));
      return dbPath;
    });

    mocks.agyRequest.mockImplementation(async (method: string, body: any) => {
      if (method === 'StartCascade') return { cascadeId: body.cascadeId };
      if (method === 'LoadSharedTrajectory') return { cascadeId: path.basename(body.path, '.db') };
      if (method === 'GetCascadeTrajectory') {
        const turns = trajectories.get(body.cascadeId) ?? [];
        return {
          numTotalSteps: turns.length,
          trajectory: {
            metadata: { projectId: 'proj-agy' },
            steps: turns.map((t: any) =>
              t.role === 'user'
                ? { userInput: { userResponse: t.text, items: [{ text: t.text }] } }
                : { plannerResponse: { response: t.text } }
            ),
          },
        };
      }
      if (method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: Object.fromEntries([...trajectories.keys()].map((id) => [id, {}])) };
      }
      return {};
    });

    const { mirrorLatestSession } = await import('../src/mirror/index.js');
    const [r1, r2] = await Promise.all([
      mirrorLatestSession({ workspacePath: realWs, source: 'codex' }),
      mirrorLatestSession({ workspacePath: realWs, source: 'codex' }),
    ]);

    expect(createdCount).toBe(1);
    expect([Boolean(r1.skipped), Boolean(r2.skipped)].sort()).toEqual([false, true]);
    expect(r1.targetSessionId).toBe(r2.targetSessionId);
  });
});
