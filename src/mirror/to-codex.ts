import fs from 'node:fs';
import { CodexAppServerClient } from '../harness/codex/appserver.js';
import { findCodexProjectId } from './project-resolver.js';
import { cleanupSupersededCodexTargets } from './dedup.js';
import { recordMirrorTarget, sessionFingerprint } from './state.js';
import type { MirrorResult, MirrorSession } from './types.js';

export async function mirrorToCodex(session: MirrorSession): Promise<MirrorResult> {
  const client = new CodexAppServerClient();
  await client.start();

  let createdThreadId: string | undefined;
  try {
    const projectId = findCodexProjectId(session.workspacePath);

    // 1. Start a new thread under the target project cwd and bind projectId if found
    const startRes: any = await client.request('thread/start', {
      cwd: session.workspacePath,
      ...(projectId ? { projectId } : {}),
    });

    const threadId: string = startRes.thread?.id || startRes.threadId || startRes.id;
    if (!threadId) {
      throw new Error(`Failed to create thread in Codex: unexpected response ${JSON.stringify(startRes)}`);
    }

    createdThreadId = threadId;

    // 2. Set the thread name with [来自 Antigravity] tag to prevent loopback
    const titleWithTag = session.title.includes('[来自 Antigravity]')
      ? session.title
      : `${session.title} [来自 Antigravity]`;

    await client.request('thread/name/set', {
      threadId,
      name: titleWithTag,
    });

    // 3. Inject clean conversational turns
    const items = session.turns.map((turn) => {
      if (turn.role === 'user') {
        return {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: turn.text,
            },
          ],
        };
      } else {
        return {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: turn.text,
            },
          ],
        };
      }
    });

    if (items.length > 0) {
      await client.request('thread/inject_items', {
        threadId,
        items,
      });
    }

    const readback = await client.request('thread/read', { threadId, includeTurns: true });
    if (readback.thread?.id !== threadId || !readback.thread.path) throw new Error('Codex 原生会话读回失败');
    const fp = sessionFingerprint(session);
    let matched = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const storedMessages = fs.readFileSync(readback.thread.path, 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((entry) => entry?.type === 'response_item' && entry.payload?.type === 'message'
          && ['user', 'assistant'].includes(entry.payload.role))
        .map((entry) => ({ role: entry.payload.role, text: entry.payload.content.map((part: any) => part.text ?? '').join(''), timestamp: 0 }));
      const tail = storedMessages.slice(-session.turns.length);
      if (tail.length === session.turns.length && sessionFingerprint({ ...session, turns: tail }) === fp) {
        matched = true;
        break;
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!matched) {
      throw new Error('Codex 原生会话磁盘读回内容不匹配');
    }
    recordMirrorTarget(threadId, 'codex', session.sourceSessionId, session.turns.length, {
      fingerprint: fp, nativeReadbackVerifiedAt: Date.now(),
    });
    await cleanupSupersededCodexTargets(client, session.sourceSessionId, threadId, {
      workspacePath: session.workspacePath,
      title: titleWithTag,
      fingerprint: fp,
      turnCount: session.turns.length,
    }).catch(() => {});

    return {
      sourceSessionId: session.sourceSessionId,
      nativeReadbackVerified: true,
      targetAgent: 'codex',
      targetSessionId: threadId,
      title: titleWithTag,
      turnCount: session.turns.length,
      workspacePath: session.workspacePath,
    };
  } catch (error) {
    if (createdThreadId) {
      const archived = await client.request('thread/archive', { threadId: createdThreadId }, 5000).then(() => true, () => false);
      if (!archived) {
        await client.stop().catch(() => {});
        const fallback = new CodexAppServerClient();
        try {
          await fallback.start();
          await fallback.request('thread/archive', { threadId: createdThreadId }, 5000);
        } catch {} finally {
          await fallback.stop().catch(() => {});
        }
      }
    }
    throw error;
  } finally {
    await client.stop();
  }
}
