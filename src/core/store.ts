import path from "node:path";
import type { HandoffState, NormalizedEvent } from "./types.js";
import { appendLines, parseJsonLine, readJson, readTailLines, writeJson } from "./jsonl.js";
import type { Cursor } from "../harness/types.js";
import { ensureDir, exists } from "./paths.js";

/** Per-project storage under `<primaryRoot>/.amux/`. */
export class ProjectStore {
  readonly dir: string;
  private recentIds: Set<string> | null = null;

  constructor(readonly primaryRoot: string) {
    this.dir = path.join(primaryRoot, ".amux");
  }

  get stateFile() {
    return path.join(this.dir, "state.json");
  }
  get historyFile() {
    return path.join(this.dir, "history.jsonl");
  }
  get manualFile() {
    return path.join(this.dir, "manual.jsonl");
  }
  get cursorsFile() {
    return path.join(this.dir, "cursors.json");
  }

  exists(): boolean {
    return exists(this.dir);
  }

  ensure(): void {
    ensureDir(this.dir);
  }

  loadState(): HandoffState | null {
    return readJson<HandoffState | null>(this.stateFile, null);
  }

  saveState(s: HandoffState): void {
    this.ensure();
    writeJson(this.stateFile, s);
  }

  loadCursors(): Record<string, Cursor> {
    return readJson<Record<string, Cursor>>(this.cursorsFile, {});
  }

  saveCursors(c: Record<string, Cursor>): void {
    this.ensure();
    writeJson(this.cursorsFile, c);
  }

  private ids(): Set<string> {
    if (!this.recentIds) {
      this.recentIds = new Set(
        readTailLines(this.historyFile, 20000)
          .map((l) => parseJsonLine<NormalizedEvent>(l)?.id)
          .filter((x): x is string => !!x),
      );
    }
    return this.recentIds;
  }

  /** Append events, skipping ids already present (bounded de-dup window). Returns appended events. */
  appendEvents(events: NormalizedEvent[]): NormalizedEvent[] {
    if (!events.length) return [];
    const ids = this.ids();
    const fresh = events.filter((e) => !ids.has(e.id));
    for (const e of fresh) ids.add(e.id);
    if (fresh.length) {
      this.ensure();
      appendLines(this.historyFile, fresh.map((e) => JSON.stringify(e)));
      const manual = fresh.filter((e) => e.agent === "manual");
      if (manual.length) appendLines(this.manualFile, manual.map((e) => JSON.stringify(e)));
    }
    return fresh;
  }

  /** Most recent `n` events (chronological). */
  tailEvents(n: number): NormalizedEvent[] {
    return readTailLines(this.historyFile, n)
      .map((l) => parseJsonLine<NormalizedEvent>(l))
      .filter((e): e is NormalizedEvent => !!e);
  }

  manualEvents(): NormalizedEvent[] {
    return readTailLines(this.manualFile, 500)
      .map((l) => parseJsonLine<NormalizedEvent>(l))
      .filter((e): e is NormalizedEvent => !!e);
  }
}
