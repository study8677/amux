import type { HarnessId, HarnessProject, NormalizedEvent, SessionRef } from "../core/types.js";

/** Per-session incremental cursor (persisted in <root>/.amux/cursors.json). */
export interface Cursor {
  offset: number;
  /** Adapter-specific parser state carried across incremental reads. */
  extra?: Record<string, unknown>;
}

export interface CollectResult {
  events: NormalizedEvent[];
  cursor: Cursor;
  /** True when more data is pending (caller should call again). */
  more: boolean;
}

export interface ProjectInput {
  name: string;
  roots: string[];
  /** Peer ids from other harnesses (stored as metadata where supported). */
  peers?: Record<string, string>;
}

/** Read/write access to a harness' native project list. */
export interface ProjectStore {
  list(): Promise<HarnessProject[]>;
  create(p: ProjectInput): Promise<HarnessProject>;
  update(id: string, p: Partial<ProjectInput>): Promise<void>;
  delete(id: string): Promise<void>;
  /** Called once before the first mutation of a cycle (backups etc.). */
  prepareWrite?(): Promise<void>;
  /** Called after mutations (e.g. tear down child processes, print hints). */
  finishWrite?(): Promise<string | void>;
}

/**
 * A pluggable adapter for one AI coding agent harness.
 * Adding a new harness (Claude Code, Gemini CLI, Cursor...) = implementing this interface.
 */
export interface HarnessAdapter {
  id: HarnessId;
  displayName: string;
  detect(): boolean;
  projects?: ProjectStore;
  /** Sessions updated after `sinceMs` (epoch ms). */
  listSessions(sinceMs: number): SessionRef[];
  /** Incrementally parse one session from the cursor. */
  collect(session: SessionRef, cursor: Cursor): CollectResult;
  /** Files whose changes indicate new sessions / new messages. */
  watchTargets(): string[];
  globalRuleFile?: string;
}
