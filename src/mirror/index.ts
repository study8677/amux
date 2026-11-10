import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ANTIGRAVITY_APP_DATA, ANTIGRAVITY_SUMMARIES_DB } from '../core/paths.js';
import { findStateDb } from '../harness/codex/index.js';
import { extractAntigravitySession } from './extract-antigravity.js';
import { extractCodexSession } from './extract-codex.js';
import { mirrorToAntigravity } from './to-antigravity.js';
import { mirrorToCodex } from './to-codex.js';
import type { MirrorResult } from './types.js';

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

/**
 * Finds the latest session for the given workspace in Codex.
 */
function findLatestCodexSession(workspacePath: string): LatestAgentSession | null {
  const stateDbPath = findStateDb();
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return null;

  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          `SELECT id, title, name, rollout_path, updated_at_ms, created_at_ms
           FROM threads
           WHERE cwd = ? AND archived = 0 AND COALESCE(name, title, '') NOT LIKE '%[来自 Antigravity]%'
           ORDER BY COALESCE(updated_at_ms, created_at_ms * 1000) DESC
           LIMIT 1`
        )
        .get(workspacePath) as
        | {
            id: string;
            title: string;
            name: string | null;
            rollout_path: string;
            updated_at_ms: number;
            created_at_ms: number;
          }
        | undefined;

      if (!row || !row.rollout_path) return null;

      return {
        agent: 'codex',
        id: row.id,
        title: row.name || row.title || 'Codex Session',
        updatedAtMs: row.updated_at_ms || row.created_at_ms * 1000,
        filePath: row.rollout_path,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Finds the latest session for the given workspace in Antigravity.
 */
function findLatestAntigravitySession(workspacePath: string): LatestAgentSession | null {
  if (!fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) return null;

  try {
    const db = new Database(ANTIGRAVITY_SUMMARIES_DB, { readonly: true, fileMustExist: true });
    try {
      const pattern = `%"file://${workspacePath}"%`;
      const row = db
        .prepare(
          `SELECT conversation_id, title, last_modified_time
           FROM conversation_summaries
           WHERE workspace_uris LIKE ? AND title NOT LIKE '%[来自 Codex]%'
           ORDER BY last_modified_time DESC
           LIMIT 1`
        )
        .get(pattern) as
        | {
            conversation_id: string;
            title: string;
            last_modified_time: string;
          }
        | undefined;

      if (!row) return null;

      const transcriptPath = path.join(
        ANTIGRAVITY_APP_DATA,
        'brain',
        row.conversation_id,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );

      return {
        agent: 'antigravity',
        id: row.conversation_id,
        title: row.title || 'Antigravity Session',
        updatedAtMs: new Date(row.last_modified_time).getTime(),
        filePath: transcriptPath,
      };
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
  const normWorkspace = path.resolve(options.workspacePath);

  let source = options.source;
  let target = options.target;

  const codexLatest = findLatestCodexSession(normWorkspace);
  const antigravityLatest = findLatestAntigravitySession(normWorkspace);

  if (!source) {
    if (!codexLatest && !antigravityLatest) {
      throw new Error(`当前工作区 ${normWorkspace} 下既未找到 Codex 会话，也未找到 Antigravity 会话。`);
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
      throw new Error(`未找到 Antigravity 在工作区 ${normWorkspace} 的活跃会话`);
    }

    const session = await extractAntigravitySession(
      antigravityLatest.filePath,
      antigravityLatest.id,
      normWorkspace,
      antigravityLatest.title
    );

    if (!session || session.turns.length === 0) {
      throw new Error(`Antigravity 会话中没有可提取的有效对话内容`);
    }

    return await mirrorToCodex(session);
  } else {
    // source === 'codex' && target === 'antigravity'
    if (!codexLatest) {
      throw new Error(`未找到 Codex 在工作区 ${normWorkspace} 的活跃会话`);
    }

    const session = await extractCodexSession(
      codexLatest.filePath,
      codexLatest.id,
      normWorkspace,
      codexLatest.title
    );

    if (!session || session.turns.length === 0) {
      throw new Error(`Codex 会话中没有可提取的有效对话内容`);
    }

    return await mirrorToAntigravity(session);
  }
}
