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
import { EditorShell } from '../App';
import { getProjectManager, getFileManager } from '@core/services/coreServices';
import { getEventBus } from '@core/events/EventBus';
import { api } from '@core/api/client';
import { captureDocument } from '@core/api/cloudDocument';
import { renderThumbnailBlob } from '@core/export/exportManager';
import { useCompositionStore } from '@stores/compositionStore';
import { ApiFileAdapter } from '@core/files/ApiFileAdapter';
import { useUIStore } from '@stores/uiStore';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { useHistoryStore } from '@stores/historyStore';
import { useWorkspaceStore } from '@stores/index';
import { clearRecovery, readRecovery } from '@core/persistence/recovery';

/**
 * Opens the :projectId project into the already-booted editor, once, through
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
function CloudAutosave({ projectId }: { projectId: string }): null {
  useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const armTimer = setTimeout(() => { armed = true; }, 2000);

    const flush = async (): Promise<void> => {
      if (inFlight) { schedule(); return; } // coalesce while a save is running
      inFlight = true;
      try {
        await api.autosave(projectId, captureDocument());
        const ws = useWorkspaceStore.getState();
        if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, false);
        clearRecovery();
      } catch {
        /* offline / transient — the next edit will retry */
      } finally {
        inFlight = false;
      }
    };
    const schedule = (): void => {
      if (!armed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, 1200);
    };

    const bus = getEventBus();
    const subs = [
      bus.on('AnimationChanged', schedule),
      bus.on('NodeUpdated', schedule),
      bus.on('SceneGraphChanged', schedule),
      // Comp settings, timeline clips/markers/work area and motion blur don't
      // touch the scene graph, so without this they never reach the server.
      bus.on('DocumentChanged', schedule),
    ];
    return () => {
      clearTimeout(armTimer);
      if (timer) clearTimeout(timer);
      subs.forEach((s) => s.dispose());
    };
  }, [projectId]);

  return null;
}

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
const THUMBNAIL_MIN_INTERVAL_MS = 120_000;

function CloudThumbnail({ projectId }: { projectId: string }): null {
  useEffect(() => {
    let dirty = false;
    let capturing = false;
    let lastCapture = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const capture = async (): Promise<void> => {
      if (!dirty || capturing) return;
      capturing = true;
      dirty = false;
      lastCapture = Date.now();
      try {
        const c = useCompositionStore.getState();
        const blob = await renderThumbnailBlob({
          width: c.width,
          height: c.height,
          background: c.background,
          transparent: c.transparent,
        });
        if (blob) await api.setProjectThumbnail(projectId, blob);
      } catch {
        /* a preview is a nicety — never surface this */
      } finally {
        capturing = false;
      }
    };

    const onChange = (): void => {
      dirty = true;
      if (timer) return;
      const wait = Math.max(0, THUMBNAIL_MIN_INTERVAL_MS - (Date.now() - lastCapture));
      timer = setTimeout(() => {
        timer = undefined;
        void capture();
      }, wait);
    };

    const bus = getEventBus();
    const subs = [
      bus.on('AnimationChanged', onChange),
      bus.on('SceneGraphChanged', onChange),
    ];

    return () => {
      if (timer) clearTimeout(timer);
      subs.forEach((s) => s.dispose());
      // One last frame on the way out. This is a normal SPA unmount, so the
      // upload still completes; on a hard tab close it won't, and that's fine.
      void capture();
    };
  }, [projectId]);

  return null;
}

export function EditorPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Providers>
      {projectId ? <ProjectLoader projectId={projectId} /> : null}
      {projectId ? <CloudAutosave projectId={projectId} /> : null}
      {projectId ? <CloudThumbnail projectId={projectId} /> : null}
      <EditorShell />
    </Providers>
  );
}

export default EditorPage;
