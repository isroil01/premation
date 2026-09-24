/**
 * The main body's tab strip, and the body it controls.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: Scene is always mounted.
 *
 * Scene owns a WebGL/WebGPU context, the playback position and the viewport
 * transform. Rendering it conditionally — `{active === 'scene' && <Scene/>}`,
 * which is the obvious way to write a tab switcher — destroys all three every
 * time the user opens a plugin page, and re-acquiring a GPU context is both
 * visibly slow and, on some drivers, not guaranteed to succeed. So Scene is
 * rendered unconditionally and hidden with CSS, and the other tabs are drawn
 * over it.
 *
 * `visibility: hidden`, not `display: none`: `display: none` collapses the
 * box, the canvas inside resizes to zero, and returning to Scene gives a black
 * stage until something forces a resize. This editor has had that bug before.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDismissOnOutside } from '@hooks/useDismissOnOutside';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { SCENE_TAB_ID, useEditorTabStore, type EditorTab } from '@stores/editorTabStore';
import { useActiveCompName } from '@layout/Composition/activeCompName';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore } from '@stores/assetStore';
import { useLayerViewerStore } from '@stores/layerViewerStore';
import { canOpenInLayerPanel, openLayerPanel } from '@layout/LayerViewer/openLayer';
import { LayerViewer } from '@layout/LayerViewer/LayerViewer';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompId, useActiveMirrorComp, useMirrorComp, useMirrorLayer } from '@hooks/useMirror';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { openFootagePreview, useLastFootagePreview, clearLastFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { deleteCompositionEdit, deleteCompositionWarning } from '@layout/Scene/sceneEdits';
import { customConfirm } from '@components/Modal';
import styles from './EditorTabs.module.css';

export interface EditorTabsProps {
  /** The viewport. Rendered once, always, and never unmounted by this component. */
  scene: ReactNode;
  /** Draw the body of a non-Scene tab. */
  renderTab: (tab: EditorTab) => ReactNode;
}

