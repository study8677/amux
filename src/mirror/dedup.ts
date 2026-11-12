import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { AMUX_HOME, ANTIGRAVITY_APP_DATA, ANTIGRAVITY_SUMMARIES_DB, normRoot } from '../core/paths.js';
import { CodexAppServerClient } from '../harness/codex/appserver.js';
import { findStateDb } from '../harness/codex/index.js';
import { antigravityRequest } from './antigravity-api.js';
import * as mirrorState from './state.js';
import type { CleanTurn, MirrorSession } from './types.js';

const inProcessLocks = new Map<string, Promise<unknown>>();
const STALE_LOCK_MS = 120_000;
const LOCK_TIMEOUT_MS = 60_000;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stateFn<K extends keyof typeof mirrorState>(key: K): (typeof mirrorState)[K] | undefined {
  return key in mirrorState ? mirrorState[key] : undefined;
}

function computeTurnsFingerprint(turns: CleanTurn[]): string {
  const fpFn = stateFn('sessionFingerprint');
  if (typeof fpFn === 'function') {
    const dummy: MirrorSession = {
      sourceAgent: 'codex',
      targetAgent: 'antigravity',
      workspacePath: '',
      sourceSessionId: '',
      title: '',
      turns,
    };
    return fpFn(dummy);
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(turns.map(({ role, text }) => ({ role, text }))))
    .digest('hex');
}

/**
 * Serialize mirror operations on the same workspace across both async calls in-process
 * and separate CLI / daemon processes so simultaneous triggers never create duplicate sessions.
 */
export async function withWorkspaceMirrorLock<T>(workspacePath: string, fn: () => Promise<T>): Promise<T> {
  const norm = normRoot(workspacePath);
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
  const prev = inProcessLocks.get(hash) ?? Promise.resolve();

  let releaseInProcess!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseInProcess = resolve;
  });
  inProcessLocks.set(hash, prev.then(() => current, () => current));

  await prev.catch(() => {});
  const lockDir = path.join(AMUX_HOME, 'locks');
  const lockFile = path.join(lockDir, `mirror-${hash}.lock`);
  let acquired = false;

  try {
    fs.mkdirSync(lockDir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (!acquired) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), workspacePath: norm }));
        } finally {
          fs.closeSync(fd);
        }
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let reclaim = false;
        try {
          const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number; startedAt?: number };
          const age = Date.now() - (raw.startedAt ?? 0);
          if (!raw.pid || !isPidAlive(raw.pid) || age > STALE_LOCK_MS) {
            reclaim = true;
          }
        } catch {
          reclaim = true;
        }
        if (reclaim) {
          try { fs.unlinkSync(lockFile); } catch {}
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`等待工作区镜像锁超时 (${norm})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return await fn();
  } finally {
    if (acquired) {
      try {
        const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number };
        if (raw.pid === process.pid) fs.unlinkSync(lockFile);
      } catch {}
    }
    releaseInProcess();
    if (inProcessLocks.get(hash) === current) {
      inProcessLocks.delete(hash);
    }
  }
}

/** Build SQLite WHERE predicates that exclude Codex subagent threads across schema versions */
export function codexUserThreadPredicates(columnNames: Iterable<string>): string[] {
  const cols = new Set(columnNames);
  const predicates = ['archived = 0'];
  if (cols.has('agent_role')) predicates.push('agent_role IS NULL');
  if (cols.has('thread_source')) predicates.push("(thread_source IS NULL OR thread_source != 'subagent')");
  if (cols.has('agent_path')) predicates.push('agent_path IS NULL');
  if (cols.has('attached_thread_parent_id')) predicates.push('attached_thread_parent_id IS NULL');
  if (cols.has('source')) predicates.push('(source IS NULL OR source NOT LIKE \'%"subagent"%\')');
  return predicates;
}

/** Check if a rollout session_meta payload belongs to a Codex subagent */
export function isCodexSubagentPayload(payload: any): boolean {
  if (!payload) return false;
  if (payload.agent_role || payload.agent_path || payload.attached_thread_parent_id) return true;
  if (payload.thread_source === 'subagent') return true;
  if (typeof payload.source === 'string' && payload.source.includes('"subagent"')) return true;
  if (payload.source && typeof payload.source === 'object' && 'subagent' in payload.source) return true;
  return false;
}

/** Check whether workspace_uris JSON/text matches a normalized workspace path */
export function antigravityWorkspaceMatches(workspaceUrisRaw: string | null | undefined, normWorkspace: string): boolean {
  if (!workspaceUrisRaw) return false;
  try {
    const parsed = JSON.parse(workspaceUrisRaw);
    if (Array.isArray(parsed)) {
      return parsed.some((u) => typeof u === 'string' && normRoot(u) === normWorkspace);
    }
  } catch {}
  const encoded = pathToFileURL(normWorkspace).href;
  return workspaceUrisRaw.includes(encoded) || workspaceUrisRaw.includes(`file://${normWorkspace}`);
}

