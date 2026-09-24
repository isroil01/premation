/**
 * useProjectVersions — the React seam for a version-history panel (local-first).
 *
 * Wraps the tested bundle version helpers (`listProjectVersions` /
 * `saveProjectBundleVersion` / `readProjectVersion`) and binds them to the
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
import { edit } from '@core/engine/uiEdits';
import { isLocalFirst } from '@core/config/flags';
import {
  isBundlePath,
  listProjectVersions,
  saveProjectBundleVersion,
  readProjectVersion,
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
      const doc = await readProjectVersion(root, rev);
      if (!doc) return false;
      // The version lands through the engine as ONE undoable entry (B3z
      // `restoreDocument`): the History panel shows it, undo brings back the
      // document the user had, and the engine's dirty state follows the edit.
      const res = await edit(`Restore v${rev}`, {
        type: 'restoreDocument',
        document: new TextEncoder().encode(JSON.stringify(doc)),
        label: `Restore v${rev}`,
      });
      const ok = res.ok;
      if (ok) {
        // Mark the WORKSPACE tab, which is the flag `hasUnsavedChanges` (and
        // therefore the discard prompt and the unsaved indicator) reads.
        markProjectDirty();
        await refresh();
      }
      return ok;
    },
    [root, refresh],
  );

  return { available: root != null, versions, loading, refresh, saveVersion, restore };
}