export function EditorTabs({ scene, renderTab }: EditorTabsProps): JSX.Element {
  const tabs = useEditorTabStore((s) => s.tabs);
  const activeId = useEditorTabStore((s) => s.activeId);
  const activate = useEditorTabStore((s) => s.activate);
  const close = useEditorTabStore((s) => s.close);
  const pin = useEditorTabStore((s) => s.pin);
  const focusRelative = useEditorTabStore((s) => s.focusRelative);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const closeOverflow = useCallback(() => setOverflowOpen(false), []);
  // Click anywhere else, or Escape, puts the menu away — the chevron was the
  // only thing that could close it before.
  useDismissOnOutside(overflowOpen, [overflowBtnRef, overflowMenuRef], closeOverflow);

  const activeTab = tabs.find((t) => t.id === activeId);
  const sceneActive = activeId === SCENE_TAB_ID;
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
  const assets = useAssetStore((s) => s.assets);
  const singleSelectedLayer = selectionIds.length === 1 ? selectionIds[0]! : null;
  const selectedLayerInfo = useMirrorLayer(singleSelectedLayer);
  const selectedAsset = (() => {
    const assetId = selectedLayerInfo?.source;
    return assetId ? assets.find((a) => a.id === assetId) ?? null : null;
  })();
  const selectedMedia =
    selectedAsset
    && (selectedAsset.type === 'video' || selectedAsset.type === 'image' || selectedAsset.type === 'audio')
      ? selectedAsset
      : null;
  const stickyValid =
    lastPreviewed && assets.some((a) => a.id === lastPreviewed.id) ? lastPreviewed : null;
  const footageAsset = selectedMedia ?? stickyValid;

  // Drop a sticky label whose asset was deleted from the library.
  useEffect(() => {
    if (lastPreviewed && !assets.some((a) => a.id === lastPreviewed.id)) {
      clearLastFootagePreview();
    }
  }, [assets, lastPreviewed]);
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
  const viewMode = useWorkspaceViewStore((s) => s.mode);

  /**
   * Ctrl/Cmd+W closes the active tab — and never Scene.
   *
   * Scene is not closeable, so with Scene focused this must do NOTHING rather
   * than fall through to the next handler or, worse, to the browser/Electron
   * default of closing the window. Someone reaching for "close this tab" with
   * the viewport focused must not lose their session.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const current = useEditorTabStore.getState().activeId;
        if (current !== SCENE_TAB_ID) close(current);
        return;
      }
      // Arrow navigation only while the strip itself has focus, or every left
      // arrow on the canvas would move a tab.
      if (!stripRef.current?.contains(document.activeElement)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); focusRelative(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); focusRelative(-1); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, focusRelative]);

  /** Middle click closes, the way it does in every other tab strip. */
  const onAuxClick = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button === 1) { e.preventDefault(); close(id); }
  }, [close]);

  return (
    <div className={styles.root}>
      <div className={styles.strip} role="tablist" aria-label="Editor tabs" ref={stripRef}>
        <div className={styles.tabs}>
        {/*
          Composition's tab, labelled with the COMPOSITION's name like After Effects:
          "Composition: <compName>" or "Composition (none)"
        */}
        <button
          type="button"
          role="tab"
          aria-selected={sceneActive && !layerViewerOpen}
          className={cn(styles.tab, sceneActive && !layerViewerOpen && styles.tabActive)}
          title={`Composition: ${compName || 'none'}${activeDirty ? ' — unsaved changes' : ''}`}
          onClick={() => {
            // Back to the composition — from a plugin tab or the Layer panel.
            useLayerViewerStore.getState().close();
            activate(SCENE_TAB_ID);
          }}
          onContextMenu={(e) => {
            // AE's viewer menu: ONE Composition viewer, switched between the
            // open comps from here (each also has a Timeline tab).
            e.preventDefault();
            const st = useProjectStore.getState();
            const open = st.tabOrder.map((id) => st.tabs[id]).filter((t): t is NonNullable<typeof t> => !!t);
            if (open.length === 0) return;
            const active = st.activeTabId ? st.tabs[st.activeTabId] : undefined;
            openContextMenu(e.clientX, e.clientY, [
              ...open.map((t) => ({
                id: `open-${t.id}`,
                label: st.comps[t.compositionId]?.name ?? documentMirror().layer(t.compositionId)?.name ?? t.title,
                icon: t.id === st.activeTabId ? ('check' as const) : undefined,
                onSelect: () => {
                  activate(SCENE_TAB_ID);
                  useProjectStore.getState().actions.setActiveTab(t.id);
                },
              })),
              { id: 'sep-open', separator: true },
              {
                id: 'close-comp',
                label: active ? `Close ${st.comps[active.compositionId]?.name ?? active.title}` : 'Close Composition',
                disabled: !active || open.length < 2,
                onSelect: () => { if (active) useProjectStore.getState().actions.closeTab(active.id); },
              },
            ]);
          }}
        >
          <Icon name="shape" size="sm" />
          <span className={styles.tabLabel}>Composition {compName ? `(${compName})` : '(none)'}</span>
          {/* The dirty dot. Decorative for AT: the tab's `title` and the
              accessible name below carry it as words. */}
          {activeDirty ? (
            <span className={styles.dirtyDot} data-testid="comp-dirty-dot" role="img" aria-label="Unsaved changes" />
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
          aria-selected={false}
          className={styles.tab}
          disabled={!footageAsset}
          title={
            footageAsset
              ? `Footage: ${footageAsset.name}${footageAsset.type === 'image' ? ' (still)' : footageAsset.type === 'audio' ? ' (audio)' : ''}`
              : 'Footage (none) — double-click a clip in Assets, or select a media layer'
          }
          onClick={() => { if (footageAsset) openFootagePreview(footageAsset); }}
          onContextMenu={(e) => {
            if (!footageAsset) return;
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, [
              {
                id: 'clear-footage',
                label: 'Clear Footage Viewer',
                onSelect: () => {
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
          <span className={styles.tabLabel}>Footage {footageAsset ? `(${footageAsset.name})` : '(none)'}</span>
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
          aria-selected={layerViewerOpen}
          className={cn(styles.tab, layerViewerOpen && styles.tabActive)}
          disabled={!layerViewerOpen && !selectedViewable}
          title={
            layerViewerOpen
              ? `Layer: ${layerTabName ?? ''} — click to go back to the composition`
              : selectedViewable
                ? `Open “${layerTabName ?? ''}” in the Layer panel`
                : 'Layer (none) — select a footage, solid or composition layer'
          }
          onClick={() => {
            if (layerViewerOpen) { useLayerViewerStore.getState().close(); return; }
            if (singleSelectedLayer) {
              activate(SCENE_TAB_ID);
              openLayerPanel(singleSelectedLayer);
            }
          }}
        >
          <Icon name="layers" size="sm" />
          <span className={styles.tabLabel}>Layer {layerTabName ? `(${layerTabName})` : '(none)'}</span>
        </button>

        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            className={cn(
              styles.tab,
              tab.id === activeId && styles.tabActive,
              tab.preview && styles.tabPreview,
            )}
            title={tab.title}
            onClick={() => activate(tab.id)}
            onDoubleClick={() => pin(tab.id)}
            onAuxClick={(e) => onAuxClick(e, tab.id)}
          >
            <Icon name="plugin" size="sm" />
            <span className={styles.tabLabel}>{tab.title}</span>
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Close ${tab.title}`}
              className={styles.close}
              onClick={(e) => { e.stopPropagation(); close(tab.id); }}
            >
              <Icon name="close" size="sm" />
            </span>
          </button>
        ))}
        </div>

        <div className={styles.panelActions}>
          {/*
            Only the panel's own two actions here: the lock and the menu. The
            viewport's display controls (layout, channel, resolution, preview,
            LUT, overlays, snapshot compare, display mode, bookmarks, pop out)
            sat before the lock for a while and made this end of the row a
            wall of buttons; they are in the transport row under the stage
            now (`Workspace/TransportBar.tsx`), which had the room.
          */}
          {/* View lock — the workspace's fixed/free camera mode. Fixed frames
              and centres the comp and disables panning; free is the infinite
              canvas. The button reflects the live mode. */}
          <button
            type="button"
            className={viewMode === 'fixed' ? `${styles.panelActionBtn} ${styles.panelActionBtnOn}` : styles.panelActionBtn}
            title={viewMode === 'fixed' ? 'View locked (comp framed & centred) — click to unlock' : 'Lock view — frame the comp and disable panning'}
            aria-label="Lock view"
            aria-pressed={viewMode === 'fixed'}
            onClick={() => useWorkspaceViewStore.getState().toggleMode()}
          >
            <Icon name="lock" size="sm" />
          </button>
          <button
            type="button"
            className={styles.panelActionBtn}
            title="Composition panel menu"
            aria-label="Composition panel menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openContextMenu(r.left, r.bottom + 4, [
                { id: 'new-comp', label: 'New Composition…', onSelect: () => openNewCompositionDialog() },
                { id: 'settings', label: 'Composition Settings…', onSelect: () => openCompositionSettings() },
                { id: 'sep', separator: true },
                {
                  id: 'fit',
                  label: 'Fit Composition in View',
                  onSelect: () => {
                    try { getWorkspaceController().fitComposition(); getWorkspaceController().requestRender(); } catch { /* engine not ready */ }
                  },
                },
                {
                  id: 'view-lock',
                  label: viewMode === 'fixed' ? 'Unlock View' : 'Lock View',
                  onSelect: () => useWorkspaceViewStore.getState().toggleMode(),
                },
                { id: 'sep2', separator: true },
                {
                  id: 'delete-comp',
                  label: 'Delete Composition',
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
                    const warn = deleteCompositionWarning(comp?.name ?? 'this composition', compId);
                    if (await customConfirm('Delete Composition', warn, { isDanger: true, confirmLabel: 'Delete' })) {
                      await deleteCompositionEdit(compId);
                    }
                  },
                },
              ]);
            }}
          >
            <Icon name="menu" size="sm" />
          </button>
          {tabs.length > 0 && (
            <button
              ref={overflowBtnRef}
              type="button"
              className={styles.overflow}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
              title="All open tabs"
            >
              <Icon name="chevron-down" size="sm" />
            </button>
          )}
        </div>
      </div>

      {overflowOpen && (
        <div ref={overflowMenuRef} className={styles.overflowMenu} role="menu">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="menuitem"
              className={styles.overflowItem}
              onClick={() => { activate(tab.id); setOverflowOpen(false); }}
            >
              {tab.title}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className={styles.overflowItem}
            onClick={() => { useEditorTabStore.getState().closeAll(); setOverflowOpen(false); }}
          >
            Close all tabs
          </button>
        </div>
      )}

      <div className={styles.body}>
        {/*
          UNCONDITIONAL. Do not wrap this in `{sceneActive && …}`.
          The GPU context, playback state and viewport transform live in here,
          and all three are lost the moment it leaves the tree.
        */}
        <div
          className={cn(styles.scenePane, (!sceneActive || layerViewerOpen) && styles.sceneHidden)}
          aria-hidden={!sceneActive || layerViewerOpen}
          data-testid="scene-pane"
        >
          {scene}
        </div>

        {/* AE's Layer panel, over the composition viewer — which stays mounted
            and is only hidden, exactly as it is for a plugin tab. */}
        {layerViewerOpen && sceneActive && (
          <div className={styles.tabPane} role="tabpanel" aria-label="Layer panel" data-testid="layer-pane">
            <LayerViewer />
          </div>
        )}

        {activeTab && (
          <div className={styles.tabPane} role="tabpanel" data-testid="tab-pane">
            {renderTab(activeTab)}
          </div>
        )}
      </div>
    </div>
  );
}
