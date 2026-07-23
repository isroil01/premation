/**
 * SqliteLocalIndex — the desktop `LocalIndex`, forwarding to the main-process
 * SQLite backend over the `index:*` IPC. `initLocalIndex()` installs it at boot
 * IFF the native driver is available; otherwise the in-memory index stays.
 */

import type { MotionEditorApi } from '@app-types/motionEditor';
import { setLocalIndex, type LocalIndex } from './LocalIndex';
import type { ProjectIndexRow, RecoveryRow } from './types';

export class SqliteLocalIndex implements LocalIndex {
  constructor(private readonly bridge: NonNullable<MotionEditorApi['index']>) {}

  async upsertProject(row: ProjectIndexRow): Promise<void> {
    await this.bridge.upsertProject?.(row);
  }
  async getProject(id: string): Promise<ProjectIndexRow | null> {
    return ((await this.bridge.getProject?.(id)) as ProjectIndexRow | null) ?? null;
  }
  async listProjects(opts?: { limit?: number; includeMissing?: boolean }): Promise<ProjectIndexRow[]> {
    return ((await this.bridge.listProjects?.(opts)) as ProjectIndexRow[]) ?? [];
  }
  async removeProject(id: string): Promise<void> {
    await this.bridge.removeProject?.(id);
  }
  async markMissing(id: string, missing: boolean): Promise<void> {
    await this.bridge.markMissing?.(id, missing);
  }
  async addRecovery(row: RecoveryRow): Promise<void> {
    await this.bridge.addRecovery?.(row);
  }
  async listRecovery(projectId: string): Promise<RecoveryRow[]> {
    return ((await this.bridge.listRecovery?.(projectId)) as RecoveryRow[]) ?? [];
  }
  async clearRecovery(projectId: string): Promise<void> {
    await this.bridge.clearRecovery?.(projectId);
  }
}

/**
 * At boot: if the desktop SQLite index reports itself available, make it the
 * process-wide `LocalIndex`. Fire-and-forget; on any failure the in-memory index
 * remains, so the dashboard/recents keep working.
 */
export async function initLocalIndex(): Promise<void> {
  try {
    const bridge = typeof window !== 'undefined' ? window.motionEditor?.index : undefined;
    if (bridge?.available && (await bridge.available())) {
      setLocalIndex(new SqliteLocalIndex(bridge));
    }
  } catch {
    /* keep the in-memory index */
  }
}