function isKnownCodexSubagentThread(threadId: string): boolean {
  const stateDbPath = findStateDb();
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return false;
  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name)
      );
      const selectCols = ['id', 'agent_role', 'thread_source', 'agent_path', 'attached_thread_parent_id', 'source']
        .filter((c) => cols.has(c));
      if (selectCols.length <= 1) return false;
      const row = db.prepare(`SELECT ${selectCols.join(', ')} FROM threads WHERE id = ?`).get(threadId) as any;
      if (!row) return false;
      return isCodexSubagentPayload(row);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function isKnownAntigravitySubagentConversation(conversationId: string): boolean {
  if (!fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) return false;
  try {
    const db = new Database(ANTIGRAVITY_SUMMARIES_DB, { readonly: true, fileMustExist: true });
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>).map((c) => c.name)
      );
      if (!cols.has('parent_conversation_id') && !cols.has('nesting_depth')) return false;
      const selectCols = ['conversation_id', 'parent_conversation_id', 'nesting_depth'].filter((c) => cols.has(c));
      const row = db
        .prepare(`SELECT ${selectCols.join(', ')} FROM conversation_summaries WHERE conversation_id = ?`)
        .get(conversationId) as { parent_conversation_id?: string | null; nesting_depth?: number | null } | undefined;
      if (!row) return false;
      return Boolean((row.parent_conversation_id && row.parent_conversation_id !== '') || (row.nesting_depth ?? 0) > 0);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function extractCodexStoredState(rolloutPath: string): {
  turns: CleanTurn[];
  hasInteractiveActivity: boolean;
  fingerprint: string;
} | null {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return null;
  try {
    const turns: CleanTurn[] = [];
    let hasInteractiveActivity = false;
    const entries: any[] = [];
    for (const line of fs.readFileSync(rolloutPath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }

    // thread/start emits developer/AGENTS.md/environment_context preamble before thread_settings_applied;
    // thread/inject_items (and any subsequent real user turns) always appear after thread_settings_applied.
    const settingsIdx = entries.findIndex(
      (e) => e?.type === 'event_msg' && e?.payload?.type === 'thread_settings_applied'
    );

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === 'event_msg') {
        const evType = entry.payload?.type;
        if (evType === 'task_started' || evType === 'user_message' || evType === 'item_completed') {
          hasInteractiveActivity = true;
        }
        continue;
      }
      if (entry.type === 'response_item') {
        const pType = entry.payload?.type;
        if (
          pType === 'function_call' ||
          pType === 'custom_tool_call' ||
          pType === 'local_shell_call' ||
          pType === 'web_search_call'
        ) {
          hasInteractiveActivity = true;
          continue;
        }
        if (settingsIdx >= 0 && i <= settingsIdx) {
          continue;
        }
        if (pType === 'message' && (entry.payload?.role === 'user' || entry.payload?.role === 'assistant')) {
          const text = Array.isArray(entry.payload.content)
            ? entry.payload.content.map((part: any) => part?.text ?? '').join('')
            : '';
          if (
            settingsIdx < 0 &&
            entry.payload.role === 'user' &&
            turns.length === 0 &&
            /^(?:#\s*AGENTS\.md instructions for\b|<(?:environment_context|permissions|system_instructions|user_instructions)[\s>])/i.test(
              text.trim()
            )
          ) {
            continue;
          }
          turns.push({ role: entry.payload.role, text, timestamp: 0 });
        }
      }
    }

    return {
      turns,
      hasInteractiveActivity,
      fingerprint: turns.length > 0 ? computeTurnsFingerprint(turns) : '',
    };
  } catch {
    return null;
  }
}

