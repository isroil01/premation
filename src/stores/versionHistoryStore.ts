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

interface VersionHistoryState {
  versions: ProjectVersionSummary[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Id of the version currently being restored (for per-row spinners). */
  restoringId: string | null;

  load: () => Promise<void>;
  saveCheckpoint: (label?: string) => Promise<void>;
  restore: (versionId: string) => Promise<void>;
}

export const useVersionHistoryStore = create<VersionHistoryState>((set, get) => ({
  versions: [],
  status: 'idle',
  error: null,
  restoringId: null,

  load: async () => {
    const projectId = getCloudProjectId();
    if (!projectId) {
      set({ status: 'error', error: 'Open a cloud project to see its history.', versions: [] });
      return;
    }
    set({ status: 'loading', error: null });
    try {
      const versions = (await api.listVersions(projectId, { limit: 100 })).items;
      set({ versions, status: 'ready' });
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
      await get().load();
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
