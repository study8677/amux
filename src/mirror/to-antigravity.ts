import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANTIGRAVITY_APP_DATA, AMUX_HOME } from '../core/paths.js';
import { findAntigravityProjectId } from './project-resolver.js';
import { recordMirrorTarget, sessionFingerprint } from './state.js';
import { antigravityRequest } from './antigravity-api.js';
import { prepareNativeImport, validateNativeStorageFormat } from './antigravity-storage.js';
import type { MirrorResult, MirrorSession } from './types.js';

export async function mirrorToAntigravity(session: MirrorSession): Promise<MirrorResult> {
  const requestedId = crypto.randomUUID();
  const projectId = findAntigravityProjectId(session.workspacePath) ?? '';
  const workspaceUri = pathToFileURL(session.workspacePath).href;
  const title = session.title.includes('[来自 Codex]') ? session.title : `${session.title} [来自 Codex]`;
  const templateId = crypto.randomUUID();
  const directory = path.join(AMUX_HOME, 'imports');
  fs.mkdirSync(directory, { recursive: true });
  let id = requestedId;
  try {
    // A native empty conversation uses the persistent SQLite store. Inline trajectory
    // imports select an in-memory store, which loses later replies after restart.
    await antigravityRequest('StartCascade', {
      cascadeId: templateId, source: 1, trajectoryType: 4, workspaceUris: [workspaceUri],
      ...(projectId ? { projectEnvConfig: { projectId } } : {}),
    });
    validateNativeStorageFormat(templateId);
    const importPath = await prepareNativeImport(templateId, requestedId, session, directory);
    const result = await antigravityRequest('LoadSharedTrajectory', { path: importPath });
    id = result.cascadeId;
    if (id !== requestedId) throw new Error('Antigravity 原生导入会话 ID 不匹配');
    const readback = await antigravityRequest('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
    await antigravityRequest('UpdateConversationAnnotations', { cascadeId: id, annotations: { title }, mergeAnnotations: true });
    const actual = [...(readback.trajectory?.steps ?? [])];
    while (actual.length < (readback.numTotalSteps ?? 0)) {
      const page = await antigravityRequest('GetCascadeTrajectorySteps', { cascadeId: id, trajectoryVerbosity: 3, stepOffset: actual.length });
      if (!page.steps?.length) break;
      actual.push(...page.steps);
    }
    const matches = actual.length === session.turns.length && actual.every((step: any, i: number) =>
      (session.turns[i].role === 'user'
        ? step.userInput?.userResponse === session.turns[i].text && step.userInput?.items?.map((item: any) => item.text ?? '').join('') === session.turns[i].text
        : step.plannerResponse?.response === session.turns[i].text));
    if (!matches) throw new Error('Antigravity 原生读回的轮数或内容不匹配');
    if (projectId && readback.trajectory?.metadata?.projectId !== projectId) {
      throw new Error('Antigravity 原生项目绑定读回不匹配');
    }
    await antigravityRequest('LoadTrajectory', { cascadeId: id });
    const persistedReadback = await antigravityRequest('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
    if (persistedReadback.numTotalSteps !== session.turns.length) throw new Error('Antigravity 存盘后原生轮数不匹配');
    const history = await antigravityRequest('GetAllCascadeTrajectories', { excludeSubtrajectories: true });
    if (!history.trajectorySummaries?.[id]) throw new Error('Antigravity 原生历史列表未找到导入会话');
    const brainDir = path.join(ANTIGRAVITY_APP_DATA, 'brain', id);
    const logsDir = path.join(brainDir, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), session.turns.map((turn, index) => JSON.stringify({
      step_index: index, type: turn.role === 'user' ? 'USER_INPUT' : 'PLANNER_RESPONSE',
      created_at: new Date(turn.timestamp || Date.now()).toISOString(), content: turn.text,
    })).join('\n') + '\n');
    recordMirrorTarget(id, 'antigravity', session.sourceSessionId, session.turns.length, {
      fingerprint: sessionFingerprint(session), nativeReadbackVerifiedAt: Date.now(), nativeStorageVersion: 2,
    });
    return { targetAgent: 'antigravity', targetSessionId: id, sourceSessionId: session.sourceSessionId,
      title, turnCount: session.turns.length, workspacePath: session.workspacePath, nativeReadbackVerified: true };
  } catch (error) {
    try {
      await antigravityRequest('DeleteCascadeTrajectory', { cascadeId: requestedId });
      fs.rmSync(path.join(directory, `${requestedId}.db`), { force: true });
    } catch { /* Retain backing storage when native cleanup is unavailable. */ }
    throw error;
  } finally {
    await antigravityRequest('DeleteCascadeTrajectory', { cascadeId: templateId }).catch(() => {});
  }
}
