/** Identifier of an agent harness (Codex, Antigravity, ...). Open string so new adapters can be added. */
export type HarnessId = "codex" | "antigravity" | (string & {});

export type EventKind =
  | "user_message"
  | "agent_message"
  | "command"
  | "file_change"
  | "tool_error"
  | "artifact"
  | "decision"
  | "pitfall";

export type FileOp = "read" | "edit" | "create" | "delete";

/** A single normalized conversation event, harness-agnostic. */
export interface NormalizedEvent {
  /** Globally unique & stable id (used for de-duplication). */
  id: string;
  agent: HarnessId | "manual";
  sessionId: string;
  sessionTitle?: string;
  /** ISO timestamp. */
  ts: string;
  kind: EventKind;
  text: string;
  files?: { path: string; op: FileOp }[];
  command?: string;
  exitCode?: number;
  failed?: boolean;
  /** For manual pitfalls: why it failed. */
  reason?: string;
}

export interface Decision {
  text: string;
  source: HarnessId | "manual";
  ts: string;
}

export interface Pitfall {
  attempt: string;
  reason: string;
  source: HarnessId | "manual";
  ts: string;
}

export interface ActiveFile {
  path: string;
  intent: string;
  lastTouchedBy: HarnessId | "git";
  ts: string;
}

export interface Turn {
  agent: HarnessId;
  sessionId: string;
  sessionTitle?: string;
  ts: string;
  user: string;
  agentDid: string;
  files: string[];
  failures: number;
}

export interface HandoffState {
  version: 1;
  project: { name: string; roots: string[] };
  lastActiveAgent: HarnessId | null;
  updatedAt: string;
  currentObjective: string;
  decisions: Decision[];
  triedAndFailed: Pitfall[];
  activeFiles: ActiveFile[];
  recentTurns: Turn[];
  git?: { branch?: string; dirty: string[] };
  compactor: "llm" | "rules";
  stats: { events: number; sessions: Record<string, number> };
}

/** A project as seen by one harness. */
export interface HarnessProject {
  harness: HarnessId;
  id: string;
  name: string;
  /** Normalized absolute root paths, [0] is primary. */
  roots: string[];
  updatedAt?: number;
}

/** A project unified across harnesses (persisted in ~/.amux/registry.json). */
export interface UnifiedProject {
  key: string;
  name: string;
  roots: string[];
  /** harnessId → native project id */
  ids: Record<string, string>;
  /** Duplicate projects (same root set) inside one harness, mirrored implicitly. */
  aliases?: { harness: HarnessId; id: string; name: string }[];
  /** Snapshot after the last successful sync — the base for 3-way merges & delete detection. */
  lastSynced?: { names: Record<string, string>; roots: string[]; at: string; ids: Record<string, string> };
  excluded?: boolean;
  /** Harnesses where the user deleted this project while delete-propagation was off: never re-create there. */
  detached?: string[];
}

/** A conversation/session reference discovered from a harness index. */
export interface SessionRef {
  harness: HarnessId;
  id: string;
  title?: string;
  /** Candidate workspace paths (cwd / workspace roots), normalized. */
  paths: string[];
  updatedAt: number;
  /** Primary transcript file to tail. */
  file: string;
}
