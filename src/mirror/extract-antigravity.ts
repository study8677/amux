import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { cleanAntigravityUserInput, cleanAssistantOutput, formatMirrorTitle, normalizeTurns } from './cleaner.js';
import type { CleanTurn, MirrorSession } from './types.js';

interface RawAntigravityStep {
  step_index?: number;
  type?: string;
  source?: string;
  content?: string | null;
  created_at?: string;
  truncated_fields?: string[];
  tool_calls?: Array<{
    name?: string;
    args?: Record<string, unknown>;
    arguments?: string | Record<string, unknown>;
  }>;
}

const EDIT_TOOL_PATH_KEYS: Record<string, string[]> = {
  edit_file: ['Path'],
  write_file: ['Path'],
  write_to_file: ['TargetFile'],
  replace_file_content: ['TargetFile'],
  multi_replace_file_content: ['TargetFile'],
};

function decodeToolStringArg(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {}
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadFullStepsByIndex(
  fullTranscriptPath: string,
  wantedIndices: ReadonlySet<number>,
  wantedLineNumbers: ReadonlySet<number>
): Promise<{ byStepIndex: Map<number, RawAntigravityStep>; byLineNumber: Map<number, RawAntigravityStep> }> {
  const byStepIndex = new Map<number, RawAntigravityStep>();
  const byLineNumber = new Map<number, RawAntigravityStep>();
  if (!fs.existsSync(fullTranscriptPath) || (wantedIndices.size === 0 && wantedLineNumbers.size === 0)) {
    return { byStepIndex, byLineNumber };
  }

  const fileStream = fs.createReadStream(fullTranscriptPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let lineNo = 0;

  for await (const line of rl) {
    const currentLine = lineNo++;
    if (!line.trim()) continue;
    try {
      const step: RawAntigravityStep = JSON.parse(line);
      if (typeof step.step_index === 'number' && wantedIndices.has(step.step_index)) {
        byStepIndex.set(step.step_index, step);
      }
      if (wantedLineNumbers.has(currentLine)) {
        byLineNumber.set(currentLine, step);
      }
    } catch {
      // Ignore malformed lines in full transcript
    }
  }

  return { byStepIndex, byLineNumber };
}

/**
 * Extracts and cleans the conversation from an Antigravity transcript.jsonl file,
 * transparently hydrating any truncated steps from transcript_full.jsonl when available.
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

  const parsedSteps: Array<{ lineNo: number; step: RawAntigravityStep }> = [];
  const truncatedStepIndices = new Set<number>();
  const truncatedLineNumbers = new Set<number>();
  let lineNo = 0;

  for await (const line of rl) {
    const currentLine = lineNo++;
    if (!line.trim()) continue;
    try {
      const step: RawAntigravityStep = JSON.parse(line);
      if (step.type === 'USER_INPUT' || step.type === 'PLANNER_RESPONSE') {
        parsedSteps.push({ lineNo: currentLine, step });
        if (
          Array.isArray(step.truncated_fields) &&
          (step.truncated_fields.includes('content') || step.truncated_fields.includes('tool_calls'))
        ) {
          if (typeof step.step_index === 'number') {
            truncatedStepIndices.add(step.step_index);
          } else {
            truncatedLineNumbers.add(currentLine);
          }
        }
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  const fullPath = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  const fullLookup =
    truncatedStepIndices.size > 0 || truncatedLineNumbers.size > 0
      ? await loadFullStepsByIndex(fullPath, truncatedStepIndices, truncatedLineNumbers)
      : null;

  const rawTurns: CleanTurn[] = [];
  const modifiedFiles: Set<string> = new Set();
  let firstUserPrompt = '';

  for (const { lineNo: stepLineNo, step: compactStep } of parsedSteps) {
    const hydrated =
      fullLookup &&
      ((typeof compactStep.step_index === 'number' && fullLookup.byStepIndex.get(compactStep.step_index)) ||
        fullLookup.byLineNumber.get(stepLineNo));
    const step = hydrated && hydrated.type === compactStep.type ? hydrated : compactStep;
    const timestamp = step.created_at ? new Date(step.created_at).getTime() || Date.now() : Date.now();

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
          const keys = call.name ? EDIT_TOOL_PATH_KEYS[call.name] : undefined;
          let argObj: Record<string, unknown> | undefined = call.args;
          if (!argObj && call.arguments) {
            if (typeof call.arguments === 'string') {
              try {
                argObj = JSON.parse(call.arguments) as Record<string, unknown>;
              } catch {}
            } else if (typeof call.arguments === 'object') {
              argObj = call.arguments;
            }
          }
          if (keys && argObj) {
            for (const k of keys) {
              const decoded = decodeToolStringArg(argObj[k]);
              if (decoded) modifiedFiles.add(decoded);
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
  }

  const turns = normalizeTurns(rawTurns);
  if (turns.length === 0) {
    return null;
  }

  // If there are modified files, append summary note to the latest assistant turn
  if (modifiedFiles.size > 0) {
    let lastAssistant: CleanTurn | undefined;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'assistant') {
        lastAssistant = turns[i];
        break;
      }
    }
    if (lastAssistant) {
      const fileList = Array.from(modifiedFiles).map((f) => `- \`${f}\``).join('\n');
      lastAssistant.text += `\n\n> 💡 **[在此会话中编辑/创建的文件]**:\n${fileList}`;
    }
  }

  const baseTitle = formatMirrorTitle(sessionTitle || firstUserPrompt || '对话接力');

  return {
    sourceAgent: 'antigravity',
    targetAgent: 'codex',
    workspacePath,
    sourceSessionId: sessionId,
    title: baseTitle,
    turns,
  };
}
