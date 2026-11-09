import fs from "node:fs";
import type { SessionRef } from "./types.js";

/** Sessions touched within this window are considered "active" and checked on every tick. */
export const ACTIVE_WINDOW_MS = 24 * 3600 * 1000;

function signature(s: SessionRef): string {
  try {
    const st = fs.statSync(s.file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return `u:${s.updatedAt}`; // history-db backed sessions: rely on the index timestamp
  }
}

/**
 * Detects which sessions actually changed since the last check by comparing file signatures.
 * Needed because harness indexes (e.g. Antigravity `last_modified_time`) lag behind the live transcript.
 */
export class ActivityTracker {
  private seen = new Map<string, string>();

  /** Returns sessions whose signature changed (all of them on the first call unless `prime`). */
  changed(sessions: SessionRef[]): SessionRef[] {
    const out: SessionRef[] = [];
    for (const s of sessions) {
      const k = `${s.harness}:${s.id}`;
      const sig = signature(s);
      if (this.seen.get(k) !== sig) out.push(s);
      this.seen.set(k, sig);
    }
    return out;
  }

  prime(sessions: SessionRef[]): void {
    this.changed(sessions);
  }

  /** Real files worth watching directly for low latency. */
  static files(sessions: SessionRef[]): string[] {
    return sessions.map((s) => s.file).filter((f) => f.startsWith("/") && fs.existsSync(f));
  }
}
