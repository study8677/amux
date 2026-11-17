import { describe, it, expect } from 'vitest';
import {
  cleanAntigravityUserInput,
  cleanCodexUserInput,
  cleanAssistantOutput,
  formatMirrorTitle,
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

  it('strips Antigravity artifact comments and handles truncated <USER_REQUEST> tags without leaking wrapper tags', () => {
    const withArtifactComments = `Comments on artifact URI: file:///tmp/implementation_plan.md
Line 12: please keep backward compatibility
<USER_REQUEST>
按上面的批注调整实现方案
</USER_REQUEST>`;
    expect(cleanAntigravityUserInput(withArtifactComments)).toBe('按上面的批注调整实现方案');

    const truncated = `<USER_REQUEST>
这是一段超长但在紧凑日志中缺少闭合标签的用户请求...[truncated]`;
    expect(cleanAntigravityUserInput(truncated)).toBe(
      '这是一段超长但在紧凑日志中缺少闭合标签的用户请求...[truncated]'
    );
  });

  it('cleans Codex user input by stripping environment, app/time context, and Desktop attachment headers', () => {
    const raw = `<environment_context>
  <cwd>/Users/test/amux</cwd>
  <shell>zsh</shell>
</environment_context>
<app-context>
  <ide>Cursor</ide>
</app-context>
<codex_apps_client_time_context>
  2026-11-12T17:00:00+08:00
</codex_apps_client_time_context>
Image attachment: true (1 image)
## My request:
&#x20;帮我 review 一下项目代码`;

    const cleaned = cleanCodexUserInput(raw);
    expect(cleaned).toBe('帮我 review 一下项目代码');
  });

  it('cleans assistant output by stripping pure read-only ls/cat probes while preserving heredocs, pipelines, and non-matching commands', () => {
    const raw = `我先检查一下仓库：
\`\`\`bash
ls -la
cat package.json
\`\`\`
然后写入配置文件并检查端口：
\`\`\`bash
cat << 'EOF' > app.conf
port=8080
EOF
\`\`\`
\`\`\`sh
ls -la | wc -l
lsof -i :8080
\`\`\`
确认已经修复完成！`;

    const cleaned = cleanAssistantOutput(raw);
    expect(cleaned).toContain('我先检查一下仓库：');
    expect(cleaned).not.toContain('cat package.json');
    expect(cleaned).toContain("cat << 'EOF' > app.conf");
    expect(cleaned).toContain('port=8080');
    expect(cleaned).toContain('ls -la | wc -l');
    expect(cleaned).toContain('lsof -i :8080');
    expect(cleaned).toContain('确认已经修复完成！');
  });

  it('formats mirror titles onto a single line without stacking mirror source tags', () => {
    expect(formatMirrorTitle('修复多行\n  标题显示问题  [来自 Codex]', '[来自 Antigravity]')).toBe(
      '修复多行 标题显示问题 [来自 Antigravity]'
    );
    expect(formatMirrorTitle('Feature Plan [来自 Antigravity] [来自 Codex]', '[来自 Codex]')).toBe(
      'Feature Plan [来自 Codex]'
    );
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
