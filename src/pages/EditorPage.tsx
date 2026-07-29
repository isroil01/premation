/**
 * EditorPage — the routed editor at /editor/:projectId. It mounts the full
 * editor (Providers boots the engine, EditorShell is the UI) and, once booted,
 * loads the requested cloud project's document into the running editor.
 *
 * ProjectLoader is a child of Providers, so it only mounts after the engine is
 * ready (Providers gates its children behind a loading screen) — meaning
 * restoreDocument runs against a live scene graph.
 */

import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Providers } from '@providers/Providers';
import { CloudThumbnailWorker } from '../components/CloudThumbnailWorker';
import { getProjectManager, getFileManager } from '@core/services/coreServices';
import { CloudAutosave } from '../components/CloudAutosave';
import { ApiFileAdapter } from '@core/files/ApiFileAdapter';
import { useUIStore } from '@stores/uiStore';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { useHistoryStore } from '@stores/historyStore';
import { useWorkspaceStore } from '@stores/index';
import { clearRecovery, readRecovery } from '@core/persistence/recovery';

/**
 * Opens the:projectId project into the already-booted editor, once, through
 * the ProjectManager (not a raw restore) so it also becomes the *current*
 * project — meaning autosave and Save write back to THIS project id.
 */
function ProjectLoader({ projectId }: { projectId: string }): null {
  const doneFor = useRef<string | null>(null);

  useEffect(() => {
    // Bind the cloud project id so version history / AI persistence can target it.
    useCloudProjectStore.getState().setProjectId(projectId ?? null);
    return () => useCloudProjectStore.getState().setProjectId(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || doneFor.current === projectId) return;
    doneFor.current = projectId;
    if (readRecovery()?.projectId !== projectId) {
      clearRecovery();
    }
    let cancelled = false;
    (async () => {
      try {
        // Cloud projects live in motion-back, so the ProjectManager must read
        // through the API adapter. It ships uninstalled (the FileManager defaults
        // to the browser/local adapter), which made every cloud open fail with
        // "Project not found" — install it here before opening.
        if (getFileManager().environment !== 'api') {
          getFileManager().setAdapter(new ApiFileAdapter());
        }
        const ref = await getProjectManager().openPath(projectId);
        if (!cancelled && !ref) throw new Error('Project not found');
        if (!cancelled) {
          useHistoryStore.getState().reset();
          useHistoryStore.getState().record('Open', true);
          const ws = useWorkspaceStore.getState();
          if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, false);
        }
      } catch (err) {
        if (cancelled) return;
        useUIStore.getState().notify({
          level: 'error',
          message: `Couldn't open project: ${(err as Error).message}`,
          durationMs: 4000,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  return null;
}

/**
 * Persists edits to the bound cloud project. Debounces the editor's change
 * events and PUTs the whole document to /projects/:id/autosave (which bumps the
 * revision and keeps a rolling snapshot). Armed after a short settle so the
 * project's own load doesn't immediately re-save it.
 */
// Imported CloudAutosave component replaces the inline implementation

/**
 * Keeps the project's poster frame current.
 *
 * Deliberately NOT on the autosave beat: that fires ~1.2s after every edit, and
 * rendering plus uploading a frame that often would cost far more than a card
 * picture is worth. Instead it rides the same change events but at a floor of
 * two minutes, and takes one final frame when you leave the editor — so the
 * card reflects where you actually stopped.
 *
 * Failure is silent by design. A missing preview costs the user a nice
 * thumbnail; an error toast about one costs them their attention.
 */
// CloudThumbnail removed; using worker component instead

import { Suspense, lazy } from 'react';
import { LoadingScreen } from '@components/LoadingScreen';

const LazyEditorShell = lazy(() => import('../App').then(m => ({ default: m.EditorShell })));

export function EditorPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Providers>
      <Suspense fallback={<LoadingScreen message="Loading editor…" />}>
        {projectId ? <ProjectLoader projectId={projectId} /> : null}
        {projectId ? <CloudAutosave projectId={projectId} /> : null}
        {projectId ? <CloudThumbnailWorker projectId={projectId} /> : null}
        <LazyEditorShell />
      </Suspense>
    </Providers>
  );
}

export default EditorPage;
