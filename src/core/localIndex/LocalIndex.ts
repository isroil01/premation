/**
 * LocalIndex — the query port over the rebuildable project/recovery index.
 *
 * Two backends implement this:
 *   - `MemoryLocalIndex` (below) — pure, for the browser build and tests.
 *   - a SQLite-backed index in the Electron main process (better-sqlite3),
 *     reached over IPC — the desktop backend. It is a THIN adapter: the schema
 *     mirrors these methods 1:1, so nothing here needs to change when it lands.
 *
 * The index is a cache, never authoritative — `deriveProjectFacts` + a bundle
 * scan can always rebuild it. Callers depend only on this interface.
 */

import type { ProjectIndexRow, RecoveryRow } from './types';

export interface LocalIndex {
  /** Insert or replace a project row (called on every save + on open). */
  upsertProject(row: ProjectIndexRow): Promise<void>;
  getProject(id: string): Promise<ProjectIndexRow | null>;
  /** Projects most-recently-opened first (falls back to updatedAt). */
  listProjects(opts?: { limit?: number; includeMissing?: boolean }): Promise<ProjectIndexRow[]>;
  removeProject(id: string): Promise<void>;
  /** Flag a project whose bundle path no longer exists (moved/deleted). */
  markMissing(id: string, missing: boolean): Promise<void>;

  addRecovery(row: RecoveryRow): Promise<void>;
  listRecovery(projectId: string): Promise<RecoveryRow[]>;
  clearRecovery(projectId: string): Promise<void>;
}

/** In-memory index — the browser/test backend. */
export class MemoryLocalIndex implements LocalIndex {
  private readonly projects = new Map<string, ProjectIndexRow>();
  private readonly recovery = new Map<string, RecoveryRow[]>();

  async upsertProject(row: ProjectIndexRow): Promise<void> {
    this.projects.set(row.id, { ...row });
  }

  async getProject(id: string): Promise<ProjectIndexRow | null> {
    const row = this.projects.get(id);
    return row ? { ...row } : null;
  }

  async listProjects(opts?: { limit?: number; includeMissing?: boolean }): Promise<ProjectIndexRow[]> {
    let rows = [...this.projects.values()];
    if (!opts?.includeMissing) rows = rows.filter((r) => !r.missing);
    rows.sort((a, b) => (b.openedAt ?? b.updatedAt) - (a.openedAt ?? a.updatedAt));
    return (opts?.limit != null ? rows.slice(0, opts.limit) : rows).map((r) => ({ ...r }));
  }

  async removeProject(id: string): Promise<void> {
    this.projects.delete(id);
    this.recovery.delete(id);
  }

  async markMissing(id: string, missing: boolean): Promise<void> {
    const row = this.projects.get(id);
    if (row) row.missing = missing;
  }

  async addRecovery(row: RecoveryRow): Promise<void> {
    const list = this.recovery.get(row.projectId) ?? [];
    list.push({ ...row });
    this.recovery.set(row.projectId, list);
  }

  async listRecovery(projectId: string): Promise<RecoveryRow[]> {
    return (this.recovery.get(projectId) ?? []).map((r) => ({ ...r }));
  }

  async clearRecovery(projectId: string): Promise<void> {
    this.recovery.delete(projectId);
  }
}

let shared: LocalIndex | null = null;

/**
 * The process-wide index. For now always the in-memory backend; the Electron
 * SQLite adapter will slot in here (detected via `window.motionEditor`) without
 * touching callers.
 */
export function getLocalIndex(): LocalIndex {
  return (shared ??= new MemoryLocalIndex());
}

/** Test seam / Electron wiring point. */
export function setLocalIndex(index: LocalIndex | null): void {
  shared = index;
}
