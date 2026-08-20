/**
 * Workspace / WorkspaceViewport — the central editor viewport.
 *
 * Structure (AE-style):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                                                          │
 *   │   Stage (dot-grid / checkerboard void)                   │
 *   │     ┌──────────────────────────┐                        │
 *   │     │  Composition canvas      │  ← framed with shadow  │
 *   │     │  (canvas + overlay)      │                        │
 *   │     └──────────────────────────┘                        │
 *   │                                                          │
 *   │  [TL overlay]                                            │
 *   │  [BL: AI prompt]                                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * There is no header bar: the composition's name is the Scene tab's label
 * (`layout/Tabs/EditorTabs.tsx`) and its status badges moved to the timeline's
 * tool row. The viewport's own controls went with them — `ViewportTools` is
 * rendered by `BottomTimeline`, not here — so nothing floats over the stage
 * except the AI prompt and the focus breadcrumb.
 *
 * Interaction and rendering are handled by the framework-independent
 * `@motion/workspace` engine via {@link useWorkspace}.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type KeyboardEvent } from 'react';
import { cn } from '@utils/cn';
import { useActiveWorkspace, useWorkspaceStore } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { compScreenRect } from './compScreenRect';
import { hasCanvasDrag, readCanvasDrag } from '@core/dnd/canvasDrag';
import {
  insertShape,
  insertText,
  insertMedia,
  setNodeWorldPosition,
} from '@core/scene/sceneInsert';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import { EmptyCompositionView } from './EmptyCompositionView';
import { insertCursorItem } from '@core/library/cursorLibrary';
import { insertUiComponent } from '@core/library/uiKitLibrary';
import { insertMographItem } from '@core/library/mographLibrary';
import { applyTransitionItem } from '@core/library/transitionLibrary';
import { insertSfxItem } from '@core/library/sfxLibrary';
import { insertLottieItem } from '@core/library/lottieLibrary';
import { useAssetStore } from '@stores/assetStore';
import { useComponentStore } from '@stores/componentStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { addEffectAndReveal } from '@layout/Effects/revealEffectControls';
import { applyPresetByName } from '@core/animation/animationPresets';
import { insertAnimPreset } from '@core/template/animPresets';
import { UI_COMPONENT_PRESETS } from '@core/scene/uiComponents';

import { SecondaryViewPane } from './SecondaryViewPane';
import { useGuidesStore } from '@stores/guidesStore';
import { FocusBreadcrumb } from '@layout/focus/FocusBreadcrumb';
import { TextEditOverlay } from './TextEditOverlay';
import { PuppetOverlay } from './PuppetOverlay';
import { EffectHandleOverlay } from './EffectHandleOverlay';
import { BoneOverlay } from './BoneOverlay';
import { TrackPointOverlay } from './TrackPointOverlay';
import { Gizmo3dOverlay } from './Gizmo3dOverlay';
import { AxisWidgetOverlay } from './AxisWidgetOverlay';
import { useGizmo3d } from './useGizmo3d';
import { useDeviceHandles } from './useDeviceHandles';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { useWorkspace } from './useWorkspace';
import styles from './Workspace.module.css';

export interface WorkspaceViewportProps {
  topLeft?: ReactNode;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  className?: string;
}

/** Divider line between cells of the 4-up grid (matches the app border token). */
const QUAD_DIVIDER = '1px solid var(--color-border, rgba(255,255,255,0.12))';

/** Keys the viewport handles directly. */
const VIEWPORT_KEYS = new Set([
  'Space', 'Delete', 'Backspace', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);

/**
 * Alpha checkerboard under a transparent composition, clipped to the comp rect.
 *
 * Positioned imperatively rather than through React state: it has to track the
 * camera, and re-rendering the whole viewport on every wheel tick to move one
 * background would be a poor trade. Writing three style properties on a ref is
 * what a pan should cost.
 *
 * Driven off `CameraChanged`/`ViewportChanged` — the same state that feeds the
 * renderer's `backdropMvp` — so the DOM rect and the GPU-drawn comp rect cannot
 * drift apart. See compScreenRect for the rounding rule that keeps the seam
 * stable at fractional zoom.
 */
function TransparencyGrid(): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);

  useEffect(() => {
    const ws = getWorkspaceController().ws;
    const place = (): void => {
      const el = ref.current;
      if (!el) return;
      const r = compScreenRect((p) => ws.worldToScreen(p), compWidth, compHeight);
      el.style.transform = `translate(${r.left}px, ${r.top}px)`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    };
    place();
    // Both events matter: the camera moves on pan/zoom, the viewport changes on
    // panel resize and on the auto-fit that follows a comp-size change.
    const cam = ws.events.on('CameraChanged', place);
    const vp = ws.events.on('ViewportChanged', place);
    return () => { cam.dispose(); vp.dispose(); };
  }, [compWidth, compHeight]);

  return <div ref={ref} className={styles.transparencyGrid} data-transparency-grid="" />;
}