async function readAntigravityStoredState(cascadeId: string): Promise<{
  exists: boolean;
  numTotalSteps: number;
  hasInteractiveActivity: boolean;
  fingerprint: string;
}> {
  let readback: any;
  try {
    readback = await antigravityRequest('GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 3 });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/HTTP (404|400|500)/.test(msg)) {
      return { exists: false, numTotalSteps: 0, hasInteractiveActivity: false, fingerprint: '' };
    }
    throw err;
  }

  const steps = [...(readback?.trajectory?.steps ?? [])];
  const total = readback?.numTotalSteps ?? steps.length;
  while (steps.length < total) {
    const page = await antigravityRequest('GetCascadeTrajectorySteps', {
      cascadeId,
      trajectoryVerbosity: 3,
      stepOffset: steps.length,
    });
    if (!page?.steps?.length) break;
    steps.push(...page.steps);
  }

  const turns: CleanTurn[] = [];
  let hasInteractiveActivity = false;

  for (const step of steps) {
    if (step?.userInput) {
      const text =
        step.userInput.userResponse ??
        (Array.isArray(step.userInput.items) ? step.userInput.items.map((i: any) => i?.text ?? '').join('') : '');
      turns.push({ role: 'user', text, timestamp: 0 });
    } else if (step?.plannerResponse && !step.plannerResponse.toolCalls?.length) {
      turns.push({ role: 'assistant', text: step.plannerResponse.response ?? '', timestamp: 0 });
    } else {
      hasInteractiveActivity = true;
    }
  }

  return {
    exists: true,
    numTotalSteps: total,
    hasInteractiveActivity,
    fingerprint: turns.length > 0 ? computeTurnsFingerprint(turns) : '',
  };
}

export function deleteAntigravityMirrorFiles(cascadeId: string): void {
  fs.rmSync(path.join(AMUX_HOME, 'imports', `${cascadeId}.db`), { force: true });
  fs.rmSync(path.join(ANTIGRAVITY_APP_DATA, 'brain', cascadeId), { recursive: true, force: true });
  const convDb = path.join(ANTIGRAVITY_APP_DATA, 'conversations', `${cascadeId}.db`);
  try {
    const stat = fs.lstatSync(convDb);
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(convDb);
      const resolved = path.resolve(path.dirname(convDb), linkTarget);
      if (resolved.startsWith(path.resolve(AMUX_HOME) + path.sep) || !fs.existsSync(convDb)) {
        fs.rmSync(convDb, { force: true });
      }
    }
  } catch {}
}

