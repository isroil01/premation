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
import { ReadOnlyBanner } from '../components/ReadOnlyBanner';
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

import { Suspense, lazy, useState } from 'react';
import { LoadingScreen } from '@components/LoadingScreen';
import { StartScreen } from '@layout/Start/StartScreen';
import { cloudProjectsEnabled } from '@core/config/edition';

const LazyEditorShell = lazy(() => import('../App').then(m => ({ default: m.EditorShell })));

/**
 * The local edition's start screen, over the booted editor.
 *
 * Shown when there is no current project — which at boot is always, since
 * nothing creates one until the user does. The cloud edition has the dashboard
 * for this and never mounts it.
 *
 * Dismissal is session state, not a preference: closing it means "not now",
 * and a user who returns to an empty editor next launch should be offered
 * their recents again rather than having silently opted out forever.
 */
function LocalStart(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  // Read once at mount. This is the pre-project state by definition, and
  // subscribing would re-show the screen the moment a project is CLOSED —
  // mid-session, over a canvas the user is still looking at.
  const [hadProject] = useState(() => getProjectManager().getState().current !== null);
  if (cloudProjectsEnabled() || dismissed || hadProject) return null;
  return <StartScreen onDismiss={() => setDismissed(true)} />;
}

export function EditorPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Providers>
      <Suspense fallback={<LoadingScreen message="Loading editor…" />}>
        {projectId ? <ProjectLoader projectId={projectId} /> : null}
        {projectId ? <CloudAutosave projectId={projectId} /> : null}
        {projectId ? <CloudThumbnailWorker projectId={projectId} /> : null}
        {/*
          The read-only bar sits ABOVE the shell in a flex column so it pushes the
          editor down rather than floating over the canvas — a locked document is
          still a document the user needs to see all of. It renders nothing when
          the account can write (and always in the local edition), so this column
          is a plain full-height editor in the common case.
        */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <ReadOnlyBanner />
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <LazyEditorShell />
            <LocalStart />
          </div>
        </div>
      </Suspense>
    </Providers>
  );
}

export default EditorPage;
