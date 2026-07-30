/**
 * versionHistoryStore — reads and restores the server-side version history for
 * the current cloud project.
 *
 * motion-back keeps a rolling set of autosave snapshots plus explicit "save
 * version" points (see ProjectVersion). This store is the client surface over
 * those: list them, capture a new manual checkpoint, and restore one back into
 * the live editor. Restoring goes through the server (so the project's current
 * document + revision are updated and autosave keeps writing to the right head)
 * and then re-hydrates the running engines from the restored document.
 */

import { create } from 'zustand';
import { api, type ProjectVersionSummary } from '@core/api/client';
import { restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { getCloudProjectId } from './cloudProjectStore';
import { useProjectStore } from './projectStore';
import { bumpScene } from './sceneStore';
import { useUIStore } from './uiStore';

/**
 * Versions per page.
 *
 * History is the fastest-growing list the product has — autosave writes one
 * every few seconds of work — so this list is paged even though it lives in a
 * modal. It used to ask for 100 and render them as the whole history, which put
 * a hard, invisible floor under how far back anyone could restore from.
 */
const PAGE_SIZE = 20;

interface VersionHistoryState {
  versions: ProjectVersionSummary[];
  /** Versions this project has, ignoring paging. */
  total: number;
  limit: number;
  offset: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Id of the version currently being restored (for per-row spinners). */
  restoringId: string | null;

  /** Load a page. Omit `page` to reload the one on screen. */
  load: (page?: { limit: number; offset: number }) => Promise<void>;
  saveCheckpoint: (label?: string) => Promise<void>;
  restore: (versionId: string) => Promise<void>;
}

export const useVersionHistoryStore = create<VersionHistoryState>((set, get) => ({
  versions: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0,
  status: 'idle',
  error: null,
  restoringId: null,

  load: async (page) => {
    const projectId = getCloudProjectId();
    if (!projectId) {
      set({
        status: 'error',
        error: 'Open a cloud project to see its history.',
        versions: [],
        total: 0,
      });
      return;
    }
    const limit = page?.limit ?? get().limit;
    const offset = page?.offset ?? get().offset;
    set({ status: 'loading', error: null, limit, offset });
    try {
      const result = await api.listVersions(projectId, { limit, offset });
      // A checkpoint saved while you were on page 4 pushes everything down;
      // pruning does the same in reverse. Fall back to the last real page
      // rather than showing an empty modal.
      if (result.items.length === 0 && offset > 0 && result.total > 0) {
        const lastOffset = Math.max(0, (Math.ceil(result.total / limit) - 1) * limit);
        if (lastOffset !== offset) {
          await get().load({ limit, offset: lastOffset });
          return;
        }
      }
      set({ versions: result.items, total: result.total, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: (err as Error).message || 'Could not load history' });
    }
  },

  saveCheckpoint: async (label) => {
    const projectId = getCloudProjectId();
    if (!projectId) return;
    const time = useProjectStore.getState().activeTabId
      ? useProjectStore.getState().tabs[useProjectStore.getState().activeTabId!]?.time ?? 0
      : 0;
    try {
      await api.saveVersion(projectId, { kind: 'manual', label, time });
      useUIStore.getState().notify({
        level: 'success',
        message: label ? `Saved version “${label}”.` : 'Saved a version checkpoint.',
        durationMs: 3000,
      });
      // Back to page 1 — the version just saved is the newest, and the point of
      // saving it is to see it.
      await get().load({ limit: get().limit, offset: 0 });
    } catch (err) {
      useUIStore.getState().notify({
        level: 'error',
        message: `Couldn't save version: ${(err as Error).message}`,
        durationMs: 4000,
      });
    }
  },

  restore: async (versionId) => {
    const projectId = getCloudProjectId();
    if (!projectId) return;
    set({ restoringId: versionId });
    try {
      const project = await api.restoreVersion(projectId, versionId);
      restoreDocument(project.document as EditorDocument);
      bumpScene();
      useUIStore.getState().notify({
        level: 'success',
        message: 'Restored the selected version into the editor.',
        durationMs: 3000,
      });
      await get().load();
    } catch (err) {
      useUIStore.getState().notify({
        level: 'error',
        message: `Couldn't restore version: ${(err as Error).message}`,
        durationMs: 4000,
      });
    } finally {
      set({ restoringId: null });
    }
  },
}));
