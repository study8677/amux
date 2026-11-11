export interface CleanTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface MirrorSession {
  sourceAgent: 'codex' | 'antigravity';
  targetAgent: 'codex' | 'antigravity';
  workspacePath: string;
  sourceSessionId: string;
  title: string;
  turns: CleanTurn[];
}

export interface MirrorResult {
  sourceSessionId?: string;
  nativeReadbackVerified?: boolean;
  targetAgent: 'codex' | 'antigravity';
  targetSessionId: string;
  title: string;
  turnCount: number;
  workspacePath: string;
  skipped?: boolean;
}
