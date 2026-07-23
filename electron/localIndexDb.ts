/**
 * localIndexDb — the SQLite backend for the local project index (main process).
 *
 * Mirrors the renderer's `LocalIndex` port over IPC (`index:*`). The native
 * driver (`better-sqlite3`) is loaded with a GUARDED require so the app still
 * boots if it isn't installed/rebuilt yet: `index:available` then returns false
 * and the renderer falls back to its in-memory index. To activate on-device:
 * `npm i better-sqlite3` then `npx electron-rebuild -f -w better-sqlite3`.
 *
 * The index is a rebuildable cache — the `.motion` bundles remain the source of
 * truth — so a missing DB never blocks editing.
 */

import path from 'node:path';
import type { IpcMain, App } from 'electron';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

let db: Db | null = null;
let initTried = false;

function initDb(app: App): Db | null {
  if (initTried) return db;
  initTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const file = path.join(app.getPath('userData'), 'index.sqlite');
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        bundle_path TEXT NOT NULL,
        name TEXT NOT NULL,
        width INTEGER, height INTEGER, fps REAL, duration_seconds REAL, layer_count INTEGER,
        thumb_hash TEXT,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        opened_at INTEGER,
        missing INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_projects_opened ON projects(opened_at DESC);
      CREATE TABLE IF NOT EXISTS recovery (
        project_id TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        rev INTEGER,
        PRIMARY KEY (project_id, snapshot_path)
      );
    `);
    return db;
  } catch (err) {
    // Native module missing or ABI mismatch — degrade to "unavailable".
    console.warn('[localIndexDb] SQLite unavailable, using in-memory index:', (err as Error).message);
    db = null;
    return null;
  }
}

const rowToProject = (r: any) => ({
  id: r.id, bundlePath: r.bundle_path, name: r.name,
  width: r.width, height: r.height, fps: r.fps, durationSeconds: r.duration_seconds, layerCount: r.layer_count,
  thumbHash: r.thumb_hash ?? undefined, rev: r.rev, updatedAt: r.updated_at,
  openedAt: r.opened_at ?? undefined, missing: !!r.missing,
});

export function registerIndexIpc(ipcMain: IpcMain, app: App): void {
  ipcMain.handle('index:available', async () => initDb(app) != null);

  ipcMain.handle('index:upsertProject', async (_e, row: any) => {
    const d = initDb(app);
    if (!d) return;
    d.prepare(
      `INSERT INTO projects (id, bundle_path, name, width, height, fps, duration_seconds, layer_count, thumb_hash, rev, updated_at, opened_at, missing)
       VALUES (@id, @bundlePath, @name, @width, @height, @fps, @durationSeconds, @layerCount, @thumbHash, @rev, @updatedAt, @openedAt, @missing)
       ON CONFLICT(id) DO UPDATE SET bundle_path=@bundlePath, name=@name, width=@width, height=@height, fps=@fps,
         duration_seconds=@durationSeconds, layer_count=@layerCount, thumb_hash=@thumbHash, rev=@rev,
         updated_at=@updatedAt, opened_at=@openedAt, missing=@missing`,
    ).run({
      id: row.id, bundlePath: row.bundlePath, name: row.name,
      width: row.width ?? 0, height: row.height ?? 0, fps: row.fps ?? 0,
      durationSeconds: row.durationSeconds ?? 0, layerCount: row.layerCount ?? 0,
      thumbHash: row.thumbHash ?? null, rev: row.rev ?? 0,
      updatedAt: row.updatedAt ?? 0, openedAt: row.openedAt ?? null, missing: row.missing ? 1 : 0,
    });
  });

  ipcMain.handle('index:getProject', async (_e, id: string) => {
    const d = initDb(app);
    if (!d) return null;
    const r = d.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return r ? rowToProject(r) : null;
  });

  ipcMain.handle('index:listProjects', async (_e, opts: any) => {
    const d = initDb(app);
    if (!d) return [];
    const where = opts?.includeMissing ? '' : 'WHERE missing = 0';
    const limit = opts?.limit != null ? `LIMIT ${Number(opts.limit) | 0}` : '';
    const rows = d.prepare(
      `SELECT * FROM projects ${where} ORDER BY COALESCE(opened_at, updated_at) DESC ${limit}`,
    ).all();
    return rows.map(rowToProject);
  });

  ipcMain.handle('index:removeProject', async (_e, id: string) => {
    const d = initDb(app);
    if (!d) return;
    d.prepare('DELETE FROM projects WHERE id = ?').run(id);
    d.prepare('DELETE FROM recovery WHERE project_id = ?').run(id);
  });

  ipcMain.handle('index:markMissing', async (_e, id: string, missing: boolean) => {
    const d = initDb(app);
    if (!d) return;
    d.prepare('UPDATE projects SET missing = ? WHERE id = ?').run(missing ? 1 : 0, id);
  });

  ipcMain.handle('index:addRecovery', async (_e, row: any) => {
    const d = initDb(app);
    if (!d) return;
    d.prepare(
      `INSERT OR REPLACE INTO recovery (project_id, snapshot_path, created_at, rev)
       VALUES (@projectId, @snapshotPath, @createdAt, @rev)`,
    ).run({ projectId: row.projectId, snapshotPath: row.snapshotPath, createdAt: row.createdAt, rev: row.rev ?? null });
  });

  ipcMain.handle('index:listRecovery', async (_e, projectId: string) => {
    const d = initDb(app);
    if (!d) return [];
    return d.prepare('SELECT * FROM recovery WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      .map((r: any) => ({ projectId: r.project_id, snapshotPath: r.snapshot_path, createdAt: r.created_at, rev: r.rev ?? undefined }));
  });

  ipcMain.handle('index:clearRecovery', async (_e, projectId: string) => {
    const d = initDb(app);
    if (!d) return;
    d.prepare('DELETE FROM recovery WHERE project_id = ?').run(projectId);
  });
}
