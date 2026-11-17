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
  codexProjectsList: vi.fn(),
  codexProjectDelete: vi.fn(),
  codexProjectCreate: vi.fn(),
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
  listAllProjects: (...args: any[]) => mocks.codexProjectsList(...args),
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
let wsDir = '';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amux-hard-bugs-'));
  amuxHome = path.join(rootDir, 'amux');
  agyHome = path.join(rootDir, 'agy');
  codexHome = path.join(rootDir, 'codex');
  wsDir = path.join(rootDir, 'workspace');
  fs.mkdirSync(amuxHome, { recursive: true });
  fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(agyHome, 'projects'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  wsDir = fs.realpathSync.native(wsDir).normalize('NFC');

  vi.stubEnv('AMUX_HOME', amuxHome);
  vi.stubEnv('AMUX_AGY_HOME', agyHome);
  vi.stubEnv('AMUX_AGY_PROJECTS_DIR', path.join(agyHome, 'projects'));
  vi.stubEnv('AMUX_AGY_MCP_CONFIG', path.join(agyHome, 'mcp_config.json'));
  vi.stubEnv('AMUX_AGY_GLOBAL_RULES', path.join(agyHome, 'GEMINI.md'));
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('AMUX_CODEX_GLOBAL_RULES', path.join(codexHome, 'AGENTS.md'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function writeCodexRollout(
  filePath: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string; phase?: string }>,
  extraItems: any[] = []
) {
  const lines: any[] = [
    { type: 'session_meta', payload: { id: path.basename(filePath, '.jsonl'), cwd: wsDir } },
    ...turns.map((t) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role: t.role,
        ...(t.phase ? { phase: t.phase } : {}),
        content: [{ type: t.role === 'user' ? 'input_text' : 'output_text', text: t.text }],
      },
    })),
    ...extraItems,
  ];
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('Hard Bug Regressions', () => {
  it('Bug 1: mirrors back user-continued mirrored sessions on both Codex and Antigravity without stacking tags or ping-ponging', async () => {
    const trajectories = new Map<string, Array<{ role: 'user' | 'assistant'; text: string }>>();
    let codexSeq = 0;
    const codexThreads = new Map<string, { path: string; archived: boolean }>();

    mocks.prepareImport.mockImplementation(async (_templateId, id, session, dir) => {
      trajectories.set(id, session.turns.map((t: any) => ({ role: t.role, text: t.text })));
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
      return {};
    });

    mocks.codexRequest.mockImplementation(async (method: string, params: any) => {
      if (method === 'thread/start') {
        const id = `codex-mirrored-${++codexSeq}`;
        const rollout = path.join(codexHome, `${id}.jsonl`);
        writeCodexRollout(rollout, []);
        codexThreads.set(id, { path: rollout, archived: false });
        return { thread: { id } };
      }
      if (method === 'thread/name/set') return {};
      if (method === 'thread/inject_items') {
        const info = codexThreads.get(params.threadId)!;
        writeCodexRollout(
          info.path,
          params.items.map((i: any) => ({ role: i.role, text: i.content[0].text }))
        );
        return {};
      }
      if (method === 'thread/read') {
        const info = codexThreads.get(params.threadId);
        return { thread: { id: params.threadId, path: info?.path, archived: info?.archived ?? false } };
      }
      if (method === 'thread/archive') {
        const info = codexThreads.get(params.threadId);
        if (info) info.archived = true;
        return {};
      }
      return {};
    });

    // Seed original Antigravity conversation -> mirror to Codex
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
    const encodedUri = JSON.stringify([pathToFileURL(wsDir).href]);
    const origAgyDir = path.join(agyHome, 'brain', 'agy-origin', '.system_generated', 'logs');
    fs.mkdirSync(origAgyDir, { recursive: true });
    fs.writeFileSync(
      path.join(origAgyDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-12T00:00:00Z', content: '第一步需求' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-12T00:01:00Z', content: '已完成第一步' }),
      ].join('\n') + '\n'
    );
    agyDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)')
      .run('agy-origin', '多行\n功能开发', encodedUri, '2026-11-12 00:01:00.000000+00:00', '', 0);

    const { mirrorLatestSession, EmptyMirrorSessionError } = await import('../src/mirror/index.js');
    const { shouldSkipMirroredSession } = await import('../src/mirror/dedup.js');

    const toCodex = await mirrorLatestSession({ workspacePath: wsDir, source: 'antigravity' });
    expect(toCodex.title).toBe('多行 功能开发 [来自 Antigravity]');

    // Register mirrored Codex session in state_5.sqlite
    const codexInfo = codexThreads.get(toCodex.targetSessionId)!;
    const codexDb = new Database(path.join(codexHome, 'state_5.sqlite'));
    codexDb.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, rollout_path TEXT, updated_at_ms INTEGER, created_at_ms INTEGER, cwd TEXT, archived INTEGER, agent_role TEXT)'
    );
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)')
      .run(toCodex.targetSessionId, toCodex.title, toCodex.title, codexInfo.path, Date.now(), 1, wsDir);

    // 1) Untouched mirrored Codex session MUST be skipped (no loopback!)
    expect(shouldSkipMirroredSession('codex', toCodex.targetSessionId, toCodex.title, codexInfo.path)).toBe(true);
    await expect(mirrorLatestSession({ workspacePath: wsDir, source: 'codex' })).rejects.toThrow(/未找到 Codex 在工作区/);

    // 2) User continues inside the `[来自 Antigravity]` Codex session!
    writeCodexRollout(
      codexInfo.path,
      [
        { role: 'user', text: '第一步需求' },
        { role: 'assistant', text: '已完成第一步' },
        { role: 'user', text: '在 Codex 里继续第二步' },
        { role: 'assistant', text: 'Codex 已完成第二步' },
      ],
      [{ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }]
    );
    codexDb.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?').run(Date.now() + 5000, toCodex.targetSessionId);

    expect(shouldSkipMirroredSession('codex', toCodex.targetSessionId, toCodex.title, codexInfo.path)).toBe(false);
    const backToAgy = await mirrorLatestSession({ workspacePath: wsDir, source: 'codex' });
    expect(backToAgy.skipped).toBeFalsy();
    expect(backToAgy.sourceSessionId).toBe(toCodex.targetSessionId);
    expect(backToAgy.turnCount).toBe(4);
    // Title replaces `[来自 Antigravity]` cleanly instead of stacking `[来自 Antigravity] [来自 Codex]`
    expect(backToAgy.title).toBe('多行 功能开发 [来自 Codex]');

    // Subsequent run without further edits skips cleanly (no ping-pong)
    const repeatBackToAgy = await mirrorLatestSession({ workspacePath: wsDir, source: 'codex' });
    expect(repeatBackToAgy.skipped).toBe(true);

    // 3) Now register the `[来自 Codex]` Antigravity target and verify untouched -> skip, continued -> mirrors back!
    const mirroredAgyTranscript = path.join(agyHome, 'brain', backToAgy.targetSessionId, '.system_generated', 'logs', 'transcript.jsonl');
    expect(fs.existsSync(mirroredAgyTranscript)).toBe(true);
    expect(
      fs.existsSync(path.join(agyHome, 'brain', backToAgy.targetSessionId, '.system_generated', 'logs', 'transcript_full.jsonl'))
    ).toBe(true);

    agyDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)')
      .run(backToAgy.targetSessionId, backToAgy.title, encodedUri, '2026-11-12 01:00:00.000000+00:00', '', 0);

    expect(shouldSkipMirroredSession('antigravity', backToAgy.targetSessionId, backToAgy.title, mirroredAgyTranscript)).toBe(true);

    // Simulate real Antigravity continuation (`source: "USER_EXPLICIT"` + `"MODEL"`)
    fs.appendFileSync(
      mirroredAgyTranscript,
      [
        JSON.stringify({
          step_index: 4,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-11-12T02:00:00Z',
          content: '<USER_REQUEST>\n回到 Antigravity 继续第三步\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 5,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-12T02:01:00Z',
          content: 'Antigravity 已完成第三步',
        }),
      ].join('\n') + '\n'
    );
    agyDb
      .prepare('UPDATE conversation_summaries SET last_modified_time = ? WHERE conversation_id = ?')
      .run('2026-11-12 02:01:00.000000+00:00', backToAgy.targetSessionId);

    expect(shouldSkipMirroredSession('antigravity', backToAgy.targetSessionId, backToAgy.title, mirroredAgyTranscript)).toBe(false);
    const backToCodexAgain = await mirrorLatestSession({ workspacePath: wsDir, source: 'antigravity' });
    expect(backToCodexAgain.skipped).toBeFalsy();
    expect(backToCodexAgain.sourceSessionId).toBe(backToAgy.targetSessionId);
    expect(backToCodexAgain.turnCount).toBe(6);
    expect(backToCodexAgain.title).toBe('多行 功能开发 [来自 Antigravity]');
    expect(EmptyMirrorSessionError).toBeDefined();

    agyDb.close();
    codexDb.close();
  });

  it('Bug 2: hydrates truncated steps from transcript_full.jsonl by step_index and decodes JSON-escaped tool file paths', async () => {
    const convId = 'agy-truncated-conv';
    const logsDir = path.join(agyHome, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const fullUserPrompt = '完整长需求：' + 'A'.repeat(600);
    const fullPlanText = '完整长架构方案：' + 'B'.repeat(800);

    // Compact transcript has 3 steps (imagine step 0 was pre-seeded before transcript_full existed, so line counts differ!)
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-12T00:00:00Z',
          content: '初始短问题',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-12T00:01:00Z',
          content: '完整长架构方案：BBB...[truncated]',
          truncated_fields: ['content', 'tool_calls'],
          tool_calls: [{ name: 'edit_file', arguments: '{"Path": "/tmp/trunc...' }],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'USER_INPUT',
          created_at: '2026-11-12T00:02:00Z',
          content: '<USER_REQUEST>\n完整长需求：AAA...[truncated]',
          truncated_fields: ['content'],
        }),
      ].join('\n') + '\n'
    );

    // transcript_full.jsonl only has steps 1 and 2 (different line indices than transcript.jsonl!)
    fs.writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-12T00:01:00Z',
          content: fullPlanText,
          tool_calls: [
            {
              name: 'edit_file',
              args: { Path: JSON.stringify('/Users/test/中文 目录/app.ts'), Target: '"a"', Replacement: '"b"' },
            },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'USER_INPUT',
          created_at: '2026-11-12T00:02:00Z',
          content: `<USER_REQUEST>\n${fullUserPrompt}\n</USER_REQUEST>`,
        }),
      ].join('\n') + '\n'
    );

    const { extractAntigravitySession } = await import('../src/mirror/extract-antigravity.js');
    const session = (await extractAntigravitySession(
      path.join(logsDir, 'transcript.jsonl'),
      convId,
      wsDir,
      'Truncation Test'
    ))!;

    expect(session.turns).toHaveLength(3);
    expect(session.turns[1].text).toContain(fullPlanText);
    expect(session.turns[1].text).toContain('`/Users/test/中文 目录/app.ts`');
    expect(session.turns[1].text).not.toContain('[truncated]');
    expect(session.turns[2].text).toBe(fullUserPrompt);
  });

  it('Bug 3a: preserves registry entry when delete action fails in syncProjects so deleted project is not resurrected next tick', async () => {
    const projRoot = path.join(rootDir, 'proj-delete-safety');
    fs.mkdirSync(projRoot, { recursive: true });
    const realProjRoot = fs.realpathSync.native(projRoot).normalize('NFC');

    // Antigravity has a SECOND healthy project so Antigravity is NOT treated as empty/unreliable when proj-delete-safety is deleted!
    const keepRoot = path.join(rootDir, 'proj-keep');
    fs.mkdirSync(keepRoot, { recursive: true });
    const realKeepRoot = fs.realpathSync.native(keepRoot).normalize('NFC');

    const writeAgyProject = (id: string, name: string, folderPath: string) => {
      fs.writeFileSync(
        path.join(agyHome, 'projects', `${id}.json`),
        JSON.stringify({
          id,
          name,
          projectResources: { resources: [{ folderUri: pathToFileURL(folderPath).href }] },
        })
      );
    };
    writeAgyProject('agy-keep', 'keep', realKeepRoot);
    writeAgyProject('agy-del', 'del-me', realProjRoot);

    const codexLive = new Map<string, { id: string; name: string; roots: string[] }>([
      ['cx-keep', { id: 'cx-keep', name: 'keep', roots: [realKeepRoot] }],
      ['cx-del', { id: 'cx-del', name: 'del-me', roots: [realProjRoot] }],
    ]);
    mocks.codexProjectsList.mockImplementation(async () => [...codexLive.values()]);

    let failCodexDelete = true;
    mocks.codexRequest.mockImplementation(async (method: string, params: any) => {
      if (method === 'project/delete' || method === 'workspace/delete') {
        if (failCodexDelete) throw new Error('codex app-server temporarily busy');
        codexLive.delete(params.id ?? params.projectId);
        return {};
      }
      return {};
    });

    // Mock Codex harness project store delete directly via registry if needed; check how CodexAdapter deletes projects
    const { getHarnesses } = await import('../src/harness/registry.js');
    const codexHarness = getHarnesses().find((h) => h.id === 'codex')!;
    const origProjects = codexHarness.projects!;
    vi.spyOn(origProjects, 'list').mockImplementation(async () =>
      [...codexLive.values()].map((p) => ({ harness: 'codex', id: p.id, name: p.name, roots: p.roots }))
    );
    vi.spyOn(origProjects, 'delete').mockImplementation(async (id: string) => {
      if (failCodexDelete) throw new Error('codex app-server temporarily busy');
      codexLive.delete(id);
    });
    const agyHarness = getHarnesses().find((h) => h.id === 'antigravity')!;
    const agyCreateSpy = vi.spyOn(agyHarness.projects!, 'create');

    const { syncProjects, loadRegistry } = await import('../src/projects/sync.js');

    // Step 1: Initial baseline sync records both projects in registry.json
    await syncProjects({ apply: true });
    expect(loadRegistry().projects).toHaveLength(2);

    // Step 2: User deletes `agy-del` in Antigravity; Codex delete fails transiently on tick 1
    fs.unlinkSync(path.join(agyHome, 'projects', 'agy-del.json'));
    const tick1 = await syncProjects({ apply: true });
    expect(tick1.applied.some((a) => a.action.type === 'delete' && !a.ok)).toBe(true);
    // Registry MUST still remember `del-me`!
    expect(loadRegistry().projects.some((p) => p.name === 'del-me')).toBe(true);

    // Step 3: Next tick succeeds in deleting from Codex instead of resurrecting `del-me` into Antigravity!
    failCodexDelete = false;
    const tick2 = await syncProjects({ apply: true });
    expect(agyCreateSpy).not.toHaveBeenCalled();
    expect(tick2.applied.some((a) => a.action.type === 'delete' && a.ok)).toBe(true);
    expect(codexLive.has('cx-del')).toBe(false);
    expect(loadRegistry().projects.some((p) => p.name === 'del-me')).toBe(false);
  });

  it('Bug 3b: marks Antigravity unreliable when a project JSON file is corrupt so zero false deletes propagate to Codex', async () => {
    const keepRoot = path.join(rootDir, 'proj-1');
    const corruptRoot = path.join(rootDir, 'proj-2');
    fs.mkdirSync(keepRoot, { recursive: true });
    fs.mkdirSync(corruptRoot, { recursive: true });
    const r1 = fs.realpathSync.native(keepRoot).normalize('NFC');
    const r2 = fs.realpathSync.native(corruptRoot).normalize('NFC');

    fs.writeFileSync(
      path.join(agyHome, 'projects', 'a1.json'),
      JSON.stringify({ id: 'a1', name: 'p1', projectResources: { resources: [{ workspaceRoot: { folderUri: pathToFileURL(r1).href } }] } })
    );
    fs.writeFileSync(
      path.join(agyHome, 'projects', 'a2.json'),
      JSON.stringify({ id: 'a2', name: 'p2', projectResources: { resources: [{ folderUri: pathToFileURL(r2).href }] } })
    );

    const { getHarnesses } = await import('../src/harness/registry.js');
    const codexHarness = getHarnesses().find((h) => h.id === 'codex')!;
    vi.spyOn(codexHarness.projects!, 'list').mockResolvedValue([
      { harness: 'codex', id: 'c1', name: 'p1', roots: [r1] },
      { harness: 'codex', id: 'c2', name: 'p2', roots: [r2] },
    ]);
    const codexDeleteSpy = vi.spyOn(codexHarness.projects!, 'delete').mockResolvedValue(undefined);

    const { syncProjects } = await import('../src/projects/sync.js');
    await syncProjects({ apply: true });

    // Corrupt `a2.json` mid-write (while `a1.json` is still valid — previously silently swallowed and treated as user deletion!)
    fs.writeFileSync(path.join(agyHome, 'projects', 'a2.json'), '{"id": "a2", "name": ');

    const res = await syncProjects({ apply: true });
    expect(codexDeleteSpy).not.toHaveBeenCalled();
    expect(res.plan.actions.filter((a) => a.type === 'delete')).toHaveLength(0);
  });

  it('Bug 4, 5 & 7: filters Codex commentary chatter, skips 0-turn blank top tab, and falls back to thread_history_1.sqlite when rollout is pruned', async () => {
    const trajectories = new Map<string, any>();
    mocks.prepareImport.mockImplementation(async (_templateId, id, session, dir) => {
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

    // Blank newest tab (0 extractable turns) + older session whose rollout.jsonl was pruned from disk (only in thread_history_1.sqlite!)
    const blankRollout = path.join(codexHome, 'blank-tab.jsonl');
    writeCodexRollout(blankRollout, []);
    const missingRollout = path.join(codexHome, 'pruned-rollout.jsonl');

    const codexDb = new Database(path.join(codexHome, 'state_5.sqlite'));
    codexDb.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, rollout_path TEXT, updated_at_ms INTEGER, created_at_ms INTEGER, cwd TEXT, archived INTEGER, agent_role TEXT)'
    );
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)')
      .run('blank-newest', 'New Chat', 'New Chat', blankRollout, 2000, 2, wsDir);
    codexDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)')
      .run('sqlite-backed', 'Pruned Rollout Session', 'Pruned Rollout Session', missingRollout, 1000, 1, wsDir);
    codexDb.close();

    const histDb = new Database(path.join(codexHome, 'thread_history_1.sqlite'));
    histDb.exec(
      'CREATE TABLE thread_items (thread_id TEXT, item_type TEXT, item_json TEXT, created_at_ms INTEGER, rollout_ordinal INTEGER)'
    );
    const insertItem = histDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)');
    insertItem.run(
      'sqlite-backed',
      'userMessage',
      JSON.stringify({ content: [{ type: 'input_text', text: '帮我查一下历史问题' }] }),
      1001,
      1
    );
    insertItem.run(
      'sqlite-backed',
      'agentMessage',
      JSON.stringify({
        phase: 'commentary',
        content: [{ type: 'output_text', text: '我先运行命令看看日志……（中间过程，不应进入正式回复）' }],
      }),
      1002,
      2
    );
    insertItem.run(
      'sqlite-backed',
      'agentMessage',
      JSON.stringify({
        phase: 'final_answer',
        content: [{ type: 'output_text', text: '定位到了，原因是连接池超时。' }],
      }),
      1003,
      3
    );
    histDb.close();

    const { mirrorLatestSession } = await import('../src/mirror/index.js');
    const res = await mirrorLatestSession({ workspacePath: wsDir, source: 'codex' });

    expect(res.sourceSessionId).toBe('sqlite-backed');
    expect(res.turnCount).toBe(2);
    const syncedTurns = trajectories.get(res.targetSessionId);
    expect(syncedTurns).toHaveLength(2);
    expect(syncedTurns[1].text).toBe('定位到了，原因是连接池超时。');
    expect(syncedTurns[1].text).not.toContain('中间过程');
  });

  it('Bug 6: resolveWorkspace(undefined) resolves nested subdirectories up to git/amux/registered project root', async () => {
    const gitRepo = path.join(rootDir, 'git-repo');
    const nestedDir = path.join(gitRepo, 'packages', 'web', 'src');
    fs.mkdirSync(path.join(gitRepo, '.git'), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });
    const realGitRepo = fs.realpathSync.native(gitRepo).normalize('NFC');

    const prevCwd = process.cwd();
    try {
      process.chdir(nestedDir);
      const { resolveWorkspace } = await import('../src/core/paths.js');
      expect(resolveWorkspace(undefined)).toBe(realGitRepo);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
