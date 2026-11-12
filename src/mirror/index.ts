import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { ANTIGRAVITY_APP_DATA, ANTIGRAVITY_SUMMARIES_DB, normRoot } from '../core/paths.js';
import { CodexAppServerClient } from '../harness/codex/appserver.js';
import { findStateDb } from '../harness/codex/index.js';
import * as mirrorState from './state.js';
import { getLastSync, isMirrorTarget, sessionFingerprint } from './state.js';
import {
  antigravityWorkspaceMatches,
  cleanupSupersededAntigravityTargets,
  cleanupSupersededCodexTargets,
  codexUserThreadPredicates,
  reconcileMirrorDuplicates,
  withWorkspaceMirrorLock,
} from './dedup.js';
import { extractAntigravitySession } from './extract-antigravity.js';
import { extractCodexSession } from './extract-codex.js';
import { mirrorToAntigravity } from './to-antigravity.js';
import { mirrorToCodex } from './to-codex.js';
import type { MirrorResult } from './types.js';

export { reconcileMirrorDuplicates };

export interface MirrorOptions {
  workspacePath: string;
  source?: 'codex' | 'antigravity';
  target?: 'codex' | 'antigravity';
}

interface LatestAgentSession {
  agent: 'codex' | 'antigravity';
  id: string;
  title: string;
  updatedAtMs: number;
  filePath: string;
}

function parseAgyTimestampMs(raw: string): number {
  const iso = raw.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1');
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? new Date(raw).getTime() || 0 : parsed;
}

/**
 * Finds the latest user session for the given workspace in Codex (excluding subagents & mirror targets).
 */
function findLatestCodexSession(workspacePath: string, altWorkspacePath?: string): LatestAgentSession | null {
  const stateDbPath = findStateDb();
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return null;

  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const cols = (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name);
      const userPredicates = codexUserThreadPredicates(cols).join(' AND ');
      const cwds = altWorkspacePath && altWorkspacePath !== workspacePath
        ? [workspacePath, altWorkspacePath]
        : [workspacePath];
      const cwdPlaceholders = cwds.map(() => '?').join(', ');

      const hasName = cols.includes('name');
      const labelExpr = hasName ? "COALESCE(NULLIF(name, ''), NULLIF(title, ''), '')" : "COALESCE(title, '')";

      const rows = db
        .prepare(
          `SELECT id, title, ${hasName ? 'name' : 'NULL AS name'}, rollout_path, updated_at_ms, created_at_ms
           FROM threads
           WHERE cwd IN (${cwdPlaceholders})
             AND ${userPredicates}
             AND ${labelExpr} NOT LIKE '%[来自 Antigravity]%'
           ORDER BY COALESCE(updated_at_ms, created_at_ms * 1000) DESC
           LIMIT 20`
        )
        .all(...cwds) as Array<{
          id: string;
          title: string;
          name: string | null;
          rollout_path: string;
          updated_at_ms: number;
          created_at_ms: number;
        }>;

      for (const row of rows) {
        if (isMirrorTarget(row.id)) continue;
        if (!row.rollout_path || !fs.existsSync(row.rollout_path)) continue;

        return {
          agent: 'codex',
          id: row.id,
          title: row.name || row.title || 'Codex Session',
          updatedAtMs: row.updated_at_ms || row.created_at_ms * 1000,
          filePath: row.rollout_path,
        };
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Finds the latest user session for the given workspace in Antigravity (excluding subagents & mirror targets).
 */
function findLatestAntigravitySession(workspacePath: string): LatestAgentSession | null {
  if (!fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) return null;
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
             AND title NOT LIKE '%[来自 Codex]%'
             ${extraWhere}
           ORDER BY last_modified_time DESC
           LIMIT 30`
        )
        .all(`%${encodedUri}%`, `%"file://${workspacePath}"%`) as Array<{
          conversation_id: string;
          title: string;
          last_modified_time: string;
          workspace_uris?: string;
        }>;

      for (const row of rows) {
        if (row.workspace_uris && !antigravityWorkspaceMatches(row.workspace_uris, normWs)) continue;
        if (isMirrorTarget(row.conversation_id)) continue;

        const transcriptPath = path.join(
          ANTIGRAVITY_APP_DATA,
          'brain',
          row.conversation_id,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );

        if (!fs.existsSync(transcriptPath)) continue;

        return {
          agent: 'antigravity',
          id: row.conversation_id,
          title: row.title || 'Antigravity Session',
          updatedAtMs: parseAgyTimestampMs(row.last_modified_time),
          filePath: transcriptPath,
        };
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
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

    const codexLatest = findLatestCodexSession(canonicalWorkspace, resolvedWorkspace);
    const antigravityLatest = findLatestAntigravitySession(canonicalWorkspace);

    if (!source) {
      if (!codexLatest && !antigravityLatest) {
        throw new Error(`当前工作区 ${resolvedWorkspace} 下既未找到 Codex 会话，也未找到 Antigravity 会话。`);
      }

      if (codexLatest && !antigravityLatest) {
        source = 'codex';
      } else if (!codexLatest && antigravityLatest) {
        source = 'antigravity';
      } else {
        // Both exist: pick the more recent one
        source = codexLatest!.updatedAtMs >= antigravityLatest!.updatedAtMs ? 'codex' : 'antigravity';
      }
    }

    if (!target) {
      target = source === 'codex' ? 'antigravity' : 'codex';
    }

    if (source === target) {
      throw new Error(`源 Agent 和目标 Agent 不能相同 (${source})`);
    }

    if (source === 'antigravity' && target === 'codex') {
      if (!antigravityLatest) {
        throw new Error(`未找到 Antigravity 在工作区 ${resolvedWorkspace} 的活跃会话`);
      }

      const session = await extractAntigravitySession(
        antigravityLatest.filePath,
        antigravityLatest.id,
        resolvedWorkspace,
        antigravityLatest.title
      );

      if (!session || session.turns.length === 0) {
        throw new Error(`Antigravity 会话中没有可提取的有效对话内容`);
      }

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
            const titleWithTag = session.title.includes('[来自 Antigravity]')
              ? session.title
              : `${session.title} [来自 Antigravity]`;
            await cleanupSupersededCodexTargets(client, antigravityLatest.id, lastSync.targetSessionId, {
              workspacePath: resolvedWorkspace,
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
          workspacePath: resolvedWorkspace,
          skipped: true,
          sourceSessionId: session.sourceSessionId,
        };
      }

      return await mirrorToCodex(session);
    } else {
      // source === 'codex' && target === 'antigravity'
      if (!codexLatest) {
        throw new Error(`未找到 Codex 在工作区 ${resolvedWorkspace} 的活跃会话`);
      }

      const session = await extractCodexSession(
        codexLatest.filePath,
        codexLatest.id,
        resolvedWorkspace,
        codexLatest.title
      );

      if (!session || session.turns.length === 0) {
        throw new Error(`Codex 会话中没有可提取的有效对话内容`);
      }

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
          const titleWithTag = session.title.includes('[来自 Codex]')
            ? session.title
            : `${session.title} [来自 Codex]`;
          await cleanupSupersededAntigravityTargets(codexLatest.id, lastSync.targetSessionId, {
            workspacePath: resolvedWorkspace,
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
          workspacePath: resolvedWorkspace,
          skipped: true,
          sourceSessionId: session.sourceSessionId,
        };
      }

      return await mirrorToAntigravity(session);
    }
  });
}
