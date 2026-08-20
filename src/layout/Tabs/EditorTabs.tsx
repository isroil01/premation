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
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { SCENE_TAB_ID, useEditorTabStore, type EditorTab } from '@stores/editorTabStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore } from '@stores/assetStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useFocusStore } from '@stores/focusStore';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { openContextMenu } from '@stores/contextMenuStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { assetIdOf } from '@core/source/sourceInfo';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { openFootagePreview, useLastFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
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

  const activeTab = tabs.find((t) => t.id === activeId);
  const sceneActive = activeId === SCENE_TAB_ID;
  const compName = useCompositionStore((s) => s.name);

  // Footage tab: last-viewed asset first, else the selected video layer's own
  // source. Layer tab: Focus Mode isolation over the single selected layer.
  const lastPreviewed = useLastFootagePreview((s) => s.asset);
  const selectionIds = useSelectionStore((s) => s.ids);
  const assets = useAssetStore((s) => s.assets);
  useSceneRevision((s) => s.rev);
  const singleSelectedLayer = selectionIds.length === 1 ? selectionIds[0]! : null;
  const selectedAsset = (() => {
    if (!singleSelectedLayer) return null;
    const node = defaultSceneGraph.getNode(singleSelectedLayer);
    const assetId = node ? assetIdOf(node) : null;
    return assetId ? assets.find((a) => a.id === assetId) ?? null : null;
  })();
  const footageAsset = lastPreviewed ?? (selectedAsset?.type === 'video' ? selectedAsset : null);
  const isolatedId = useFocusStore((s) => s.isolatedId);
  const layerTabName = isolatedId
    ? defaultSceneGraph.getNode(isolatedId)?.name ?? null
    : singleSelectedLayer
      ? defaultSceneGraph.getNode(singleSelectedLayer)?.name ?? null
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
        {/*
          Composition's tab, labelled with the COMPOSITION's name like After Effects:
          "Composition: <compName>" or "Composition (none)"
        */}
        <button
          type="button"
          role="tab"
          aria-selected={sceneActive}
          className={cn(styles.tab, sceneActive && styles.tabActive)}
          title={`Composition: ${compName || 'none'}`}
          onClick={() => activate(SCENE_TAB_ID)}
        >
          <Icon name="shape" size="sm" />
          <span className={styles.tabLabel}>Composition {compName ? `(${compName})` : '(none)'}</span>
        </button>

        {/*
          AE's Footage and Layer viewer tabs, wired to what this editor
          actually has rather than shipped as dead chrome:

          FOOTAGE holds the last asset opened in the footage viewer (the way
          AE's viewer holds what was last opened) and reopens it; before
          anything has been viewed it offers the selected video layer's own
          source. Truly nothing to show → disabled "(none)".

          LAYER is Focus Mode's isolate: with one layer selected, it isolates
          that layer (everything else ghosts — this editor's layer viewer);
          while isolation is active it reads as the active tab and clicking
          exits. No single selection and no isolation → disabled "(none)".
        */}
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className={styles.tab}
          disabled={!footageAsset}
          title={footageAsset ? `Footage: ${footageAsset.name}` : 'Footage (none) — double-click a clip in Assets, or select a video layer'}
          onClick={() => { if (footageAsset) openFootagePreview(footageAsset); }}
        >
          <span className={styles.tabLabel}>Footage {footageAsset ? `(${footageAsset.name})` : '(none)'}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={!!isolatedId}
          className={cn(styles.tab, isolatedId && styles.tabActive)}
          disabled={!isolatedId && !singleSelectedLayer}
          title={
            isolatedId
              ? `Layer: ${layerTabName ?? ''} — click to exit isolation`
              : singleSelectedLayer
                ? `Isolate “${layerTabName ?? ''}” (everything else ghosts)`
                : 'Layer (none) — select one layer to isolate it'
          }
          onClick={() => {
            if (isolatedId) { useFocusStore.getState().exitOne(); return; }
            if (singleSelectedLayer) {
              activate(SCENE_TAB_ID);
              useFocusStore.getState().isolate(singleSelectedLayer);
            }
          }}
        >
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

        <div className={styles.panelActions}>
          {/* View lock — the workspace's fixed/free camera mode. Fixed frames
              and centres the comp and disables panning; free is the infinite
              canvas. The button reflects the live mode. */}
          <button
            type="button"
            className={styles.panelActionBtn}
            title={viewMode === 'fixed' ? 'View locked (comp framed & centred) — click to unlock' : 'Lock view — frame the comp and disable panning'}
            aria-label="Lock view"
            aria-pressed={viewMode === 'fixed'}
            style={viewMode === 'fixed' ? { color: 'var(--color-primary, #4c8dff)' } : undefined}
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
              ]);
            }}
          >
            <Icon name="menu" size="sm" />
          </button>
          {tabs.length > 0 && (
            <button
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
        <div className={styles.overflowMenu} role="menu">
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
          className={cn(styles.scenePane, !sceneActive && styles.sceneHidden)}
          aria-hidden={!sceneActive}
          data-testid="scene-pane"
        >
          {scene}
        </div>

        {activeTab && (
          <div className={styles.tabPane} role="tabpanel" data-testid="tab-pane">
            {renderTab(activeTab)}
          </div>
        )}
      </div>
    </div>
  );
}
