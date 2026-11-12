import type { CleanTurn } from './types.js';

/**
 * Clean raw Antigravity user input text:
 * Strips <USER_REQUEST>, <ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>, <RULE...> and system prompts.
 */
export function cleanAntigravityUserInput(raw: string): string {
  let text = raw;

  // Extract content between <USER_REQUEST> if present
  const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  }

  // Remove metadata blocks
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  text = text.replace(/<RULE\[.*?\]>[\s\S]*?<\/RULE\[.*?\]>/gi, '');
  text = text.replace(/<system_instructions>[\s\S]*?<\/system_instructions>/gi, '');
  text = text.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '');

  return text.trim();
}

/**
 * Clean raw Codex user input:
 * Strips <environment_context> and system injection blocks.
 */
export function cleanCodexUserInput(raw: string): string {
  let text = raw;
  text = text.replace(/^#\s*AGENTS\.md instructions for[^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/gi, '');
  text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '');
  text = text.replace(/<permissions>[\s\S]*?<\/permissions>/gi, '');
  text = text.replace(/<system_instructions>[\s\S]*?<\/system_instructions>/gi, '');
  text = text.replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, '');
  return text.trim();
}

/**
 * Clean Assistant response:
 * Keeps explanations, Markdown, code, and conclusions,
 * but strips internal tool call logs, raw debug dumps and system warnings.
 */
export function cleanAssistantOutput(raw: string): string {
  let text = raw;
  // Strip system messages
  text = text.replace(/\[System Message\]:?[\s\S]*?\n\n/gi, '');
  // Strip tool call echoes if present in markdown
  text = text.replace(/```(?:bash|sh)\s*\n(?:ls|cat|pwd|grep|find|which)[\s\S]*?```/gi, '');
  return text.trim();
}

/**
 * Compact consecutive turns of the same role and filter out empty turns.
 */
export function normalizeTurns(turns: CleanTurn[]): CleanTurn[] {
  const normalized: CleanTurn[] = [];

  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text) continue;

    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === turn.role) {
      // Merge into previous turn with double newline
      prev.text = `${prev.text}\n\n${text}`;
      prev.timestamp = Math.max(prev.timestamp, turn.timestamp);
    } else {
      normalized.push({
        role: turn.role,
        text,
        timestamp: turn.timestamp,
      });
    }
  }

  return normalized;
}
