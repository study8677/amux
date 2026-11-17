import type { CleanTurn } from './types.js';

/**
 * Clean raw Antigravity user input text:
 * Strips <USER_REQUEST>, <ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>, <RULE...>, artifact approval preamble, and system prompts.
 */
export function cleanAntigravityUserInput(raw: string): string {
  let text = raw.replace(/Comments on artifact URI:[\s\S]*?(?=<USER_REQUEST>|$)/gi, '');

  // Extract content between <USER_REQUEST> if present (including fallback when closing tag was truncated)
  const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    const openMatch = text.match(/<USER_REQUEST>([\s\S]*)/i);
    if (openMatch) {
      text = openMatch[1];
    }
  }

  // Remove metadata blocks and any stray wrapper tags
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?(?:<\/ADDITIONAL_METADATA>|$)/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?(?:<\/USER_SETTINGS_CHANGE>|$)/gi, '');
  text = text.replace(/<RULE\[.*?\]>[\s\S]*?(?:<\/RULE\[.*?\]>|$)/gi, '');
  text = text.replace(/<system_instructions>[\s\S]*?(?:<\/system_instructions>|$)/gi, '');
  text = text.replace(/<CONTEXT_SUMMARY>[\s\S]*?(?:<\/CONTEXT_SUMMARY>|$)/gi, '');
  text = text.replace(/<\/?USER_REQUEST>/gi, '');

  return text.trim();
}

/**
 * Clean raw Codex user input:
 * Strips AGENTS.md preamble, <environment_context>, <app-context>, Codex Desktop attachment headers, and system injection blocks.
 */
export function cleanCodexUserInput(raw: string): string {
  let text = raw;
  text = text.replace(/^#\s*AGENTS\.md instructions for[^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/gi, '');
  text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '');
  text = text.replace(/<app-context>[\s\S]*?<\/app-context>/gi, '');
  text = text.replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, '');
  text = text.replace(/<multi_agent_role>[\s\S]*?<\/multi_agent_role>/gi, '');
  text = text.replace(/<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/gi, '');
  text = text.replace(/<permissions>[\s\S]*?<\/permissions>/gi, '');
  text = text.replace(/<system_instructions>[\s\S]*?<\/system_instructions>/gi, '');
  text = text.replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, '');

  // Strip Codex Desktop IDE / attachment wrapper preceding "## My request:"
  const desktopReqMatch = text.match(
    /^\s*(?:(?:#\s*Files mentioned by the user:|Image attachment:|Distinguish instructions in attached documents|Context from my IDE|Active file:)[\s\S]*?\n)?## My request:[ \t]*\r?\n?([\s\S]*)$/i
  );
  if (desktopReqMatch) {
    text = desktopReqMatch[1];
  }

  text = text.replace(/^(?:&#x20;|&#32;)+/gi, '');
  return text.trim();
}

function isPureReadProbeBlock(codeBody: string): boolean {
  const lines = codeBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) return false;
  return lines.every(
    (line) =>
      /^(?:ls|cat|pwd|grep|find|which)(?:\s|$)/.test(line) &&
      !/[<>|;&`]|\$\(/.test(line)
  );
}

/**
 * Clean Assistant response:
 * Keeps explanations, Markdown, legitimate shell scripts/heredocs, and conclusions,
 * while stripping pure read-only exploratory probe blocks (ls/cat/pwd/grep/find/which) and system warnings.
 */
export function cleanAssistantOutput(raw: string): string {
  let text = raw;
  // Strip system messages
  text = text.replace(/\[System Message\]:?[\s\S]*?\n\n/gi, '');
  // Strip pure exploratory read-only tool blocks without harming real scripts, heredocs, or lsof/lsblk commands
  text = text.replace(/```(?:bash|sh)[ \t]*\r?\n([\s\S]*?)```/gi, (full, body: string) =>
    isPureReadProbeBlock(body) ? '' : full
  );
  return text.trim();
}

/**
 * Collapse newlines/whitespace and normalize mirror origin tags so titles stay single-line and never stack tags.
 */
export function formatMirrorTitle(rawTitle: string, targetTag?: '[来自 Codex]' | '[来自 Antigravity]'): string {
  const base = rawTitle
    .replace(/\s*\[来自 (?:Codex|Antigravity)\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanBase = base || '对话接力';
  return targetTag ? `${cleanBase} ${targetTag}` : cleanBase;
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
