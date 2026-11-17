import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { ANTIGRAVITY_APP_DATA, ANTIGRAVITY_SUMMARIES_DB, isWithin, normRoot } from '../core/paths.js';
import { CodexAppServerClient } from '../harness/codex/appserver.js';
import * as codexHarness from '../harness/codex/index.js';
import { findStateDb } from '../harness/codex/index.js';
import { formatMirrorTitle } from './cleaner.js';
import * as mirrorState from './state.js';
import { getLastSync, sessionFingerprint } from './state.js';
import {
  antigravityWorkspaceMatches,
  cleanupSupersededAntigravityTargets,
  cleanupSupersededCodexTargets,
  codexUserThreadPredicates,
  reconcileMirrorDuplicates,
  shouldSkipMirroredSession,
  withWorkspaceMirrorLock,
} from './dedup.js';
import { extractAntigravitySession } from './extract-antigravity.js';
import { extractCodexSession } from './extract-codex.js';
import { mirrorToAntigravity } from './to-antigravity.js';
import { mirrorToCodex } from './to-codex.js';
import type { MirrorResult, MirrorSession } from './types.js';

export { reconcileMirrorDuplicates };

export class EmptyMirrorSessionError extends Error {
  readonly code = 'AMUX_EMPTY_SESSION';
  constructor(message: string) {
    super(message);
    this.name = 'EmptyMirrorSessionError';
  }
}

export function isBenignEmptyMirrorError(error: unknown): boolean {
  if (error instanceof EmptyMirrorSessionError) return true;
  if (error && typeof error === 'object' && (error as { code?: string }).code === 'AMUX_EMPTY_SESSION') return true;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /没有可提取的有效对话(?:内容|轮次)|既未找到 Codex 会话，也未找到 Antigravity 会话|未找到 (?:Codex|Antigravity) 在工作区 .* 的活跃会话/.test(msg);
}

export interface MirrorOptions {
  workspacePath: string;
  source?: 'codex' | 'antigravity';
  target?: 'codex' | 'antigravity';
  sourceSessionId?: string;
}

interface LatestAgentSession {
  agent: 'codex' | 'antigravity';
  id: string;
  title: string;
  updatedAtMs: number;
  filePath: string;
  workspacePath: string;
}

function parseAgyTimestampMs(raw: string): number {
  const iso = raw.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1');
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? new Date(raw).getTime() || 0 : parsed;
}