function existsInAntigravitySummariesDb(cascadeId: string): boolean {
  if (!fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) return false;
  try {
    const db = new Database(ANTIGRAVITY_SUMMARIES_DB, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare('SELECT 1 FROM conversation_summaries WHERE conversation_id = ?')
        .get(cascadeId);
      return Boolean(row);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function retireAntigravityTargetIfUntouched(
  oldId: string,
  expected: { turnCount?: number; fingerprint?: string; sourceId?: string },
  options: { dropSourceId?: string; liveSummaries?: Record<string, unknown> } = {}
): Promise<'deleted' | 'preserved' | 'missing'> {
  const markSuperseded = stateFn('markMirrorTargetSuperseded');
  const fallback = expected.sourceId
    ? { agent: 'antigravity' as const, sourceId: expected.sourceId, turnCount: expected.turnCount ?? 0 }
    : undefined;

  if (options.liveSummaries && !options.liveSummaries[oldId] && !existsInAntigravitySummariesDb(oldId)) {
    deleteAntigravityMirrorFiles(oldId);
    markSuperseded?.(oldId, { dropSourceId: options.dropSourceId, fallback });
    return 'missing';
  }

  const stored = await readAntigravityStoredState(oldId);
  if (!stored.exists) {
    deleteAntigravityMirrorFiles(oldId);
    markSuperseded?.(oldId, { dropSourceId: options.dropSourceId, fallback });
    return 'missing';
  }

  const userContinued =
    stored.hasInteractiveActivity ||
    (expected.turnCount !== undefined && expected.turnCount > 0 && stored.numTotalSteps > expected.turnCount) ||
    Boolean(
      expected.fingerprint &&
      expected.turnCount !== undefined &&
      stored.numTotalSteps === expected.turnCount &&
      stored.fingerprint !== expected.fingerprint
    );

  if (userContinued) {
    markSuperseded?.(oldId, { preservedUserContinuation: true, fallback });
    return 'preserved';
  }

  await antigravityRequest('DeleteCascadeTrajectory', { cascadeId: oldId });
  deleteAntigravityMirrorFiles(oldId);
  markSuperseded?.(oldId, { dropSourceId: options.dropSourceId, fallback });
  return 'deleted';
}

async function retireCodexTargetIfUntouched(
  client: CodexAppServerClient,
  oldId: string,
  expected: { turnCount?: number; fingerprint?: string; sourceId?: string },
  options: { dropSourceId?: string } = {}
): Promise<'archived' | 'preserved' | 'missing'> {
  const markSuperseded = stateFn('markMirrorTargetSuperseded');
  const fallback = expected.sourceId
    ? { agent: 'codex' as const, sourceId: expected.sourceId, turnCount: expected.turnCount ?? 0 }
    : undefined;

  let readback: any;
  try {
    readback = await client.request('thread/read', { threadId: oldId, includeTurns: false });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/not found|no thread|missing|archived/i.test(msg)) {
      markSuperseded?.(oldId, { dropSourceId: options.dropSourceId, fallback });
      return 'missing';
    }
    throw err;
  }

  if (!readback?.thread || readback.thread.archived) {
    markSuperseded?.(oldId, { dropSourceId: options.dropSourceId, fallback });
    return 'missing';
  }

  const stored = readback.thread.path ? extractCodexStoredState(readback.thread.path) : null;
  if (stored) {
    const userContinued =
      stored.hasInteractiveActivity ||
      (expected.turnCount !== undefined && expected.turnCount > 0 && stored.turns.length > expected.turnCount) ||
      Boolean(
        expected.fingerprint &&
        expected.turnCount !== undefined &&
        stored.turns.length === expected.turnCount &&
        stored.fingerprint !== expected.fingerprint
      );

    if (userContinued) {
      markSuperseded?.(oldId, { preservedUserContinuation: true, fallback });
      return 'preserved';
    }
  }

  await client.request('thread/archive', { threadId: oldId });
  markSuperseded?.(oldId, { dropSourceId: options.dropSourceId, fallback });
  return 'archived';
}

function findSameTitleAntigravityMirrors(workspacePath: string, title: string, excludeId: string): string[] {
  if (!title.includes('[来自 Codex]') || !fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) return [];
  const normWs = normRoot(workspacePath);
  const encodedUri = pathToFileURL(normWs).href;
  try {
    const db = new Database(ANTIGRAVITY_SUMMARIES_DB, { readonly: true, fileMustExist: true });
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>).map((c) => c.name)
      );
      const parentClause = cols.has('parent_conversation_id')
        ? "AND (parent_conversation_id IS NULL OR parent_conversation_id = '')"
        : '';
      const rows = db
        .prepare(
          `SELECT conversation_id, workspace_uris
           FROM conversation_summaries
           WHERE title = ? AND conversation_id != ?
             AND (workspace_uris LIKE ? OR workspace_uris LIKE ?)
             ${parentClause}`
        )
        .all(title, excludeId, `%${encodedUri}%`, `%file://${normWs}%`) as Array<{
          conversation_id: string;
          workspace_uris: string;
        }>;
      return rows
        .filter((r) => antigravityWorkspaceMatches(r.workspace_uris, normWs))
        .map((r) => r.conversation_id);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function findSameTitleCodexMirrors(workspacePath: string, title: string, excludeId: string): Array<{ id: string; rollout_path: string }> {
  if (!title.includes('[来自 Antigravity]')) return [];
  const stateDbPath = findStateDb();
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return [];
  const normWs = normRoot(workspacePath);
  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name)
      );
      const labelExpr = cols.has('name') ? "COALESCE(NULLIF(name, ''), NULLIF(title, ''), '')" : "COALESCE(title, '')";
      return db
        .prepare(
          `SELECT id, rollout_path
           FROM threads
           WHERE archived = 0 AND cwd = ? AND ${labelExpr} = ? AND id != ?`
        )
        .all(normWs, title, excludeId) as Array<{ id: string; rollout_path: string }>;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Clean up prior untouched Antigravity mirror targets for the same sourceSessionId
 * (plus any untracked byte-identical [来自 Codex] duplicate in the same workspace).
 */
export async function cleanupSupersededAntigravityTargets(
  sourceSessionId: string,
  keepTargetId: string,
  current?: { workspacePath: string; title: string; fingerprint: string; turnCount?: number }
): Promise<number> {
  const getPrior = stateFn('getPriorMirrorTargets');
  const markSuperseded = stateFn('markMirrorTargetSuperseded');
  const prior = typeof getPrior === 'function' ? getPrior(sourceSessionId, 'antigravity', keepTargetId) : [];
  const untrackedCandidates = current
    ? findSameTitleAntigravityMirrors(current.workspacePath, current.title, keepTargetId)
        .filter((id) => !prior.some((p) => p.targetSessionId === id))
    : [];

  if (prior.length === 0 && untrackedCandidates.length === 0) return 0;

  let deleted = 0;
  for (const item of prior) {
    try {
      const outcome = await retireAntigravityTargetIfUntouched(item.targetSessionId, {
        turnCount: item.info.turnCount,
        fingerprint: item.info.fingerprint,
        sourceId: sourceSessionId,
      });
      if (outcome === 'deleted') deleted++;
    } catch {
      /* Leave unsuperseded so a subsequent mirror/reconcile pass retries cleanly. */
    }
  }

  if (current?.fingerprint) {
    for (const candidateId of untrackedCandidates) {
      try {
        const stored = await readAntigravityStoredState(candidateId);
        if (!stored.exists) continue;
        if (!stored.hasInteractiveActivity && stored.fingerprint === current.fingerprint) {
          await antigravityRequest('DeleteCascadeTrajectory', { cascadeId: candidateId });
          deleteAntigravityMirrorFiles(candidateId);
          markSuperseded?.(candidateId, {
            fallback: { agent: 'antigravity', sourceId: sourceSessionId, turnCount: stored.numTotalSteps },
          });
          deleted++;
        }
      } catch {}
    }
  }

  return deleted;
}

/**
 * Clean up prior untouched Codex mirror targets for the same sourceSessionId
 * (plus any untracked byte-identical [来自 Antigravity] duplicate in the same workspace).
 */
export async function cleanupSupersededCodexTargets(
  client: CodexAppServerClient,
  sourceSessionId: string,
  keepTargetId: string,
  current?: { workspacePath: string; title: string; fingerprint: string; turnCount?: number }
): Promise<number> {
  const getPrior = stateFn('getPriorMirrorTargets');
  const markSuperseded = stateFn('markMirrorTargetSuperseded');
  const prior = typeof getPrior === 'function' ? getPrior(sourceSessionId, 'codex', keepTargetId) : [];
  const untrackedCandidates = current
    ? findSameTitleCodexMirrors(current.workspacePath, current.title, keepTargetId)
        .filter((row) => !prior.some((p) => p.targetSessionId === row.id))
    : [];

  if (prior.length === 0 && untrackedCandidates.length === 0) return 0;

  let archived = 0;
  for (const item of prior) {
    try {
      const outcome = await retireCodexTargetIfUntouched(client, item.targetSessionId, {
        turnCount: item.info.turnCount,
        fingerprint: item.info.fingerprint,
        sourceId: sourceSessionId,
      });
      if (outcome === 'archived') archived++;
    } catch {
      /* Retry on next pass */
    }
  }

  if (current?.fingerprint) {
    for (const candidate of untrackedCandidates) {
      try {
        const stored = extractCodexStoredState(candidate.rollout_path);
        if (!stored || stored.hasInteractiveActivity) continue;
        if (stored.fingerprint === current.fingerprint) {
          await client.request('thread/archive', { threadId: candidate.id });
          markSuperseded?.(candidate.id, {
            fallback: { agent: 'codex', sourceId: sourceSessionId, turnCount: stored.turns.length },
          });
          archived++;
        }
      } catch {}
    }
  }

  return archived;
}

function antigravityKeeperExists(keepTargetId: string, liveSummaries?: Record<string, unknown>): boolean {
  if (liveSummaries?.[keepTargetId]) return true;
  if (fs.existsSync(path.join(ANTIGRAVITY_APP_DATA, 'conversations', `${keepTargetId}.db`))) return true;
  return existsInAntigravitySummariesDb(keepTargetId);
}

function codexKeeperExists(keepTargetId: string): boolean {
  const stateDbPath = findStateDb();
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return false;
  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT archived FROM threads WHERE id = ?').get(keepTargetId) as { archived: number } | undefined;
      return Boolean(row && row.archived === 0);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Reconcile & clean up historical duplicate mirrored sessions across both Antigravity and Codex:
 * 1) Stale tracked targets superseded by a newer target for the same sourceSessionId
 * 2) Tracked targets that were accidentally mirrored from subagent sessions
 * 3) Untracked byte-identical [来自 Codex] / [来自 Antigravity] duplicate sessions in the same workspace
 */
