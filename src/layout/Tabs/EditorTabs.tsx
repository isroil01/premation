/**
 * The main body's tab strip, and the body it controls.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: Scene is always mounted.
 *
 * Scene owns a WebGL/WebGPU context, the playback position and the viewport
 * transform. Rendering it conditionally — `{active === 'scene' && <Scene/>}`,
 * which is the obvious way to write a tab switcher — destroys all three every
 * time the user opens the Layer panel, and re-acquiring a GPU context is both
 * visibly slow and, on some drivers, not guaranteed to succeed. So Scene is
 * rendered unconditionally and hidden with CSS, and the Layer panel is drawn
 * over it.
 *
 * (Until 0.9 this strip also held JavaScript plugins' pages as closable tabs.
 * Since 2026-11 it holds native plugins' pages again — "Plugin: <name>", one
 * closable tab per plugin, opened from the Plugins sidebar
 * (stores/pluginPageStore.ts). Like the Layer and Footage panels they are
 * drawn over the composition viewer, which stays mounted. Ctrl/Cmd+W closes
 * the plugin page in front and never falls through to closing the window.)
 *
 * `visibility: hidden`, not `display: none`: `display: none` collapses the
 * box, the canvas inside resizes to zero, and returning to Scene gives a black
 * stage until something forces a resize. This editor has had that bug before.
 */

