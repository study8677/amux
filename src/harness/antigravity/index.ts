import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type { HarnessProject, NormalizedEvent, SessionRef } from "../../core/types.js";
import { AGY_GLOBAL_RULES, AGY_HOME, AGY_PROJECTS_DIR, AMUX_HOME, exists, normRoot } from "../../core/paths.js";
import { withDb } from "../../core/sqlite.js";
import { readAppended, readJson, writeFileAtomic } from "../../core/jsonl.js";
import { hashString } from "../../core/text.js";
import { log } from "../../core/log.js";
import type { CollectResult, Cursor, HarnessAdapter, ProjectInput, ProjectStore } from "../types.js";
import { parseAgyLines, summarizeArtifact, type AgyParseState } from "./parser.js";

const SUMMARIES_DB = () => path.join(AGY_HOME, "conversation_summaries.db");
const ARTIFACTS = ["task.md", "implementation_plan.md", "walkthrough.md"];

function transcriptPath(convId: string): string {
  return path.join(AGY_HOME, "brain", convId, ".system_generated", "logs", "transcript.jsonl");
}

function parseAgyTime(s: string): number {
  // "2026-11-09 10:31:38.319973+00:00" → ISO
  const iso = s.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1");
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

interface AgyProjectFile {
  id: string;
  name: string;
  projectResources?: { resources?: Array<{ folderUri?: string; gitFolder?: { folderUri?: string; [k: string]: unknown } }> };
  [k: string]: unknown;
}

function resourceUri(r: { folderUri?: string; gitFolder?: { folderUri?: string } }): string | undefined {
  return r.gitFolder?.folderUri ?? r.folderUri;
}

function toResource(root: string): Record<string, unknown> {
  const uri = pathToFileURL(root).href;
  return exists(path.join(root, ".git")) ? { gitFolder: { folderUri: uri } } : { folderUri: uri };
}

class AgyProjectStore implements ProjectStore {
  private backedUp = false;

  private file(id: string): string {
    return path.join(AGY_PROJECTS_DIR, `${id}.json`);
  }

  async list(): Promise<HarnessProject[]> {
    if (!exists(AGY_PROJECTS_DIR)) return [];
    const out: HarnessProject[] = [];
    for (const f of fs.readdirSync(AGY_PROJECTS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(AGY_PROJECTS_DIR, f);
      const d = readJson<AgyProjectFile | null>(fp, null);
      if (!d?.id) continue;
      const roots = (d.projectResources?.resources ?? []).map(resourceUri).filter((u): u is string => !!u).map(normRoot);
      out.push({ harness: "antigravity", id: d.id, name: d.name ?? d.id, roots, updatedAt: fs.statSync(fp).mtimeMs });
    }
    return out;
  }

  async prepareWrite(): Promise<void> {
    if (this.backedUp || !exists(AGY_PROJECTS_DIR)) return;
    const dest = path.join(AMUX_HOME, "backups", `agy-projects-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.cpSync(AGY_PROJECTS_DIR, dest, { recursive: true });
    log("antigravity", `已备份 projects 目录 → ${dest}`);
    this.backedUp = true;
  }

  async create(p: ProjectInput): Promise<HarnessProject> {
    const id = crypto.randomUUID();
    // Same field layout as files written by Antigravity itself — no custom fields.
    const doc = {
      id,
      name: p.name,
      projectResources: { resources: p.roots.map(toResource) },
      permissionGrants: { v2Migrated: true },
      settings: {},
      isWorkspaceOnly: false,
    };
    fs.mkdirSync(AGY_PROJECTS_DIR, { recursive: true });
    writeFileAtomic(this.file(id), JSON.stringify(doc, null, 2));
    return { harness: "antigravity", id, name: p.name, roots: p.roots };
  }

  async update(id: string, p: Partial<ProjectInput>): Promise<void> {
    const fp = this.file(id);
    const d = readJson<AgyProjectFile | null>(fp, null);
    if (!d) throw new Error(`Antigravity project ${id} not found`);
    if (p.name) d.name = p.name;
    if (p.roots) {
      const existing = new Map(
        (d.projectResources?.resources ?? []).map((r) => [normRoot(resourceUri(r) ?? ""), r] as const),
      );
      d.projectResources = {
        ...(d.projectResources ?? {}),
        resources: p.roots.map((r) => (existing.get(r) as any) ?? toResource(r)),
      };
    }
    writeFileAtomic(fp, JSON.stringify(d, null, 2));
  }

  async delete(id: string): Promise<void> {
    const fp = this.file(id);
    if (!exists(fp)) return;
    const trash = path.join(AMUX_HOME, "backups", "trash");
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(fp, path.join(trash, `${id}.${Date.now()}.json`));
  }

  async finishWrite(): Promise<string | void> {
    return "Antigravity：如项目列表未自动刷新，请重启 Antigravity 应用。";
  }
}

export function createAntigravityAdapter(): HarnessAdapter {
  return {
    id: "antigravity",
    displayName: "Antigravity",
    globalRuleFile: AGY_GLOBAL_RULES,
    detect: () => exists(AGY_HOME),
    projects: new AgyProjectStore(),

    listSessions(sinceMs: number): SessionRef[] {
      const db = SUMMARIES_DB();
      if (!exists(db)) return [];
      try {
        return withDb(db, (d) =>
          d
            .all<{ conversation_id: string; title: string; workspace_uris: string; last_modified_time: string; parent_conversation_id: string }>(
              `SELECT conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id FROM conversation_summaries`,
            )
            .map((r) => {
              let uris: string[] = [];
              try {
                uris = r.workspace_uris ? (JSON.parse(r.workspace_uris) as string[]) : [];
              } catch {
                uris = [];
              }
              return {
                harness: "antigravity",
                id: r.conversation_id,
                title: r.title,
                paths: uris.map(normRoot),
                updatedAt: parseAgyTime(r.last_modified_time),
                file: transcriptPath(r.conversation_id),
                parent: r.parent_conversation_id,
              };
            })
            .filter((s) => !s.parent && s.updatedAt > sinceMs && s.paths.length > 0 && exists(s.file))
            .map(({ parent: _p, ...s }) => s as SessionRef),
        );
      } catch (e) {
        log("antigravity", `读取 conversation_summaries 失败：${(e as Error).message}`, "warn");
        return [];
      }
    },

    collect(session: SessionRef, cursor: Cursor): CollectResult {
      const state: AgyParseState = { pending: (cursor.extra?.pending as AgyParseState["pending"]) ?? [] };
      const r = readAppended(session.file, cursor.offset);
      if (r.reset) state.pending = [];
      const events = parseAgyLines(r.lines, { sessionId: session.id, sessionTitle: session.title }, state);
      // artifacts (only when the transcript moved, or first read)
      const artHashes: Record<string, string> = { ...((cursor.extra?.artifacts as Record<string, string>) ?? {}) };
      if (!r.more && (r.lines.length || cursor.offset === 0)) {
        const dir = path.dirname(path.dirname(path.dirname(session.file)));
        for (const name of ARTIFACTS) {
          const fp = path.join(dir, name);
          if (!exists(fp)) continue;
          const content = fs.readFileSync(fp, "utf8");
          const h = hashString(content);
          if (artHashes[name] === h) continue;
          artHashes[name] = h;
          const ev: NormalizedEvent = {
            id: `agy:${session.id}:artifact:${name}:${h}`,
            agent: "antigravity",
            sessionId: session.id,
            sessionTitle: session.title,
            ts: new Date(fs.statSync(fp).mtimeMs).toISOString(),
            kind: "artifact",
            text: summarizeArtifact(name, content),
          };
          events.push(ev);
        }
      }
      return {
        events,
        cursor: { offset: r.newOffset, extra: { pending: state.pending.slice(-50), artifacts: artHashes } },
        more: r.more,
      };
    },

    watchTargets(): string[] {
      const db = SUMMARIES_DB();
      return [db + "-wal", db, AGY_PROJECTS_DIR].filter(exists);
    },
  };
}
