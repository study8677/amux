import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AGY_PROJECTS_DIR, normRoot, isWithin } from '../core/paths.js';
import { findStateDb } from '../harness/codex/index.js';

export function findAntigravityProjectId(workspacePath: string): string | null {
  if (!fs.existsSync(AGY_PROJECTS_DIR)) return null;
  const target = normRoot(workspacePath);

  try {
    const files = fs.readdirSync(AGY_PROJECTS_DIR).filter((f) => f.endsWith('.json'));
    let bestMatch: { id: string; len: number } | null = null;

    for (const f of files) {
      try {
        const full = path.join(AGY_PROJECTS_DIR, f);
        const json = JSON.parse(fs.readFileSync(full, 'utf8'));
        const resources = json.projectResources?.resources ?? [];
        for (const r of resources) {
          const uri = r.folderUri ?? r.gitFolder?.folderUri ?? r.workspaceRoot?.folderUri;
          if (uri) {
            const root = normRoot(uri);
            if (isWithin(target, root) || isWithin(root, target)) {
              if (!bestMatch || root.length > bestMatch.len) {
                bestMatch = { id: json.id || path.basename(f, '.json'), len: root.length };
              }
            }
          }
        }
      } catch {}
    }
    return bestMatch?.id ?? null;
  } catch {
    return null;
  }
}

export function findCodexProjectId(workspacePath: string): string | null {
  const stateDbPath = findStateDb();
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return null;
  const target = normRoot(workspacePath);

  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT project_id, path FROM project_roots').all() as Array<{
        project_id: string;
        path: string;
      }>;

      let bestMatch: { id: string; len: number } | null = null;
      for (const row of rows) {
        const root = normRoot(row.path);
        if (isWithin(target, root) || isWithin(root, target)) {
          if (!bestMatch || root.length > bestMatch.len) {
            bestMatch = { id: row.project_id, len: root.length };
          }
        }
      }
      return bestMatch?.id ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