import { Suspense, lazy, useEffect, useMemo, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useActiveCompName } from '@layout/Composition/activeCompName';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useLayerViewerStore } from '@stores/layerViewerStore';
import { canOpenInLayerPanel, openLayerPanel } from '@layout/LayerViewer/openLayer';
import { LayerViewer } from '@layout/LayerViewer/LayerViewer';
import { FootageViewer } from '@layout/Assets/FootageViewer';
import { useFootageViewerStore } from '@stores/footageViewerStore';
import { usePluginPageStore } from '@stores/pluginPageStore';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompId, useActiveMirrorComp, useMirrorComp, useMirrorItems, useMirrorLayer } from '@hooks/useMirror';
import { itemAsset } from '@core/mirror/itemAssets';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { openFootagePreview, useLastFootagePreview, clearLastFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { deleteCompositionEdit, deleteCompositionWarning } from '@layout/Scene/sceneEdits';
import { customConfirm } from '@components/Modal';
import { popOutViewport } from '@layout/Workspace/ViewportDisplayControls';
import { t } from '@core/i18n';
import styles from './EditorTabs.module.css';

// A plugin's page pulls in the store's page pieces (markdown, gallery): loaded
// the first time one opens, not with the editor.
const PluginDetailPage = lazy(() => import('@layout/Plugins/PluginDetailPage'));

/**
 * The × on an open Layer / Footage tab. A span with a button role: the tab is
 * itself a <button>, and a button inside a button is not valid markup.
 * `label` is the whole accessible name ("Close the Footage viewer").
 */
function TabClose({ label, onClose }: { label: string; onClose: () => void }): JSX.Element {
  return (
    <span
      role="button"
      tabIndex={0}
      className={styles.tabClose}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <Icon name="close" size="sm" />
    </span>
  );
}

export interface EditorTabsProps {
  /** The viewport. Rendered once, always, and never unmounted by this component. */
  scene: ReactNode;
}

export function EditorTabs({ scene }: EditorTabsProps): JSX.Element {
  // A pristine, never-adopted, still-empty comp is the AE fresh-project state
  // — the engine keeps a root under the hood. Drawing into it makes it real by
  // use, flag or no flag.
  const rawCompName = useActiveMirrorComp()?.settings.name ?? '';
  const activeMirrorComp = useMirrorComp(useActiveCompId());
  const activePristine = activeMirrorComp?.settings.pristine === true && activeMirrorComp.layers.length === 0;
  // The TAB names whichever comp is active — pristine or not. It used to read
  // "Composition (none)" for a pristine comp, while the timeline tab, the
  // status bar and Composition Settings all named the very comp it was
  // showing ("Composition 1"): a viewer that says it has nothing open, open on
  // something. "(none)" is now only what it says — no active composition.
  // `activePristine` still gates the comp-only menu entries below.
  const activeCompName = useActiveCompName();
  const compName = activeCompName ?? rawCompName;
  // Unsaved edits on the active comp's tab — the same flag the discard prompt
  // and ProjectStatus read, so the three can never disagree.
  const activeDirty = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.dirty === true : false));

  // Footage tab = source viewer (AE Footage panel).
  //
  // Sticky last-preview used to WIN over the current selection, so previewing
  // an image once left the tab permanently labelled with that image — even
  // after you selected a video layer or moved on. That felt "stuck".
  //
  // Priority now: live selected layer source → sticky last preview (if still
  // in the library) → none. Images ARE footage items in AE (stills), so they
  // can appear here; they just must not block the live selection.
  const lastPreviewed = useLastFootagePreview((s) => s.asset);
  const selectionIds = useSelectionStore((s) => s.ids);
  // B4: the Footage viewer opens the item as the page's asset record, built from the mirror's ItemInfo
  // (`mediaUrl` is what it plays; the probe's media type labels it).
  const items = useMirrorItems();
  const singleSelectedLayer = selectionIds.length === 1 ? selectionIds[0]! : null;
  const selectedLayerInfo = useMirrorLayer(singleSelectedLayer);
  const sourceInfo = selectedLayerInfo?.source ? items.get(selectedLayerInfo.source) : undefined;
  const selectedMedia = useMemo(() => (sourceInfo ? itemAsset(sourceInfo) : null), [sourceInfo]);
  const stickyValid =
    lastPreviewed && items.get(lastPreviewed.id)?.kind === 'footage' ? lastPreviewed : null;
  const footageAsset = selectedMedia ?? stickyValid;

  // Drop a sticky label whose asset was deleted from the library.
  useEffect(() => {
    // (Only once the mirror has the document: before that every item reads as gone.)
    if (lastPreviewed && documentMirror().status === 'ready' && items.get(lastPreviewed.id)?.kind !== 'footage') {
      clearLastFootagePreview();
    }
  }, [items, lastPreviewed]);
  // AE's Layer panel (LayerViewer): open while its layer still exists.
  const layerViewerId = useLayerViewerStore((s) => s.nodeId);
  const layerViewerInfo = useMirrorLayer(layerViewerId);
  const layerViewerOpen = layerViewerId !== null && !!layerViewerInfo;
  const selectedViewable = selectedLayerInfo !== undefined && canOpenInLayerPanel(selectedLayerInfo.id);
  const layerTabName = layerViewerOpen
    ? layerViewerInfo?.name ?? null
    : singleSelectedLayer
      ? selectedLayerInfo?.name ?? null
      : null;
  // AE's Footage panel (FootageViewer): open while there is a file to show.
  // The Layer panel wins if both are somehow up — one viewer tab at a time.
  const footageOpen = useFootageViewerStore((s) => s.open) && !!footageAsset && !layerViewerOpen;
  // Plugin pages: closable tabs drawn over the viewers (which stay as they were).
  const pluginPages = usePluginPageStore((s) => s.pages);
  const activePluginId = usePluginPageStore((s) => s.active);
  const activePluginPage = pluginPages.find((p) => p.id === activePluginId) ?? null;
  const pluginActive = activePluginPage !== null;
  const compActive = !layerViewerOpen && !footageOpen && !pluginActive;
  const footageShown = footageOpen && !pluginActive;
  const layerShown = layerViewerOpen && !pluginActive;
  const closeViewerTabs = (): void => {
    useLayerViewerStore.getState().close();
    useFootageViewerStore.getState().close();
    usePluginPageStore.getState().activate(null);
  };
  const viewMode = useWorkspaceViewStore((s) => s.mode);

  /**
   * Ctrl/Cmd+W closes the plugin page in front, and otherwise does nothing —
   * deliberately.
   *
   * Scene is never closeable, and letting the key fall through would reach
   * the browser/Electron default of closing the window. Someone reaching for
   * "close this tab" with the viewport focused must not lose their session.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w')) return;
      e.preventDefault();
      const pages = usePluginPageStore.getState();
      if (pages.active !== null && !e.repeat) pages.close(pages.active);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.strip} role="tablist" aria-label={t('tabs.editor.strip', 'Editor tabs')}>
        <div className={styles.tabs}>
        {/*
          Composition's tab, labelled with the COMPOSITION's name like After Effects:
          "Composition: <compName>" or "Composition (none)"
        */}
        <button
          type="button"
          role="tab"
          aria-selected={compActive}
          className={cn(styles.tab, compActive && styles.tabActive)}
          title={activeDirty
            ? t('tabs.editor.compTitleDirty', 'Composition: {name} — unsaved changes', { name: compName || t('tabs.editor.none', 'none') })
            : t('tabs.editor.compTitle', 'Composition: {name}', { name: compName || t('tabs.editor.none', 'none') })}
          onClick={() => {
            // Back to the composition from the Layer or Footage viewer.
            closeViewerTabs();
          }}
          onContextMenu={(e) => {
            // AE's viewer menu: ONE Composition viewer, switched between the
            // open comps from here (each also has a Timeline tab).
            e.preventDefault();
            const st = useProjectStore.getState();
            const open = st.tabOrder.map((id) => st.tabs[id]).filter((tab): tab is NonNullable<typeof tab> => !!tab);
            if (open.length === 0) return;
            const active = st.activeTabId ? st.tabs[st.activeTabId] : undefined;
            openContextMenu(e.clientX, e.clientY, [
              ...open.map((tab) => ({
                id: `open-${tab.id}`,
                label: st.comps[tab.compositionId]?.name ?? documentMirror().layer(tab.compositionId)?.name ?? tab.title,
                icon: tab.id === st.activeTabId ? ('check' as const) : undefined,
                onSelect: () => {
                  useProjectStore.getState().actions.setActiveTab(tab.id);
                },
              })),
              { id: 'sep-open', separator: true },
              {
                id: 'close-comp',
                label: active
                  ? t('tabs.editor.closeNamed', 'Close {name}', { name: st.comps[active.compositionId]?.name ?? active.title })
                  : t('tabs.editor.closeComposition', 'Close Composition'),
                disabled: !active || open.length < 2,
                onSelect: () => { if (active) useProjectStore.getState().actions.closeTab(active.id); },
              },
            ]);
          }}
        >
          <Icon name="shape" size="sm" />
          <span className={styles.tabLabel}>
            {compName ? t('tabs.editor.compTitle', 'Composition: {name}', { name: compName }) : t('tabs.editor.compNone', 'Composition: (none)')}
          </span>
          {/* The dirty dot. Decorative for AT: the tab's `title` and the
              accessible name below carry it as words. */}
          {activeDirty ? (
            <span className={styles.dirtyDot} data-testid="comp-dirty-dot" role="img" aria-label={t('tabs.editor.unsaved', 'Unsaved changes')} />
          ) : null}
        </button>

        {/*
          AE's Footage and Layer viewer tabs.

          FOOTAGE is the source viewer: the selected layer's media when one is
          selected, otherwise the last asset opened in the preview dialog.
          Images and video are both "footage" in AE; the tab is not stuck on
          the last preview when a different layer is selected.

          LAYER is Focus Mode isolate.
        */}
        <button
          type="button"
          role="tab"
          aria-selected={footageShown}
          className={cn(styles.tab, footageShown && styles.tabActive)}
          disabled={!footageAsset}
          title={
            footageAsset
              ? footageAsset.type === 'image'
                ? t('tabs.editor.footageStill', 'Footage: {name} (still)', { name: footageAsset.name })
                : footageAsset.type === 'audio'
                  ? t('tabs.editor.footageAudio', 'Footage: {name} (audio)', { name: footageAsset.name })
                  : t('tabs.editor.footage', 'Footage: {name}', { name: footageAsset.name })
              : t('tabs.editor.footageNoneTitle', 'Footage (none) — double-click a clip in Assets, or select a media layer')
          }
          onClick={() => {
            if (footageOpen) {
              usePluginPageStore.getState().activate(null);
              return;
            }
            if (footageAsset) openFootagePreview(footageAsset);
          }}
          onContextMenu={(e) => {
            if (!footageAsset) return;
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, [
              {
                id: 'clear-footage',
                label: t('tabs.editor.clearFootage', 'Clear Footage Viewer'),
                onSelect: () => {
                  useFootageViewerStore.getState().close();
                  clearLastFootagePreview();
                  // If the tab is driven by the current layer selection, clear
                  // that too — otherwise Clear would appear to do nothing.
                  if (selectedMedia) useSelectionStore.getState().clear();
                },
              },
            ]);
          }}
        >
          <Icon name="media" size="sm" />
          <span className={styles.tabLabel}>
            {footageAsset ? t('tabs.editor.footage', 'Footage: {name}', { name: footageAsset.name }) : t('tabs.editor.footageNone', 'Footage: (none)')}
          </span>
          {footageOpen && (
            <TabClose label={t('tabs.editor.closeFootageViewer', 'Close the Footage viewer')} onClose={() => useFootageViewerStore.getState().close()} />
          )}
        </button>

        {/*
          LAYER is AE's Layer panel (LayerViewer): the layer alone, before its
          transform, with its own In/Out. Opens for the selected footage,
          solid or composition layer; clicking it again goes back to the
          composition.
        */}
        <button
          type="button"
          role="tab"
          aria-selected={layerShown}
          className={cn(styles.tab, layerShown && styles.tabActive)}
          disabled={!layerViewerOpen && !selectedViewable}
          title={
            layerViewerOpen
              ? t('tabs.editor.layer', 'Layer: {name}', { name: layerTabName ?? '' })
              : selectedViewable
                ? t('tabs.editor.openInLayerPanel', 'Open “{name}” in the Layer panel', { name: layerTabName ?? '' })
                : t('tabs.editor.layerNoneTitle', 'Layer (none) — select a footage, solid or composition layer')
          }
          onClick={() => {
            if (layerViewerOpen) {
              usePluginPageStore.getState().activate(null);
              return;
            }
            if (singleSelectedLayer) openLayerPanel(singleSelectedLayer);
          }}
        >
          <Icon name="layers" size="sm" />
          <span className={styles.tabLabel}>
            {layerTabName ? t('tabs.editor.layer', 'Layer: {name}', { name: layerTabName }) : t('tabs.editor.layerNone', 'Layer: (none)')}
          </span>
          {layerViewerOpen && (
            <TabClose label={t('tabs.editor.closeLayerViewer', 'Close the Layer viewer')} onClose={() => useLayerViewerStore.getState().close()} />
          )}
        </button>

        {/*
          Plugin pages, opened from the Plugins sidebar: one closable tab per
          plugin (reopening brings the same tab forward). Middle-click closes.
        */}
        {pluginPages.map((page) => {
          const active = page.id === activePluginId;
          const label = t('tabs.editor.plugin', 'Plugin: {name}', { name: page.name });
          return (
            <button
              key={page.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={cn(styles.tab, active && styles.tabActive)}
              title={label}
              data-testid={`plugin-tab-${page.id}`}
              onClick={() => usePluginPageStore.getState().activate(page.id)}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                usePluginPageStore.getState().close(page.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const store = usePluginPageStore.getState();
                openContextMenu(e.clientX, e.clientY, [
                  { id: 'close', label: t('tabs.editor.closeTab', 'Close'), onSelect: () => store.close(page.id) },
                  {
                    id: 'close-others',
                    label: t('tabs.editor.closeOtherPluginPages', 'Close Other Plugin Pages'),
                    disabled: store.pages.length < 2,
                    onSelect: () => {
                      for (const other of usePluginPageStore.getState().pages) if (other.id !== page.id) store.close(other.id);
                    },
                  },
                  {
                    id: 'close-all',
                    label: t('tabs.editor.closeAllPluginPages', 'Close All Plugin Pages'),
                    onSelect: () => {
                      for (const other of usePluginPageStore.getState().pages) store.close(other.id);
                    },
                  },
                ]);
              }}
            >
              <Icon name="plugin" size="sm" />
              <span className={styles.tabLabel}>{label}</span>
              <TabClose
                label={t('tabs.editor.closePluginPage', 'Close the {name} page', { name: page.name })}
                onClose={() => usePluginPageStore.getState().close(page.id)}
              />
            </button>
          );
        })}

        </div>

        <div className={styles.panelActions}>
          {/*
            Only the panel's own two actions here: the lock and the menu. The
            viewport's display controls sat before the lock for a while and
            made this end of the row a wall of buttons; they are in the
            transport row under the stage now (`Workspace/TransportBar.tsx`),
            and Pop Out is a row of this menu.
          */}
          {/* View lock — the workspace's fixed/free camera mode. Fixed frames
              and centres the comp and disables panning; free is the infinite
              canvas. The button reflects the live mode. */}
          <button
            type="button"
            className={viewMode === 'fixed' ? `${styles.panelActionBtn} ${styles.panelActionBtnOn}` : styles.panelActionBtn}
            title={viewMode === 'fixed'
              ? t('tabs.editor.viewLockedTitle', 'View locked (comp framed & centred) — click to unlock')
              : t('tabs.editor.lockViewTitle', 'Lock view — frame the comp and disable panning')}
            aria-label={t('tabs.editor.lockView', 'Lock view')}
            aria-pressed={viewMode === 'fixed'}
            onClick={() => useWorkspaceViewStore.getState().toggleMode()}
          >
            <Icon name="lock" size="sm" />
          </button>
          <button
            type="button"
            className={styles.panelActionBtn}
            title={t('tabs.editor.panelMenu', 'Composition panel menu')}
            aria-label={t('tabs.editor.panelMenu', 'Composition panel menu')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openContextMenu(r.left, r.bottom + 4, [
                { id: 'new-comp', label: t('tabs.editor.newComposition', 'New Composition…'), onSelect: () => openNewCompositionDialog() },
                { id: 'settings', label: t('tabs.editor.compositionSettings', 'Composition Settings…'), onSelect: () => openCompositionSettings() },
                { id: 'sep', separator: true },
                {
                  id: 'fit',
                  label: t('tabs.editor.fitInView', 'Fit Composition in View'),
                  onSelect: () => {
                    try { getWorkspaceController().fitComposition(); getWorkspaceController().requestRender(); } catch { /* engine not ready */ }
                  },
                },
                // Pop the viewer into its own window — AE's panel-menu Undock;
                // it was a button in the transport row (2026-10-07). The lock
                // is the button beside this menu, so it is not a row here too.
                { id: 'pop-out', label: t('tabs.editor.popOut', 'Pop Out Viewer'), icon: 'pop-out', onSelect: popOutViewport },
                { id: 'sep2', separator: true },
                {
                  id: 'delete-comp',
                  label: t('tabs.editor.deleteComposition', 'Delete Composition'),
                  icon: 'trash',
                  danger: true,
                  // "(none)" — the pristine empty state — has nothing to
                  // delete; every real comp, including an empty one and the
                  // last one, deletes (the last lands back on this state).
                  disabled: activePristine || !useProjectStore.getState().activeTabId,
                  onSelect: async () => {
                    const st = useProjectStore.getState();
                    const compId = st.activeTabId ? st.tabs[st.activeTabId]?.compositionId : undefined;
                    if (!compId) return;
                    const comp = st.comps[compId];
                    const warn = deleteCompositionWarning(comp?.name ?? t('tabs.editor.thisComposition', 'this composition'), compId);
                    if (await customConfirm(t('tabs.editor.deleteComposition', 'Delete Composition'), warn, { isDanger: true, confirmLabel: t('tabs.editor.delete', 'Delete') })) {
                      await deleteCompositionEdit(compId);
                    }
                  },
                },
              ]);
            }}
          >
            <Icon name="menu" size="sm" />
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {/*
          UNCONDITIONAL. Do not wrap this in `{!layerViewerOpen && …}`.
          The GPU context, playback state and viewport transform live in here,
          and all three are lost the moment it leaves the tree.
        */}
        <div
          className={cn(styles.scenePane, !compActive && styles.sceneHidden)}
          aria-hidden={!compActive}
          data-testid="scene-pane"
        >
          {scene}
        </div>

        {/* AE's Layer panel, over the composition viewer — which stays mounted
            and is only hidden. */}
        {layerShown && (
          <div className={styles.tabPane} role="tabpanel" aria-label={t('tabs.editor.layerPanel', 'Layer panel')} data-testid="layer-pane">
            <LayerViewer />
          </div>
        )}

        {/* AE's Footage panel: the source file on its own, likewise over the
            (still mounted) composition viewer. */}
        {footageShown && footageAsset && (
          <div className={styles.tabPane} role="tabpanel" aria-label={t('tabs.editor.footagePanel', 'Footage panel')} data-testid="footage-pane">
            <FootageViewer asset={footageAsset} />
          </div>
        )}

        {/* A plugin's page, likewise over the (still mounted) viewers; keyed
            by plugin so switching pages starts each on its Details tab. */}
        {activePluginPage && (
          <div
            className={styles.tabPane}
            role="tabpanel"
            aria-label={t('tabs.editor.plugin', 'Plugin: {name}', { name: activePluginPage.name })}
            data-testid="plugin-pane"
          >
            <Suspense fallback={null}>
              <PluginDetailPage
                key={activePluginPage.id}
                id={activePluginPage.id}
                name={activePluginPage.name}
                owner={activePluginPage.owner}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
