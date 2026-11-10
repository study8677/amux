import { CodexAppServerClient } from '../harness/codex/appserver.js';
import type { MirrorResult, MirrorSession } from './types.js';

export async function mirrorToCodex(session: MirrorSession): Promise<MirrorResult> {
  const client = new CodexAppServerClient();
  await client.start();

  try {
    // 1. Start a new thread under the target project cwd
    const startRes: any = await client.request('thread/start', {
      cwd: session.workspacePath,
    });

    const threadId: string = startRes.thread?.id || startRes.threadId || startRes.id;
    if (!threadId) {
      throw new Error(`Failed to create thread in Codex: unexpected response ${JSON.stringify(startRes)}`);
    }

    // 2. Set the thread name
    await client.request('thread/name/set', {
      threadId,
      name: session.title,
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

    return {
      targetAgent: 'codex',
      targetSessionId: threadId,
      title: session.title,
      turnCount: session.turns.length,
      workspacePath: session.workspacePath,
    };
  } finally {
    await client.stop();
  }
}
