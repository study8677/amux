import fs from 'node:fs';
import readline from 'node:readline';
import { cleanCodexUserInput, cleanAssistantOutput, normalizeTurns } from './cleaner.js';
import type { CleanTurn, MirrorSession } from './types.js';

interface RawCodexItem {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

/**
 * Extracts and cleans a Codex rollout JSONL file into clean conversational turns.
 */
export async function extractCodexSession(
  rolloutPath: string,
  sessionId: string,
  workspacePath: string,
  sessionTitle?: string
): Promise<MirrorSession | null> {
  if (!fs.existsSync(rolloutPath)) {
    return null;
  }

  const fileStream = fs.createReadStream(rolloutPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const rawTurns: CleanTurn[] = [];
  let firstUserPrompt = '';

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const item: RawCodexItem = JSON.parse(line);
      const timestamp = item.timestamp ? new Date(item.timestamp).getTime() : Date.now();
      const payload = item.payload;

      if (!payload) continue;

      if (payload.role === 'user' && payload.content) {
        for (const c of payload.content) {
          if (c.type === 'input_text' && c.text) {
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
        for (const c of payload.content) {
          if (c.type === 'output_text' && c.text) {
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

  const turns = normalizeTurns(rawTurns);
  if (turns.length === 0) {
    return null;
  }

  const title = sessionTitle || (firstUserPrompt ? `[来自 Codex] ${firstUserPrompt}` : '[来自 Codex] 对话接力');

  return {
    sourceAgent: 'codex',
    targetAgent: 'antigravity',
    workspacePath,
    sourceSessionId: sessionId,
    title,
    turns,
  };
}
