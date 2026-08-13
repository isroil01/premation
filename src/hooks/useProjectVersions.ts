/**
 * useProjectVersions — the React seam for a version-history panel (local-first).
 *
 * Wraps the tested bundle version helpers (`listProjectVersions` /
 * `saveProjectBundleVersion` / `restoreProjectVersion`) and binds them to the
 * current project's bundle path. Only active under LOCAL_FIRST with a `.motion`
 * bundle open; otherwise it reports `available: false` and the panel can hide.
 *
 * The heavy lifting (content-addressed snapshots, structural sharing, restore)
 * is all in `@core/project/bundle/*` and unit-tested; this hook is just the thin
 * binding a component consumes.
 */

import { useCallback, useEffect, useState } from 'react';
import { getProjectManager } from '@core/services/coreServices';
import { getEventBus } from '@core/events/EventBus';
import { bumpScene } from '@stores/sceneStore';
import { isLocalFirst } from '@core/config/flags';
import {
  isBundlePath,
  listProjectVersions,
  saveProjectBundleVersion,
  restoreProjectVersion,
} from '@core/project/bundle/bundleProjectIO';
import { markProjectDirty } from '@core/project/projectSession';
import type { VersionEntry } from '@core/project/bundle/VersionStore';

export interface UseProjectVersions {
  available: boolean;
  versions: VersionEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
  saveVersion: (label?: string) => Promise<void>;
  restore: (rev: number) => Promise<boolean>;
}

function currentBundleRoot(): string | null {
  if (!isLocalFirst()) return null;
  const path = getProjectManager().getState().current?.path ?? null;
  return path && isBundlePath(path) ? path : null;
}

export function useProjectVersions(): UseProjectVersions {
  const [root, setRoot] = useState<string | null>(() => currentBundleRoot());
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Track project changes (open / save-as changes the bundle root).
  useEffect(() => {
    const sync = (): void => setRoot(currentBundleRoot());
    const unsubMgr = getProjectManager().subscribe(sync);
    const bus = getEventBus();
    const dLoaded = bus.on('ProjectLoaded', sync);
    const dSaved = bus.on('ProjectSaved', sync);
    return () => {
      unsubMgr();
      dLoaded.dispose();
      dSaved.dispose();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!root) {
      setVersions([]);
      return;
    }
    setLoading(true);
    try {
      setVersions(await listProjectVersions(root));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveVersion = useCallback(
    async (label?: string) => {
      if (!root) return;
      await saveProjectBundleVersion(root, 'manual', label);
      await refresh();
    },
    [root, refresh],
  );

  const restore = useCallback(
    async (rev: number) => {
      if (!root) return false;
      const ok = await restoreProjectVersion(root, rev);
      if (ok) {
        // restoreProjectVersion restores the document into the live engines,
        // but the scene graph is not reactive — bump it so canvas/layers/
        // timeline UI re-read the restored state (same as the ProjectLoaded
        // pipeline does), then re-read the version list.
        bumpScene();
        // Mark the WORKSPACE tab, which is the flag `hasUnsavedChanges` (and
        // therefore the discard prompt and the unsaved indicator) actually
        // reads. This used to set a second dirty flag on the ProjectManager
        // that nothing anywhere read, so restoring an old version left the
        // document silently looking saved.
        markProjectDirty();
        await refresh();
      }
      return ok;
    },
    [root, refresh],
  );

  return { available: root != null, versions, loading, refresh, saveVersion, restore };
}
