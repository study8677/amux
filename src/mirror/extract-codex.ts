import fs from 'node:fs';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { findHistoryDb } from '../harness/codex/index.js';
import { cleanCodexUserInput, cleanAssistantOutput, formatMirrorTitle, normalizeTurns } from './cleaner.js';
import type { CleanTurn, MirrorSession } from './types.js';

interface RawCodexItem {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

/**
 * Extracts and cleans a Codex rollout JSONL file or sqlite history into clean conversational turns.
 */
export async function extractCodexSession(
  rolloutPath: string,
  sessionId: string,
  workspacePath: string,
  sessionTitle?: string
): Promise<MirrorSession | null> {
  const rawTurns: CleanTurn[] = [];
  let firstUserPrompt = '';

  if (rolloutPath && fs.existsSync(rolloutPath)) {
    const fileStream = fs.createReadStream(rolloutPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item: RawCodexItem = JSON.parse(line);
        if (item.type && item.type !== 'response_item') continue;
        const timestamp = item.timestamp ? new Date(item.timestamp).getTime() || Date.now() : Date.now();
        const payload = item.payload;

        if (!payload) continue;

        if (payload.role === 'user' && payload.content) {
          for (const c of payload.content) {
            if ((c.type === 'input_text' || c.type === 'text') && c.text) {
              const cleaned = cleanCodexUserInput(c.text);
              if (cleaned) {
                if (!firstUserPrompt) {
                  firstUserPrompt = cleaned.split('\n')[0].slice(0, 80);
                }
                rawTurns.push({
                  role: 'user',
                  text: cleaned,
                  timestamp,
                });
              }
            }
          }
        } else if (payload.role === 'assistant' && payload.content) {
          // Skip intermediate tool-status commentary emitted before final_answer
          if (payload.phase === 'commentary') continue;
          for (const c of payload.content) {
            if ((c.type === 'output_text' || c.type === 'text') && c.text) {
              const cleaned = cleanAssistantOutput(c.text);
              if (cleaned) {
                rawTurns.push({
                  role: 'assistant',
                  text: cleaned,
                  timestamp,
                });
              }
            }
          }
        }
      } catch {
        // Ignore corrupted lines
      }
    }
  } else {
    // Fallback: extract from thread_history_*.sqlite when rollout file was pruned
    const historyDbPath = findHistoryDb();
    if (!historyDbPath || !fs.existsSync(historyDbPath)) {
      return null;
    }

    try {
      const db = new Database(historyDbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare(
            `SELECT item_type, item_json, created_at_ms
             FROM thread_items
             WHERE thread_id = ? AND (item_type = 'userMessage' OR item_type = 'agentMessage')
             ORDER BY rollout_ordinal ASC`
          )
          .all(sessionId) as Array<{
            item_type: string;
            item_json: string;
            created_at_ms: number;
          }>;

        for (const row of rows) {
          try {
            const data = JSON.parse(row.item_json);
            const timestamp = row.created_at_ms || Date.now();

            if (row.item_type === 'userMessage') {
              let text = '';
              if (typeof data.text === 'string') {
                text = data.text;
              } else if (Array.isArray(data.content)) {
                text = data.content
                  .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
                  .filter(Boolean)
                  .join('\n');
              }
              const cleaned = cleanCodexUserInput(text);
              if (cleaned) {
                if (!firstUserPrompt) {
                  firstUserPrompt = cleaned.split('\n')[0].slice(0, 80);
                }
                rawTurns.push({
                  role: 'user',
                  text: cleaned,
                  timestamp,
                });
              }
            } else if (row.item_type === 'agentMessage') {
              if (data.phase === 'commentary') continue;
              let text = '';
              if (typeof data.text === 'string') {
                text = data.text;
              } else if (Array.isArray(data.content)) {
                text = data.content
                  .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
                  .filter(Boolean)
                  .join('\n');
              }
              const cleaned = cleanAssistantOutput(text);
              if (cleaned) {
                rawTurns.push({
                  role: 'assistant',
                  text: cleaned,
                  timestamp,
                });
              }
            }
          } catch {
            // ignore item json parse errors
          }
        }
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  const turns = normalizeTurns(rawTurns);
  if (turns.length === 0) {
    return null;
  }

  const baseTitle = formatMirrorTitle(sessionTitle || firstUserPrompt || '对话接力');

  return {
    sourceAgent: 'codex',
    targetAgent: 'antigravity',
    workspacePath,
    sourceSessionId: sessionId,
    title: baseTitle,
    turns,
  };
}
