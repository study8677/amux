import fs from 'node:fs';
import readline from 'node:readline';
import { cleanAntigravityUserInput, cleanAssistantOutput, normalizeTurns } from './cleaner.js';
import type { CleanTurn, MirrorSession } from './types.js';

interface RawAntigravityStep {
  step_index?: number;
  type?: string;
  source?: string;
  content?: string | null;
  created_at?: string;
  tool_calls?: Array<{
    name?: string;
    args?: {
      Path?: string;
      CommandLine?: string;
    };
  }>;
}

/**
 * Extracts and cleans the conversation from an Antigravity transcript.jsonl file.
 */
export async function extractAntigravitySession(
  transcriptPath: string,
  sessionId: string,
  workspacePath: string,
  sessionTitle?: string
): Promise<MirrorSession | null> {
  if (!fs.existsSync(transcriptPath)) {
    return null;
  }

  const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const rawTurns: CleanTurn[] = [];
  const modifiedFiles: Set<string> = new Set();
  let firstUserPrompt = '';

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const step: RawAntigravityStep = JSON.parse(line);
      const timestamp = step.created_at ? new Date(step.created_at).getTime() : Date.now();

      if (step.type === 'USER_INPUT' && step.content) {
        const cleanedUser = cleanAntigravityUserInput(step.content);
        if (cleanedUser) {
          if (!firstUserPrompt) {
            firstUserPrompt = cleanedUser.split('\n')[0].slice(0, 80);
          }
          rawTurns.push({
            role: 'user',
            text: cleanedUser,
            timestamp,
          });
        }
      } else if (step.type === 'PLANNER_RESPONSE') {
        // Collect edited files
        if (step.tool_calls) {
          for (const call of step.tool_calls) {
            if (call.name === 'edit_file' || call.name === 'write_file') {
              if (call.args?.Path) {
                // Strip redundant quotes if any
                const p = call.args.Path.replace(/^"|"$/g, '');
                modifiedFiles.add(p);
              }
            }
          }
        }

        if (step.content) {
          const cleanedAssistant = cleanAssistantOutput(step.content);
          if (cleanedAssistant) {
            rawTurns.push({
              role: 'assistant',
              text: cleanedAssistant,
              timestamp,
            });
          }
        }
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  const turns = normalizeTurns(rawTurns);
  if (turns.length === 0) {
    return null;
  }

  // If there are modified files, optionally append summary note to the last assistant turn
  if (modifiedFiles.size > 0) {
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.role === 'assistant') {
      const fileList = Array.from(modifiedFiles).map((f) => `- \`${f}\``).join('\n');
      lastTurn.text += `\n\n> 💡 **[在此会话中编辑/创建的文件]**:\n${fileList}`;
    }
  }

  const title = sessionTitle || (firstUserPrompt ? `[来自 Antigravity] ${firstUserPrompt}` : '[来自 Antigravity] 对话接力');

  return {
    sourceAgent: 'antigravity',
    targetAgent: 'codex',
    workspacePath,
    sourceSessionId: sessionId,
    title,
    turns,
  };
}