export async function reconcileMirrorDuplicates(): Promise<{ antigravityDeleted: number; codexArchived: number }> {
  const stateFile = path.join(AMUX_HOME, 'mirror-state.json');
  if (!fs.existsSync(stateFile)) {
    return { antigravityDeleted: 0, codexArchived: 0 };
  }

  let antigravityDeleted = 0;
  let codexArchived = 0;

  // Allow re-evaluating previously preserved Codex targets that still have 0 tokens_used in SQLite
  // (e.g. workspaces with AGENTS.md preamble prior to thread_settings_applied boundary parsing).
  const retryCodexIds = new Set<string>();
  const stateDbForRetry = findStateDb();
  if (stateDbForRetry && fs.existsSync(stateDbForRetry)) {
    try {
      const db = new Database(stateDbForRetry, { readonly: true, fileMustExist: true });
      try {
        const cols = new Set(
          (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name)
        );
        if (cols.has('tokens_used')) {
          const rows = db
            .prepare('SELECT id FROM threads WHERE archived = 0 AND COALESCE(tokens_used, 0) = 0')
            .all() as Array<{ id: string }>;
          for (const r of rows) retryCodexIds.add(r.id);
        }
      } finally {
        db.close();
      }
    } catch {}
  }

  const duplicateGroups = stateFn('getAllUnsupersededDuplicateGroups')?.(retryCodexIds) ?? [];
  const allTargets = stateFn('getUnsupersededMirrorTargets')?.(retryCodexIds) ?? [];

  const agyGroups = duplicateGroups.filter((g) => g.targetAgent === 'antigravity');
  const codexGroups = duplicateGroups.filter((g) => g.targetAgent === 'codex');

  const agySubagentTargets = allTargets.filter(
    (t) => t.info.agent === 'antigravity' && isKnownCodexSubagentThread(t.info.sourceId)
  );
  const codexSubagentTargets = allTargets.filter(
    (t) => t.info.agent === 'codex' && isKnownAntigravitySubagentConversation(t.info.sourceId)
  );

  // --- Antigravity pass ---
  let liveSummaries: Record<string, unknown> | undefined;
  const fetchLiveSummaries = async () => {
    if (liveSummaries !== undefined) return liveSummaries;
    try {
      const history = await antigravityRequest('GetAllCascadeTrajectories', { excludeSubtrajectories: true });
      liveSummaries = history?.trajectorySummaries ?? {};
    } catch {
      liveSummaries = undefined;
    }
    return liveSummaries;
  };

  if (agyGroups.length > 0 || agySubagentTargets.length > 0) {
    const summaries = await fetchLiveSummaries();
    for (const group of agyGroups) {
      if (!antigravityKeeperExists(group.keepTargetId, summaries)) continue;
      for (const stale of group.staleTargets) {
        try {
          const outcome = await retireAntigravityTargetIfUntouched(
            stale.targetSessionId,
            { turnCount: stale.info.turnCount, fingerprint: stale.info.fingerprint, sourceId: group.sourceId },
            { liveSummaries: summaries }
          );
          if (outcome === 'deleted') antigravityDeleted++;
        } catch {}
      }
    }

    for (const sub of agySubagentTargets) {
      try {
        const outcome = await retireAntigravityTargetIfUntouched(
          sub.targetSessionId,
          { turnCount: sub.info.turnCount, fingerprint: sub.info.fingerprint, sourceId: sub.info.sourceId },
          { dropSourceId: sub.info.sourceId, liveSummaries: summaries }
        );
        if (outcome === 'deleted') antigravityDeleted++;
      } catch {}
    }
  }

  // Sweep untracked byte-identical [来自 Codex] duplicates in Antigravity summaries DB
  if (fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) {
    try {
      const db = new Database(ANTIGRAVITY_SUMMARIES_DB, { readonly: true, fileMustExist: true });
      let dupBuckets: Array<Array<{ conversation_id: string; title: string; workspace_uris: string; last_modified_time: string }>> = [];
      try {
        const cols = new Set(
          (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>).map((c) => c.name)
        );
        const parentClause = cols.has('parent_conversation_id')
          ? "AND (parent_conversation_id IS NULL OR parent_conversation_id = '')"
          : '';
        const rows = db
          .prepare(
            `SELECT conversation_id, title, workspace_uris, last_modified_time
             FROM conversation_summaries
             WHERE title LIKE '%[来自 Codex]%' ${parentClause}
             ORDER BY last_modified_time DESC`
          )
          .all() as Array<{ conversation_id: string; title: string; workspace_uris: string; last_modified_time: string }>;

        const byTitleAndWs = new Map<string, typeof rows>();
        for (const row of rows) {
          let wsKey = row.workspace_uris;
          try {
            const parsed = JSON.parse(row.workspace_uris);
            if (Array.isArray(parsed)) wsKey = parsed.map((u: string) => normRoot(u)).sort().join('|');
          } catch {}
          const k = `${wsKey}::${row.title}`;
          const list = byTitleAndWs.get(k) ?? [];
          list.push(row);
          byTitleAndWs.set(k, list);
        }
        dupBuckets = [...byTitleAndWs.values()].filter((list) => list.length >= 2);
      } finally {
        db.close();
      }

      if (dupBuckets.length > 0) {
        const summaries = await fetchLiveSummaries();
        const activeTargetIds = new Set(
          (stateFn('getUnsupersededMirrorTargets')?.() ?? []).map((t) => t.targetSessionId)
        );
        for (const bucket of dupBuckets) {
          const byFingerprint = new Map<string, typeof bucket>();
          for (const row of bucket) {
            try {
              const stored = await readAntigravityStoredState(row.conversation_id);
              if (!stored.exists || stored.hasInteractiveActivity || !stored.fingerprint) continue;
              const list = byFingerprint.get(stored.fingerprint) ?? [];
              list.push(row);
              byFingerprint.set(stored.fingerprint, list);
            } catch {}
          }
          for (const [, identicalRows] of byFingerprint) {
            if (identicalRows.length < 2) continue;
            identicalRows.sort((a, b) => {
              const aTracked = activeTargetIds.has(a.conversation_id) ? 1 : 0;
              const bTracked = activeTargetIds.has(b.conversation_id) ? 1 : 0;
              if (bTracked !== aTracked) return bTracked - aTracked;
              return b.last_modified_time.localeCompare(a.last_modified_time);
            });
            for (const dup of identicalRows.slice(1)) {
              try {
                if (summaries && !summaries[dup.conversation_id] && !existsInAntigravitySummariesDb(dup.conversation_id)) {
                  continue;
                }
                await antigravityRequest('DeleteCascadeTrajectory', { cascadeId: dup.conversation_id });
                deleteAntigravityMirrorFiles(dup.conversation_id);
                stateFn('markMirrorTargetSuperseded')?.(dup.conversation_id, {
                  fallback: { agent: 'antigravity', sourceId: 'reconciled-duplicate', turnCount: 0 },
                });
                antigravityDeleted++;
              } catch {}
            }
          }
        }
      }
    } catch {}
  }

  // --- Codex pass ---
  let codexUntrackedBuckets: Array<Array<{ id: string; rollout_path: string; updated_at_ms: number }>> = [];
  const stateDbPath = findStateDb();
  if (stateDbPath && fs.existsSync(stateDbPath)) {
    try {
      const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
      try {
        const cols = new Set(
          (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name)
        );
        const labelExpr = cols.has('name') ? "COALESCE(NULLIF(name, ''), NULLIF(title, ''), '')" : "COALESCE(title, '')";
        const updatedExpr = cols.has('updated_at_ms')
          ? 'COALESCE(updated_at_ms, created_at_ms * 1000)'
          : 'COALESCE(updated_at * 1000, 0)';
        const rows = db
          .prepare(
            `SELECT id, cwd, ${labelExpr} AS label, rollout_path, ${updatedExpr} AS updated_at_ms
             FROM threads
             WHERE archived = 0 AND ${labelExpr} LIKE '%[来自 Antigravity]%'
             ORDER BY ${updatedExpr} DESC`
          )
          .all() as Array<{ id: string; cwd: string; label: string; rollout_path: string; updated_at_ms: number }>;

        const byCwdAndLabel = new Map<string, Array<{ id: string; rollout_path: string; updated_at_ms: number }>>();
        for (const row of rows) {
          const k = `${normRoot(row.cwd)}::${row.label}`;
          const list = byCwdAndLabel.get(k) ?? [];
          list.push({ id: row.id, rollout_path: row.rollout_path, updated_at_ms: row.updated_at_ms });
          byCwdAndLabel.set(k, list);
        }
        codexUntrackedBuckets = [...byCwdAndLabel.values()].filter((list) => list.length >= 2);
      } finally {
        db.close();
      }
    } catch {}
  }

  if (codexGroups.length > 0 || codexSubagentTargets.length > 0 || codexUntrackedBuckets.length > 0) {
    let client: CodexAppServerClient | undefined;
    const ensureClient = async () => {
      if (!client) {
        client = new CodexAppServerClient();
        await client.start();
      }
      return client;
    };

    try {
      for (const group of codexGroups) {
        if (!codexKeeperExists(group.keepTargetId)) continue;
        for (const stale of group.staleTargets) {
          try {
            const c = await ensureClient();
            const outcome = await retireCodexTargetIfUntouched(c, stale.targetSessionId, {
              turnCount: stale.info.turnCount,
              fingerprint: stale.info.fingerprint,
              sourceId: group.sourceId,
            });
            if (outcome === 'archived') codexArchived++;
          } catch {}
        }
      }

      for (const sub of codexSubagentTargets) {
        try {
          const c = await ensureClient();
          const outcome = await retireCodexTargetIfUntouched(
            c,
            sub.targetSessionId,
            { turnCount: sub.info.turnCount, fingerprint: sub.info.fingerprint, sourceId: sub.info.sourceId },
            { dropSourceId: sub.info.sourceId }
          );
          if (outcome === 'archived') codexArchived++;
        } catch {}
      }

      if (codexUntrackedBuckets.length > 0) {
        const activeTargetIds = new Set(
          (stateFn('getUnsupersededMirrorTargets')?.() ?? []).map((t) => t.targetSessionId)
        );
        for (const bucket of codexUntrackedBuckets) {
          const byFingerprint = new Map<string, typeof bucket>();
          for (const row of bucket) {
            const stored = extractCodexStoredState(row.rollout_path);
            if (!stored || stored.hasInteractiveActivity || !stored.fingerprint) continue;
            const list = byFingerprint.get(stored.fingerprint) ?? [];
            list.push(row);
            byFingerprint.set(stored.fingerprint, list);
          }
          for (const [, identicalRows] of byFingerprint) {
            if (identicalRows.length < 2) continue;
            identicalRows.sort((a, b) => {
              const aTracked = activeTargetIds.has(a.id) ? 1 : 0;
              const bTracked = activeTargetIds.has(b.id) ? 1 : 0;
              if (bTracked !== aTracked) return bTracked - aTracked;
              return b.updated_at_ms - a.updated_at_ms;
            });
            for (const dup of identicalRows.slice(1)) {
              try {
                if (!codexKeeperExists(dup.id)) continue;
                const c = await ensureClient();
                await c.request('thread/archive', { threadId: dup.id });
                stateFn('markMirrorTargetSuperseded')?.(dup.id, {
                  fallback: { agent: 'codex', sourceId: 'reconciled-duplicate', turnCount: 0 },
                });
                codexArchived++;
              } catch {}
            }
          }
        }
      }
    } finally {
      if (client) await client.stop().catch(() => {});
    }
  }

  return { antigravityDeleted, codexArchived };
}
