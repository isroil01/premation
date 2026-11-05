/**
 * ProjectLoader — opens the routed cloud project () into the
 * booted editor and says when the editor may show it (projectOpenStore).
 *
 * A child of Providers, so it only mounts after the engine is ready.
 */

import { useEffect, useRef } from 'react';
import { getProjectManager, getFileManager } from '@core/services/coreServices';
import { ApiFileAdapter } from '@core/files/ApiFileAdapter';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { baselineHistoryEdit } from '@core/engine/historyBaseline';
import { useWorkspaceStore } from '@stores/index';
import { clearRecovery, readRecovery } from '@core/persistence/recovery';
import { takePendingFootage } from '@core/project/pendingFootage';
import { takePendingTemplate } from '@core/project/pendingTemplate';
import { takePendingRender } from '@core/project/pendingRender';
import { insertPremiumItem } from '@layout/EditorLayout/premiumInsertEdits';
import { clearLastFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';
import { setActiveCompFrameRateEdit } from '@layout/Composition/compositionEdits';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { markProjectShown } from '@stores/projectOpenStore';
import { useBootStageStore } from '@stores/bootStageStore';

/** Bumped by every routed open; only the latest may reveal the editor. */
let routeOpenSeq = 0;

/**
 * Close whatever the engine holds and wait for the mirror to show the empty
 * document. `close()` starts the engine's newProject without awaiting it, so
 * this waits for the mirror's next (re)load — or a few seconds, so a dead
 * engine never leaves the loading screen up for good.
 */
async function dropStaleDocument(): Promise<void> {
  const m = documentMirror();
  const generation = m.generation;
  await new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => {};
    const done = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, 3000);
    unsubscribe = m.subscribe(['doc', 'status'], () => {
      if (m.generation !== generation) done();
    });
    getProjectManager().close();
  });
  await m.whenIdle();
}

/**
 * Opens the:projectId project into the already-booted editor, once, through
 * the ProjectManager (not a raw restore) so it also becomes the *current*
 * project — meaning autosave and Save write back to THIS project id.
 */
export function ProjectLoader({ projectId }: { projectId: string }): null {
  const doneFor = useRef<string | null>(null);

  useEffect(() => {
    // Bind the cloud project id so version history / AI persistence can target it.
    useCloudProjectStore.getState().setProjectId(projectId ?? null);
    return () => useCloudProjectStore.getState().setProjectId(null);
  }, [projectId]);

  // Leaving the editor (or switching routed projects) un-shows the project, so
  // the next entry keeps its loading screen up until ITS document is in — the
  // engine and the mirror outlive this route and still hold this one.
  useEffect(() => () => markProjectShown(null), [projectId]);

  useEffect(() => {
    if (!projectId || doneFor.current === projectId) return;
    doneFor.current = projectId;
    if (readRecovery()?.projectId !== projectId) {
      clearRecovery();
    }
    let cancelled = false;
    // Only the latest open may reveal the editor: an earlier one still in
    // flight (the user left and came straight back) must not lift the loading
    // screen over a document that is about to be replaced.
    const seq = ++routeOpenSeq;
    const reveal = (): void => {
      if (seq !== routeOpenSeq) return;
      useBootStageStore.getState().finish('project');
      markProjectShown(projectId);
    };
    // The loading screen over the shell (ProjectOpenGate) names this stage.
    useBootStageStore.getState().begin('project');
    let opened = false;
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
        if (!ref) throw new Error(t('pages.editor.notFound', 'Project not found'));
        opened = true;
        // Everything below is deliberately NOT gated on `cancelled`. The load
        // is one-shot by construction (`doneFor`), and under React StrictMode
        // the dev double-mount runs cleanup (cancelled = true) on the FIRST
        // effect while `doneFor` blocks the second — so a cancelled-gate here
        // skipped this entire block on every dev open: openPath had already
        // restored the document (its side effects don't un-happen), but the
        // history baseline never reset and, worst, the "start from a video"
        // footage import silently vanished — a project created from an
        // uploaded clip opened as an EMPTY scene. Once the open has landed,
        // finishing the transition is strictly more correct than abandoning
        // it half-done, unmounted or not: these writes go to singleton
        // stores, not to this component.
        // The history baseline at this load boundary (history infrastructure, not an edit).
        void baselineHistoryEdit('Open');
        const ws = useWorkspaceStore.getState();
        if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, false);
        // The Footage viewer's memory is per-project-session: without this,
        // a freshly opened (even empty) project's Footage tab kept naming
        // whatever clip the PREVIOUS project last previewed.
        clearLastFootagePreview();
        // "Start from a video": the setup modal parked the chosen File; now
        // that THIS project is open and the engine is live, import it and
        // land it at full frame. One-shot by construction (`take` clears), so
        // a reload or a different project can never replay it. The modal
        // already conformed the comp to the clip's probed size/duration; the
        // editor's deeper probe refines fps afterwards when it can (the
        // browser cannot report a video's frame rate — see ImportedAsset).
        const footage = takePendingFootage();
        if (footage) {
          try {
            // The parked footage is a browser `File` (no path): imported from its bytes.
            const { imported: [asset] } = await importBrowserFilesEdit([{ file: footage }], 'Import Footage');
            if (!asset) throw new Error(t('pages.editor.footageUnreadable', 'the file could not be read or decoded'));
            await insertMediaEdit([asset]);
            const probedFps = asset.metadata?.fps;
            if (probedFps && probedFps > 0) await setActiveCompFrameRateEdit(probedFps);
          } catch (err) {
            useUIStore.getState().notify({
              level: 'warning',
              message: t('pages.editor.videoImportFailed', 'The project opened, but the video could not be imported: {error}', { error: (err as Error).message }),
              durationMs: 5000,
            });
          }
        }
        // Started from the dashboard's Library page: the project was created
        // for the item (a scene template at its own size), and it lands in
        // the still-empty comp.
        const template = takePendingTemplate();
        if (template) {
          const r = await insertPremiumItem(template);
          useUIStore.getState().notify({ level: r.ok ? 'success' : 'warning', message: r.message, durationMs: r.ok ? 2200 : 5000 });
        }
        // THIS project is in the engine and the mirror, with its parked video
        // or Library item placed: the editor may show it. Not earlier — a
        // project started from a video would flash its empty comp's cards.
        reveal();
        // Render from the dashboard's Renders page: the Export dialog, on this project.
        if (takePendingRender(projectId)) {
          // The mirror refetches after an open; the dialog describes the new document.
          await documentMirror().whenIdle();
          const settings = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
          openExportDialog(settingsDurationSeconds(settings), settingsFps(settings));
        }
      } catch (err) {
        // The open failed: the engine still holds the PREVIOUS document (the
        // last project, on a re-entry). Drop it before the loading screen
        // lifts, so the failure shows an empty editor, never the old project
        // under this one's route.
        if (seq === routeOpenSeq && !opened) await dropStaleDocument();
        if (cancelled) return;
        useUIStore.getState().notify({
          level: 'error',
          message: t('pages.editor.openFailed', "Couldn't open project: {error}", { error: (err as Error).message }),
          durationMs: 4000,
        });
      } finally {
        reveal();
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  return null;
}
