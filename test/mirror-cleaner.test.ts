import { describe, it, expect } from 'vitest';
import {
  cleanAntigravityUserInput,
  cleanCodexUserInput,
  cleanAssistantOutput,
  normalizeTurns,
} from '../src/mirror/cleaner.js';

describe('Mirror Cleaner', () => {
  it('cleans Antigravity user input by stripping metadata tags', () => {
    const raw = `<USER_REQUEST>
请帮我把前端的达人投放类型去掉。
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is 2026-11-10.
</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>
Model changed
</USER_SETTINGS_CHANGE>`;

    const cleaned = cleanAntigravityUserInput(raw);
    expect(cleaned).toBe('请帮我把前端的达人投放类型去掉。');
  });

  it('cleans Codex user input by stripping environment context', () => {
    const raw = `<environment_context>
  <cwd>/Users/test/amux</cwd>
  <shell>zsh</shell>
</environment_context>
帮我 review 一下项目代码`;

    const cleaned = cleanCodexUserInput(raw);
    expect(cleaned).toBe('帮我 review 一下项目代码');
  });

  it('cleans assistant output by stripping ls/cat tool blocks', () => {
    const raw = `我先检查一下仓库：
\`\`\`bash
ls -la
cat package.json
\`\`\`
确认已经修复完成！`;

    const cleaned = cleanAssistantOutput(raw);
    expect(cleaned).toContain('我先检查一下仓库：');
    expect(cleaned).toContain('确认已经修复完成！');
    expect(cleaned).not.toContain('ls -la');
  });

  it('normalizes and merges consecutive turns of the same role', () => {
    const turns = [
      { role: 'user' as const, text: '第一句话', timestamp: 100 },
      { role: 'user' as const, text: '补充第二句话', timestamp: 200 },
      { role: 'assistant' as const, text: '我收到了', timestamp: 300 },
    ];

    const normalized = normalizeTurns(turns);
    expect(normalized.length).toBe(2);
    expect(normalized[0].role).toBe('user');
    expect(normalized[0].text).toBe('第一句话\n\n补充第二句话');
    expect(normalized[1].role).toBe('assistant');
  });
});