function safeFileMtimeMs(filePath: string): number {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function findHistoryDbSafe(): string | null {
  if ('findHistoryDb' in codexHarness && typeof codexHarness.findHistoryDb === 'function') {
    return codexHarness.findHistoryDb();
  }
  return null;
}

/**
 * Finds candidate user sessions for the given workspace in Codex
 * (excluding subagents and untouched mirror targets, while allowing user-continued mirror sessions
 * and falling back to thread_history_*.sqlite when rollout files were pruned).
 */
function findCodexCandidates(
  workspacePath: string,
  altWorkspacePath?: string,
  preferredSessionId?: string
): LatestAgentSession[] {
  const stateDbPath = findStateDb();
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return [];

  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const cols = (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name);
      const userPredicates = codexUserThreadPredicates(cols).join(' AND ');
      const cwds = altWorkspacePath && altWorkspacePath !== workspacePath
        ? [workspacePath, altWorkspacePath]
        : [workspacePath];
      const cwdPlaceholders = cwds.map(() => '?').join(', ');
      const subdirPatterns = cwds.map((c) => `${escapeSqlLike(c)}${path.sep}%`);
      const subdirClauses = subdirPatterns.map(() => "cwd LIKE ? ESCAPE '\\'").join(' OR ');

      const hasName = cols.includes('name');
      const hasUpdatedAtMs = cols.includes('updated_at_ms');
      const hasCreatedAtMs = cols.includes('created_at_ms');
      const updatedSelect = hasUpdatedAtMs ? 'updated_at_ms' : 'NULL AS updated_at_ms';
      const createdSelect = hasCreatedAtMs ? 'created_at_ms' : '0 AS created_at_ms';
      const orderExpr = hasUpdatedAtMs
        ? `COALESCE(updated_at_ms, ${hasCreatedAtMs ? 'created_at_ms * 1000' : '0'})`
        : cols.includes('updated_at')
          ? 'COALESCE(updated_at * 1000, 0)'
          : '0';

      const rows = db
        .prepare(
          `SELECT id, cwd, title, ${hasName ? 'name' : 'NULL AS name'}, rollout_path, ${updatedSelect}, ${createdSelect}
           FROM threads
           WHERE (cwd IN (${cwdPlaceholders}) OR ${subdirClauses})
             AND ${userPredicates}
           ORDER BY ${orderExpr} DESC
           LIMIT 30`
        )
        .all(...cwds, ...subdirPatterns) as Array<{
          id: string;
          cwd: string;
          title: string;
          name: string | null;
          rollout_path: string;
          updated_at_ms: number | null;
          created_at_ms: number | null;
        }>;

      const historyDbPath = findHistoryDbSafe();
      const hasHistoryDb = Boolean(historyDbPath && fs.existsSync(historyDbPath));
      const candidates: LatestAgentSession[] = [];

      for (const row of rows) {
        const rowNormCwd = normRoot(row.cwd || workspacePath);
        if (!isWithin(rowNormCwd, workspacePath) && (!altWorkspacePath || !isWithin(row.cwd, altWorkspacePath))) {
          continue;
        }
        const label = row.name || row.title || '';
        const hasRollout = Boolean(row.rollout_path && fs.existsSync(row.rollout_path));
        if (shouldSkipMirroredSession('codex', row.id, label, hasRollout ? row.rollout_path : null)) {
          continue;
        }
        if (!hasRollout && !hasHistoryDb) continue;

        const dbTs = row.updated_at_ms || (row.created_at_ms ?? 0) * 1000;
        const mtime = hasRollout ? safeFileMtimeMs(row.rollout_path) : 0;

        candidates.push({
          agent: 'codex',
          id: row.id,
          title: label || 'Codex Session',
          updatedAtMs: Math.max(dbTs, mtime),
          filePath: hasRollout ? row.rollout_path : '',
          workspacePath: rowNormCwd,
        });
      }

      candidates.sort((a, b) => {
        if (preferredSessionId) {
          if (a.id === preferredSessionId && b.id !== preferredSessionId) return -1;
          if (b.id === preferredSessionId && a.id !== preferredSessionId) return 1;
        }
        return b.updatedAtMs - a.updatedAtMs;
      });
      return candidates;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Finds candidate user sessions for the given workspace in Antigravity
 * (excluding subagents and untouched mirror targets, while allowing user-continued mirror sessions).
 */
function findAntigravityCandidates(
  workspacePath: string,
  preferredSessionId?: string
): LatestAgentSession[] {
  if (!fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) return [];
  const normWs = normRoot(workspacePath);
  const encodedUri = pathToFileURL(normWs).href;

  try {
    const db = new Database(ANTIGRAVITY_SUMMARIES_DB, { readonly: true, fileMustExist: true });
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>).map((c) => c.name)
      );
      const subagentClauses: string[] = [];
      if (cols.has('parent_conversation_id')) {
        subagentClauses.push("(parent_conversation_id IS NULL OR parent_conversation_id = '')");
      }
      if (cols.has('nesting_depth')) {
        subagentClauses.push('(nesting_depth IS NULL OR nesting_depth = 0)');
      }
      const extraWhere = subagentClauses.length ? `AND ${subagentClauses.join(' AND ')}` : '';
      const hasWorkspaceUris = cols.has('workspace_uris');

      const rows = db
        .prepare(
          `SELECT conversation_id, title, last_modified_time${hasWorkspaceUris ? ', workspace_uris' : ''}
           FROM conversation_summaries
           WHERE (workspace_uris LIKE ? OR workspace_uris LIKE ?)
             ${extraWhere}
           ORDER BY last_modified_time DESC
           LIMIT 30`
        )
        .all(`%${encodedUri}%`, `%file://${workspacePath}%`) as Array<{
          conversation_id: string;
          title: string;
          last_modified_time: string;
          workspace_uris?: string;
        }>;

      const candidates: LatestAgentSession[] = [];

      for (const row of rows) {
        if (row.workspace_uris && !antigravityWorkspaceMatches(row.workspace_uris, normWs, true)) continue;

        const transcriptPath = path.join(
          ANTIGRAVITY_APP_DATA,
          'brain',
          row.conversation_id,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );

        if (!fs.existsSync(transcriptPath)) continue;
        if (shouldSkipMirroredSession('antigravity', row.conversation_id, row.title, transcriptPath)) continue;

        let matchedWs = normWs;
        if (row.workspace_uris) {
          try {
            const parsed = JSON.parse(row.workspace_uris);
            if (Array.isArray(parsed)) {
              const hit = parsed
                .filter((u): u is string => typeof u === 'string')
                .map(normRoot)
                .find((u) => isWithin(u, normWs));
              if (hit) matchedWs = hit;
            }
          } catch {}
        }

        const dbTs = parseAgyTimestampMs(row.last_modified_time);
        const mtime = safeFileMtimeMs(transcriptPath);

        candidates.push({
          agent: 'antigravity',
          id: row.conversation_id,
          title: row.title || 'Antigravity Session',
          updatedAtMs: Math.max(dbTs, mtime),
          filePath: transcriptPath,
          workspacePath: matchedWs,
        });
      }

      candidates.sort((a, b) => {
        if (preferredSessionId) {
          if (a.id === preferredSessionId && b.id !== preferredSessionId) return -1;
          if (b.id === preferredSessionId && a.id !== preferredSessionId) return 1;
        }
        return b.updatedAtMs - a.updatedAtMs;
      });
      return candidates;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function resolveFirstNonEmptyCodex(
  candidates: LatestAgentSession[],
  fallbackWorkspace: string
): Promise<{ meta: LatestAgentSession; session: MirrorSession } | null> {
  for (const cand of candidates) {
    const session = await extractCodexSession(
      cand.filePath,
      cand.id,
      cand.workspacePath || fallbackWorkspace,
      cand.title
    );
    if (session && session.turns.length > 0) {
      return { meta: cand, session };
    }
  }
  return null;
}

async function resolveFirstNonEmptyAntigravity(
  candidates: LatestAgentSession[],
  fallbackWorkspace: string
): Promise<{ meta: LatestAgentSession; session: MirrorSession } | null> {
  for (const cand of candidates) {
    const session = await extractAntigravitySession(
      cand.filePath,
      cand.id,
      cand.workspacePath || fallbackWorkspace,
      cand.title
    );
    if (session && session.turns.length > 0) {
      return { meta: cand, session };
    }
  }
  return null;
}

/**
 * Mirror the latest conversational context from one agent to the other.
 */
export async function mirrorLatestSession(options: MirrorOptions): Promise<MirrorResult> {
  const resolvedWorkspace = path.resolve(options.workspacePath);
  const canonicalWorkspace = normRoot(resolvedWorkspace);

  return await withWorkspaceMirrorLock(canonicalWorkspace, async () => {
    let source = options.source;
    let target = options.target;

    const codexCandidates =
      !source || source === 'codex'
        ? findCodexCandidates(canonicalWorkspace, resolvedWorkspace, options.sourceSessionId)
        : [];
    const antigravityCandidates =
      !source || source === 'antigravity'
        ? findAntigravityCandidates(canonicalWorkspace, options.sourceSessionId)
        : [];

    let resolvedCodex: { meta: LatestAgentSession; session: MirrorSession } | null = null;
    let resolvedAntigravity: { meta: LatestAgentSession; session: MirrorSession } | null = null;

    if (!source) {
      if (codexCandidates.length === 0 && antigravityCandidates.length === 0) {
        throw new EmptyMirrorSessionError(
          `当前工作区 ${resolvedWorkspace} 下既未找到 Codex 会话，也未找到 Antigravity 会话。`
        );
      }
      resolvedCodex = await resolveFirstNonEmptyCodex(codexCandidates, resolvedWorkspace);
      resolvedAntigravity = await resolveFirstNonEmptyAntigravity(antigravityCandidates, resolvedWorkspace);

      if (!resolvedCodex && !resolvedAntigravity) {
        throw new EmptyMirrorSessionError(`当前工作区 ${resolvedWorkspace} 的会话中暂无可提取的有效对话内容`);
      }

      if (resolvedCodex && !resolvedAntigravity) {
        source = 'codex';
      } else if (!resolvedCodex && resolvedAntigravity) {
        source = 'antigravity';
      } else {
        source = resolvedCodex!.meta.updatedAtMs >= resolvedAntigravity!.meta.updatedAtMs ? 'codex' : 'antigravity';
      }
    }

    if (!target) {
      target = source === 'codex' ? 'antigravity' : 'codex';
    }

    if (source === target) {
      throw new Error(`源 Agent 和目标 Agent 不能相同 (${source})`);
    }

    if (source === 'antigravity' && target === 'codex') {
      if (antigravityCandidates.length === 0) {
        throw new EmptyMirrorSessionError(`未找到 Antigravity 在工作区 ${resolvedWorkspace} 的活跃会话`);
      }

      const resolved =
        resolvedAntigravity ?? (await resolveFirstNonEmptyAntigravity(antigravityCandidates, resolvedWorkspace));
      if (!resolved) {
        throw new EmptyMirrorSessionError(`Antigravity 会话中没有可提取的有效对话内容`);
      }

      const { meta: antigravityLatest, session } = resolved;
      const fp = sessionFingerprint(session);
      const lastSync = getLastSync(antigravityLatest.id);
      if (lastSync && lastSync.targetAgent === 'codex' && lastSync.fingerprint === fp) {
        const prior =
          'getPriorMirrorTargets' in mirrorState && typeof mirrorState.getPriorMirrorTargets === 'function'
            ? mirrorState.getPriorMirrorTargets(antigravityLatest.id, 'codex', lastSync.targetSessionId)
            : [];
        if (prior.length > 0) {
          const client = new CodexAppServerClient();
          try {
            await client.start();
            const titleWithTag = formatMirrorTitle(session.title, '[来自 Antigravity]');
            await cleanupSupersededCodexTargets(client, antigravityLatest.id, lastSync.targetSessionId, {
              workspacePath: session.workspacePath,
              title: titleWithTag,
              fingerprint: fp,
              turnCount: session.turns.length,
            });
          } catch {} finally {
            await client.stop().catch(() => {});
          }
        }
        return {
          targetAgent: 'codex',
          targetSessionId: lastSync.targetSessionId,
          title: session.title,
          turnCount: session.turns.length,
          workspacePath: session.workspacePath,
          skipped: true,
          sourceSessionId: session.sourceSessionId,
        };
      }

      return await mirrorToCodex(session);
    } else {
      // source === 'codex' && target === 'antigravity'
      if (codexCandidates.length === 0) {
        throw new EmptyMirrorSessionError(`未找到 Codex 在工作区 ${resolvedWorkspace} 的活跃会话`);
      }

      const resolved = resolvedCodex ?? (await resolveFirstNonEmptyCodex(codexCandidates, resolvedWorkspace));
      if (!resolved) {
        throw new EmptyMirrorSessionError(`Codex 会话中没有可提取的有效对话内容`);
      }

      const { meta: codexLatest, session } = resolved;
      const fp = sessionFingerprint(session);
      const lastSync = getLastSync(codexLatest.id);
      if (
        lastSync &&
        lastSync.targetAgent === 'antigravity' &&
        lastSync.fingerprint === fp &&
        lastSync.nativeReadbackVerifiedAt !== undefined &&
        lastSync.nativeStorageVersion === 2 &&
        fs.existsSync(path.join(ANTIGRAVITY_APP_DATA, 'conversations', `${lastSync.targetSessionId}.db`))
      ) {
        const prior =
          'getPriorMirrorTargets' in mirrorState && typeof mirrorState.getPriorMirrorTargets === 'function'
            ? mirrorState.getPriorMirrorTargets(codexLatest.id, 'antigravity', lastSync.targetSessionId)
            : [];
        if (prior.length > 0) {
          const titleWithTag = formatMirrorTitle(session.title, '[来自 Codex]');
          await cleanupSupersededAntigravityTargets(codexLatest.id, lastSync.targetSessionId, {
            workspacePath: session.workspacePath,
            title: titleWithTag,
            fingerprint: fp,
            turnCount: session.turns.length,
          }).catch(() => {});
        }
        return {
          targetAgent: 'antigravity',
          targetSessionId: lastSync.targetSessionId,
          title: session.title,
          turnCount: session.turns.length,
          workspacePath: session.workspacePath,
          skipped: true,
          sourceSessionId: session.sourceSessionId,
        };
      }

      return await mirrorToAntigravity(session);
    }
  });
}
