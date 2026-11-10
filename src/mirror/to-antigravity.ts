import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ANTIGRAVITY_APP_DATA, ANTIGRAVITY_SUMMARIES_DB } from '../core/paths.js';
import { findAntigravityProjectId } from './project-resolver.js';
import type { MirrorResult, MirrorSession } from './types.js';

export async function mirrorToAntigravity(session: MirrorSession): Promise<MirrorResult> {
  const conversationId = crypto.randomUUID();
  const brainDir = path.join(ANTIGRAVITY_APP_DATA, 'brain', conversationId);
  const logsDir = path.join(brainDir, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  const nowIso = new Date().toISOString();

  // 1. Write transcript.jsonl
  const lines: string[] = [];
  let stepIndex = 0;

  for (const turn of session.turns) {
    const turnTime = turn.timestamp ? new Date(turn.timestamp).toISOString() : nowIso;

    if (turn.role === 'user') {
      const entry = {
        step_index: stepIndex++,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: turnTime,
        content: `<USER_REQUEST>\n${turn.text}\n</USER_REQUEST>`,
      };
      lines.push(JSON.stringify(entry));
    } else {
      const entry = {
        step_index: stepIndex++,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: turnTime,
        content: turn.text,
        tool_calls: [],
      };
      lines.push(JSON.stringify(entry));
    }
  }

  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf-8');

  // Also write an initial task.md
  const artifactNote = `# ${session.title}\n\n本会话由 amux 自动从 Codex 镜像接入。\n`;
  fs.writeFileSync(path.join(brainDir, 'task.md'), artifactNote, 'utf-8');

  // 2. Resolve project_id
  const projectId = findAntigravityProjectId(session.workspacePath) || '';

  // 3. Register into conversation_summaries.db
  if (fs.existsSync(ANTIGRAVITY_SUMMARIES_DB)) {
    const db = new Database(ANTIGRAVITY_SUMMARIES_DB, { timeout: 5000 });
    try {
      const firstPrompt = session.turns[0]?.text.slice(0, 150) || session.title;
      const workspaceUris = JSON.stringify([`file://${session.workspacePath}`]);

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO conversation_summaries (
          conversation_id,
          title,
          preview,
          step_count,
          last_modified_time,
          workspace_uris,
          status,
          source,
          app_data_dir,
          project_id,
          last_user_input_time,
          last_user_input_step_index
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);

      stmt.run(
        conversationId,
        session.title,
        firstPrompt,
        session.turns.length,
        nowIso,
        workspaceUris,
        'DONE',
        'USER_EXPLICIT',
        ANTIGRAVITY_APP_DATA,
        projectId,
        nowIso,
        0
      );
    } finally {
      db.close();
    }
  }

  return {
    targetAgent: 'antigravity',
    targetSessionId: conversationId,
    title: session.title,
    turnCount: session.turns.length,
    workspacePath: session.workspacePath,
  };
}