export function WorkspaceViewport({
  topLeft,
  bottomLeft,
  bottomRight,
  className,
}: WorkspaceViewportProps): JSX.Element {
  const time     = useActiveWorkspace()?.time ?? 0;
  const sceneRev = useSceneRevision((s) => s.rev);
  // The blank-comp moment — AE's two ways in, said out loud. Recomputed per
  // scene revision; disappears the instant anything exists.
  const sceneIsEmpty = useMemo(() => {
    let hasContent = false;
    defaultSceneGraph.traverse((n) => { if (readNodeKind(n) !== 'group') hasContent = true; });
    return !hasContent;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scene rev drives this
  }, [sceneRev]);
  // Tools that CREATE content dismiss the empty-comp surface: reaching for
  // the pen or a shape is the third way to start, and the surface must not
  // stand between the tool and the canvas. Navigation/selection tools keep it
  // up — there is nothing to select or pan over yet.
  const activeTool = useUIStore((s) => s.activeTool);
  const creationToolActive = !['select', 'direct-select', 'rotate', 'pan-behind', 'hand', 'zoom', 'move'].includes(activeTool);
  const transparent = useCompositionStore((s) => s.transparent);
  const workspaceMode = useWorkspaceViewStore((s) => s.mode);
  // Multi-view (AE-style): '2' shrinks the interactive stage to the left half
  // (one view-only pane on the right); '4' shrinks it to the top-left quadrant
  // (three view-only panes fill the other cells of a 2×2 grid).
  const viewLayout = useGuidesStore((s) => s.viewLayout);
  const quadViewModes = useGuidesStore((s) => s.quadViewModes);
  const setQuadViewMode = useGuidesStore((s) => s.setQuadViewMode);

  // Keep the engine camera's lock in sync with the persisted workspace mode.
  // The composition framing itself rides on the engine's normal first-fit, so
  // this only has to (re)apply the lock — including after a reload in 'fixed'.
  useEffect(() => {
    getWorkspaceController().ws.camera.setLocked(workspaceMode === 'fixed');
    getWorkspaceController().requestRender();
  }, [workspaceMode]);

  const stageRef   = useRef<HTMLDivElement | null>(null);
  const canvasRef  = useRef<HTMLCanvasElement | null>(null);
  // RAM-preview blit layer — see `.cacheCanvas`. Sits between the content and
  // the interaction overlay so cached pixels replace the render, not the chrome.
  const cacheRef   = useRef<HTMLCanvasElement | null>(null);
  // Onion-skin ghosts — see `.onionCanvas`. Above content and cache, below the
  // interaction overlay.
  const onionRef   = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const { focus, focusKey } = useFocusContext();


  const { ready, renderError } = useWorkspace({
    contentCanvasRef: canvasRef,
    cacheCanvasRef: cacheRef,
    onionCanvasRef: onionRef,
    overlayCanvasRef: overlayRef,
    stageRef,
    sceneRev,
    time,
    focus,
    focusKey,
  });

  const gizmo3dProps = useGizmo3d(overlayRef, stageRef);
  // Camera / light handles. Mounted AFTER the layer gizmo so its capture-phase
  // listener runs second: where a device handle overlaps a transform handle the
  // layer gizmo claims the press first, which is the more specific intent.
  const { deviceHandles, hoveredHandle } = useDeviceHandles(stageRef);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement | null;
    if (
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable
    ) {
      return;
    }
    if (!VIEWPORT_KEYS.has(e.code)) return;
    const controller = getWorkspaceController();
    switch (e.code) {
      case 'Space':
        // Handled globally (tap = play, hold + drag = pan) — see useSpaceTransport.
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        controller.deleteSelection();
        break;
      case 'Escape':
        controller.ws.clearSelection();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
        const dy = e.code === 'ArrowUp'   ? -step : e.code === 'ArrowDown'  ? step : 0;
        controller.nudgeSelection(dx, dy);
        break;
      }
    }
  }, []);

  const onKeyUp = useCallback((_e: KeyboardEvent<HTMLDivElement>): void => {
    // Space is handled globally; nothing else needs key-up here.
  }, []);

  // ── Drag-and-drop from the library panels onto the canvas (AE-style) ──
  const [dragOver, setDragOver] = useState(false);

  const onDragOverCanvas = useCallback((e: DragEvent<HTMLDivElement>): void => {
    // OS file drags are OURS now: dropping footage on the canvas is the first
    // gesture everyone tries ("here is my video, edit it"), and it used to
    // dead-end silently. Internal app drags keep their existing routing.
    const isFileDrag = !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    if (!hasCanvasDrag(e) && !isFileDrag) return; // let unrelated drags (tab reorder) pass
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);

  const onDragLeaveCanvas = useCallback((e: DragEvent<HTMLDivElement>): void => {
    // Only clear when the pointer actually leaves the viewport, not when it
    // crosses between child elements (which also fire dragleave).
    if (e.currentTarget === e.target) setDragOver(false);
  }, []);

  const onDropCanvas = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    setDragOver(false);
    // ── OS files: the "upload a video and edit it" gesture ──────────────
    // AE's two ways in, as one drop: onto an EMPTY comp, a video conforms the
    // comp to itself (size, duration, probed fps — `createCompositionFromFootage`,
    // AE's new-comp-from-footage); onto a comp with content, it lands as a
    // layer like any Assets-panel add. Either way the file is imported first,
    // so it shows in Assets and survives re-use.
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      const media = Array.from(files).filter((f) =>
        /^(video|image|audio)\//.test(f.type) || /\.(mp4|mov|webm|m4v|png|jpe?g|gif|svg|webp|mp3|wav|m4a|aac|ogg|mxf|avi|wmv|flv|mts|m2ts|mpg|mpeg|vob|ts|mkv)$/i.test(f.name));
      if (media.length === 0) {
        useUIStore.getState().notify({ level: 'info', message: 'Drop video, image or audio files.', durationMs: 2600 });
        return;
      }
      const imported = await useAssetStore.getState().addAssetsBatch(media.map((file) => ({ file })));
      // "Empty" = no content layers anywhere in the scene. Counting the comp
      // root's children breaks on fresh unsaved projects (layers hang off the
      // virtual comp_root), so ask the nodes themselves.
      let hasContent = false;
      defaultSceneGraph.traverse((n) => { if (readNodeKind(n) !== 'group') hasContent = true; });
      const first = imported[0];
      if (!hasContent && imported.length === 1 && first && first.type === 'video') {
        await createCompositionFromFootage(first);
        return;
      }
      for (const asset of imported) await insertMedia(asset);
      return;
    }
    const payload = readCanvasDrag(e);
    if (!payload) return; // not one of ours
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const controller = getWorkspaceController();
    const world = controller.ws.screenToWorld(local);

    // The insert helpers select the new node; land it under the cursor.
    const placeSelection = (): void => {
      const id = useSelectionStore.getState().ids[0];
      if (id) setNodeWorldPosition(id, world.x, world.y);
    };

    switch (payload.kind) {
      case 'shape':
        insertShape(payload.primitive, payload.label);
        placeSelection();
        break;
      case 'text':
        insertText(payload.label, payload.fontSize, payload.weight, payload.extra ?? {});
        placeSelection();
        break;
      case 'asset': {
        const asset = useAssetStore.getState().assets.find((a) => a.id === payload.assetId);
        if (asset) {
          await insertMedia(asset);
          placeSelection();
        }
        break;
      }
      case 'component': {
        const gid = useComponentStore.getState().insert(payload.componentId);
        if (gid) setNodeWorldPosition(gid, world.x, world.y);
        break;
      }
      case 'component-preset': {
        const preset = UI_COMPONENT_PRESETS.find((p) => p.id === payload.presetId);
        if (preset) {
          const gid = preset.insert();
          if (gid) setNodeWorldPosition(gid, world.x, world.y);
        }
        break;
      }
      case 'effect': {
        // Effects apply to a layer — target the one under the cursor (AE-style).
        const node = controller.ws.hitTestScreen(local);
        if (node) addEffectAndReveal(node.id, payload.effectType);
        else useUIStore.getState().notify({ level: 'warning', message: 'Drop an effect onto a layer.', durationMs: 2400 });
        break;
      }
      case 'motionPreset': {
        const node = controller.ws.hitTestScreen(local);
        if (node) {
          const ws = useWorkspaceStore.getState();
          const playhead = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
          applyPresetByName(node.id, payload.name, playhead);
        } else {
          useUIStore.getState().notify({ level: 'warning', message: 'Drop a motion preset onto a layer.', durationMs: 2400 });
        }
        break;
      }
      case 'animPreset':
        // A self-contained animated element — insert at the drop point.
        insertAnimPreset(payload.presetId, world.x, world.y);
        break;
      case 'cursor':
        insertCursorItem(payload.cursorId, world.x, world.y);
        break;
      case 'uikit':
        insertUiComponent(payload.componentId, world.x, world.y);
        break;
      case 'mograph':
        insertMographItem(payload.mographId, world.x, world.y);
        break;
      case 'transition':
        // Position-independent: applies to the selection at the playhead,
        // or drops a choreographed solid.
        applyTransitionItem(payload.transId);
        break;
      case 'sfx':
        void insertSfxItem(payload.sfxId);
        break;
      case 'lottie':
        insertLottieItem(payload.lottieId, world.x, world.y);
        break;
    }
  }, []);


  return (
    <div className={cn(styles.wrapper, className)}>
      {/*
        No header bar. The composition name is the Scene tab's label now, and
        the two status badges that shared the bar with it moved into the
        timeline's tool row with the rest of the viewport controls — see
        `ViewportTools`. What is left above the canvas is nothing, which is the
        point: the stage starts at the top of the panel.
      */}

      {/* Canvas viewport */}
      <div
        className={styles.root}
        data-workspace-viewport=""
        data-drag-over={dragOver || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onDragOver={onDragOverCanvas}
        onDragLeave={onDragLeaveCanvas}
        onDrop={onDropCanvas}
        style={dragOver ? { outline: '2px solid var(--color-primary)', outlineOffset: '-2px' } : undefined}
      >
        <div
          className={styles.stage}
          ref={stageRef}
          // Multi-view: the interactive stage yields space to the view-only
          // panes — the right half in 2-up, the top-left quadrant in 4-up. In
          // both cases useWorkspace's ResizeObserver on stageRef re-fits the
          // comp to the smaller rect automatically (no extra wiring here).
          style={
            viewLayout === '2' ? { right: '50%' }
            : viewLayout === '4' ? { right: '50%', bottom: '50%' }
            : undefined
          }
        >
          {/* BEFORE the canvas, so the compositor blends the canvas over it —
              that is what makes partial alpha composite correctly for free. */}
          {transparent && <TransparencyGrid />}
          <canvas ref={canvasRef} className={styles.canvas} />
          <canvas ref={cacheRef} className={styles.cacheCanvas} data-workspace-cache="" />
          <canvas ref={onionRef} className={styles.onionCanvas} data-workspace-onion="" />
          <canvas ref={overlayRef} className={styles.overlay} data-workspace-overlay="" />
          {/* Blank-comp start surface — After Effects' empty Composition
              panel, as a REPLACEMENT: opaque over the stage, so no comp frame
              or grid implies a composition that doesn't meaningfully exist.
              The canvases stay mounted beneath it (GPU init is not free).
              It stays up during a file drag — its footage card and the root's
              drop handler are the drop targets — and steps aside the moment
              the user picks a creation tool, preserving the draw-the-first-
              shape-directly workflow the local edition promises. */}
          {sceneIsEmpty && ready && !renderError && !creationToolActive && (
            <EmptyCompositionView />
          )}
          {/* Scene loading indicator — until the backend paints its first frame. */}
          {!ready && !renderError && (
            <div className={styles.loading} data-workspace-loading="">
              <div className={styles.loadingSpinner} />
            </div>
          )}
          {/* GPU init failed on every tier — say so instead of a blank stage. */}
          {renderError && (
            <div className={styles.loading} data-workspace-render-error="">
              <div className={styles.renderError} role="alert">
                <strong>Preview unavailable</strong>
                <span>{renderError}</span>
                <span>Close other GPU-heavy tabs or windows, then reopen this project.</span>
              </div>
            </div>
          )}
          {/* On-canvas text editor — screen coords match the canvas' own space. */}
          <TextEditOverlay />
          <PuppetOverlay />
          <EffectHandleOverlay />
          <BoneOverlay />
          <TrackPointOverlay />
          {/* Mounts for the whole 3D SCENE, not for the selection: the ground
              plane and comp frame are how you orient yourself in a side view,
              so gating them on "a 3D layer is selected" hid them in exactly
              the case they exist for. The gizmo inside still needs a target. */}
          {(gizmo3dProps.scene3d || (gizmo3dProps.is3D && gizmo3dProps.singleId)) && (
            <Gizmo3dOverlay
              {...gizmo3dProps}
              deviceHandles={deviceHandles}
              hoveredDeviceHandle={hoveredHandle}
              nodeId={gizmo3dProps.singleId ?? null}
              showGizmo={gizmo3dProps.is3D && !!gizmo3dProps.singleId}
            />
          )}
          {/* Persistent view-orientation axis widget (whenever the comp is 3D). */}
          <AxisWidgetOverlay />
        </div>

        {/* View-only right pane (AE's 2 Views) — its own canvas + backend. */}
        {viewLayout === '2' && <SecondaryViewPane />}

        {/* View-only cells of the 2×2 "4 Views" grid. The top-left quadrant is
            the interactive stage above (shrunk via right/bottom:50%); these
            three panes fill the remaining quadrants, each its own GL context.
            Only cells 1–3 exist here — cell 0 IS the interactive stage, so
            selection / gizmos / camera-nav stay confined to the top-left, like
            AE's single active viewport. `key` guarantees each pane's backend is
            disposed and rebuilt on layout change rather than reused across
            positions. Thin dividers = borders on the right-column / bottom-row
            cells (no doubling), matching --color-border. */}
        {viewLayout === '4' && (
          <>
            <SecondaryViewPane
              key="quad-1"
              mode={quadViewModes[1]}
              onModeChange={(m) => setQuadViewMode(1, m)}
              style={{ top: 0, bottom: '50%', left: '50%', right: 0, borderLeft: QUAD_DIVIDER, borderBottom: 'none' }}
            />
            <SecondaryViewPane
              key="quad-2"
              mode={quadViewModes[2]}
              onModeChange={(m) => setQuadViewMode(2, m)}
              style={{ top: '50%', bottom: 0, left: 0, right: '50%', borderLeft: 'none', borderTop: QUAD_DIVIDER }}
            />
            <SecondaryViewPane
              key="quad-3"
              mode={quadViewModes[3]}
              onModeChange={(m) => setQuadViewMode(3, m)}
              style={{ top: '50%', bottom: 0, left: '50%', right: 0, borderLeft: QUAD_DIVIDER, borderTop: QUAD_DIVIDER }}
            />
          </>
        )}

        {/*
          Corner overlays.

          There is no top-right slot any more. Its buttons moved to the pieces
          of chrome that own them — the header bar and the tool cluster below —
          and what was left was an empty positioned div sitting over the corner
          of the stage, catching nothing and showing nothing.
        */}
        <div className={styles.overlayTL}>{topLeft}</div>
        {/*
          `ViewportTools` used to float here, over the bottom-left of the stage.
          It renders in the timeline's tool row now, beside the trim buttons —
          a pill over the canvas covers the canvas, and covers a different part
          of it at every zoom level. The slot stays for `bottomLeft`, which is
          the AI prompt.
        */}
        <div className={styles.overlayBL}>{bottomLeft}</div>
        <div className={styles.overlayBR}>{bottomRight}</div>

        <FocusBreadcrumb />
      </div>
    </div>
  );
}

// ViewportZoomControls was removed — zoom lives in `ViewportTools`, which the
// timeline's tool row renders.
