/**
 * useWorkspace — the React⇄Workspace-engine seam for the viewport.
 *
 * React owns only DOM elements (an overlay canvas + the stage) and forwards
 * raw pointer/wheel input to the workspace. The workspace does the rest of the
 * interaction: camera, tools, selection, hit-testing, snapping. This hook
 * (1) paints the interaction overlay (selection, handles, marquee, snap lines,
 * hover, motion paths, guides, the ROI) from `ws.overlay`, and (2) feeds
 * normalized input in.
 *
 * The PICTURE is not drawn here: the C++ engine renders the composition and
 * EngineSurface shows its frames under this overlay (the page renderer this
 * hook used to drive is gone — docs/TS_ENGINE_REMOVAL.md).
 */

import { useEffect, useRef, useState } from 'react';
import { onDocumentFrameChanged } from '@core/workspace/frameSignals';
import { compRecordFromSettings } from '@core/mirror/compFacts';
import type { Guide, GuideAxis, WorkspaceOverlay } from '@motion/workspace';
import { modifiersFrom, drawToolOptions, type PointerInput, type WheelInput } from '@motion/workspace';
import { useWorkspaceStore } from '@stores/projectStore';
import { compHasWireframeQualityLayer, paintWireframeQualityLayers } from './wireframeQualityOverlay';
import { useGuidesStore, clampOverlayOpacity } from '@stores/guidesStore';
import { roiHandleAt, resizeRoi, clampRoi, roiHandleCursor, type RoiHandle } from '@core/workspace/roiGeometry';
import { useActiveMotionBlur } from '@hooks/useMirrorFrame';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { DEFAULT_COMPOSITION, compKeyFor } from '@stores/compositionStore';
import { useUIStore, type Tool } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { MAIN_VIEWPORT, overlayLayer, requestOverlayLayers, subscribeOverlayGeometry, type OverlayLayer } from '@stores/overlayGeometry';
import { documentMirror } from '@stores/documentMirror';
import { useActiveMirrorComp } from '@hooks/useMirror';
import { isPaintableLayer } from '@core/mirror/layerKinds';
import { mirrorLabelColor } from '@core/mirror/layerLabels';
import { isMirrorDescendantOf } from '@core/mirror/layerTree';
import { hasPositionKeys } from '@core/mirror/motionFacts';
import { isLookedThroughNow, navTargetNow, navUnavailableNow, orbitPivotNow, requestMainViewCamera, viewProjectorNow } from './viewNav';


import { getWorkspaceController, type WorkspaceController } from '@core/workspace/WorkspaceController';
import {
  setPathTangent,
  motionPathTimeWindow,
} from '@core/motion/motionPath';
import { positionTangentContinuous } from '@core/mirror/positionTracks';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { motionPathKeyframeMenuItems, guideContextMenuItems, convertMotionPathVertex } from './viewportPrecisionMenus';
import { openGuideEditor } from './GuideEditorDialog';
import { beginViewportGesture, cancelToolGesture, endViewportGesture } from '@core/workspace/viewportGesture';
import { secondsToFlicks, type Command, type OverlayKind } from '@motion/engine-api';
import { GestureSession } from '@core/engine/uiEdits';
import {
  capturePositionTracks,
  positionKeyPatchCommands,
  resolvePositionKeyIds,
  type PositionKeyIds,
  type PositionTracks,
} from './viewportEdits';
import { Matrix } from '@motion/scene';
import { useTextEditStore } from '@stores/textEditStore';
import { openContextMenu } from '@stores/contextMenuStore';
import type { PaintMode } from '@core/paint/paintStrokes';
import { commitPaintDrag } from '@core/engine/paintEdits';
import { ctrlDragBrush, penSample } from '@core/paint/paintCapture';
import { thinSamples, type PaintSpace } from '@core/paint/paintSpace';
import { paintSpaceFromPush } from './paintSpaceFromPush';
import { usePaintStore } from '@stores/paintStore';
import { publishProbe, clearProbe } from './useWorkspaceProbe';
import {
  nodeContextMenuItems,
  canvasContextMenuItems,
  // Viewport-wide helpers that happen to live in the menu module for now —
  // see the note on `playheadTime` there.
  playheadTime,
  compSize,
} from './useWorkspaceContextMenu';
import { useViewportDisplayStore, viewportHudStats } from '@stores/viewportDisplayStore';
import { usePlaybackClockStore } from '@stores/playbackClockStore';
import { installPerfDevGlobal } from '@core/perf/framePerf';
import {
  cancelSmoothDolly,
  dollyNavBy,
  orbitNavBy,
  smoothDollyNavBy,
  trackNavBy,
  unifiedNavModeFor,
  type CameraNavMode,
  type NavTarget,
} from '@core/workspace/cameraNav';
import { useFaceSelectionStore } from '@stores/faceSelectionStore';
import { pickFace, faceHighlightGroups } from '@core/scene/facePicking';
import { fetchLayerFaces, layerFacesNow, onLayerFaces, projectFacesForView } from './layerFaces';
import { openLayerOnDoubleClick } from '@layout/LayerViewer/openLayer';
import { RULER_CSS_PX, inStrip, rulerStrips } from './rulerGeometry';


/**
 * Screen-px a viewport press must travel before it counts as a drag.
 *
 * Mirrors the engine's `InputSystem` default `dragThreshold`, so the UI drag
 * flag and the tool's `onDragStart` flip on the same movement instead of on
 * two slightly different ones.
 */
const VIEWPORT_DRAG_SLOP = 3;


// ── Ruler guides (drag-out) ──────────────────────────────────────────
// Geometry lives in rulerGeometry.ts, shared by the painter and the hit-test —
// see that file for why they must not be two numbers.
/** Screen-px tolerance for grabbing an existing guide line. */
const GUIDE_GRAB_PX = 4;
/**
 * Guide line colour (cyan — distinct from the magenta snap lines).
 *
 * Read from the theme rather than frozen as `rgba(45, 212, 235, 0.9)`, which
 * was a dark-theme cyan drawn onto a light canvas too. Alpha is applied at the
 * draw site via `globalAlpha`, so the token stays a plain colour.
 */
const GUIDE_ALPHA = 0.9;
function guideColor(): string {
  return themeGuides().GUIDE;
}

/** An in-flight ruler-guide drag. `guideId` is null while dragging out a new guide. */
interface GuideDrag {
  /** 'x' = vertical guide (from the left ruler), 'y' = horizontal (top ruler). */
  axis: GuideAxis;
  guideId: string | null;
  screen: { x: number; y: number };
  /** True while the pointer is back over the source ruler (release = cancel/delete). */
  overRuler: boolean;
}


/**
 * Topmost unlocked guide whose line passes within GUIDE_GRAB_PX of `p` (screen
 * px). `includeLocked` also finds locked USER guides — for the right-click menu
 * and the double-click editor, which must be able to reach a locked guide to
 * unlock or edit it.
 */
function hitGuideAt(controller: WorkspaceController, p: { x: number; y: number }, includeLocked = false): Guide | null {
  // A hidden guide is not grabbable either — otherwise an invisible line
  // still caught drags aimed at the layer behind it.
  if (!useGuidesStore.getState().guidesVisible) return null;
  for (const g of controller.ws.guides.list()) {
    if (g.locked && !(includeLocked && g.kind === 'user')) continue;
    const s =
      g.axis === 'x'
        ? controller.ws.worldToScreen({ x: g.position, y: 0 }).x
        : controller.ws.worldToScreen({ x: 0, y: g.position }).y;
    const d = g.axis === 'x' ? Math.abs(s - p.x) : Math.abs(s - p.y);
    if (d <= GUIDE_GRAB_PX) return g;
  }
  return null;
}

const guideCursor = (axis: GuideAxis): string => (axis === 'x' ? 'ew-resize' : 'ns-resize');

export interface UseWorkspaceArgs {
  contentCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  stageRef: React.RefObject<HTMLElement | null>;
  sceneRev: number;
  // No `time`: the playhead reaches the render loop through a clock
  // subscription (see "Playhead → render"), never through a React prop.
  focusKey?: string;
}

export function useWorkspace(args: UseWorkspaceArgs): { ready: boolean; renderError: string | null } {
  const { contentCanvasRef, overlayCanvasRef, stageRef, sceneRev, focusKey } = args;

  const dprRef = useRef(1);
  // The chrome is ready once the overlay is attached and sized; the picture is
  // the engine's (EngineSurface shows its own status until its first frame).
  const [ready, setReady] = useState(false);
  // Non-null when the overlay canvas could not be attached.
  const [renderError, setRenderError] = useState<string | null>(null);

  // Active on-canvas motion-path drag (E4): a keyframe point or one of its
  // spatial tangent handles ('in'/'out'), or null.
  //
  // The drag is ONE engine gesture: `start` is the Position tracks as the
  // press found them and every move sends the ABSOLUTE result (start + pointer)
  // as `updateKeyframes` on the engine's key ids (`ids`, resolved once — until
  // they arrive the latest move waits in `latest`). `broken` sticks once Alt
  // breaks the handle pair, as the legacy continuous flag did.
  const mpDragRef = useRef<{
    nodeId: string;
    t: number;
    part: 'point' | 'in' | 'out';
    gesture: GestureSession;
    start: PositionTracks;
    ids: PositionKeyIds | null;
    latest: (() => Command[]) | null;
    continuous: boolean;
    broken: boolean;
    /** Settles when `ids` are in (and the move that waited for them is sent). */
    ready: Promise<void>;
  } | null>(null);
  // Active Brush-tool paint pass: comp[] commits to the layer on release,
  // screen[] previews the wet stroke on the overlay while dragging.
  // `mode` is captured when the stroke STARTS (see the paint branch): the
  // eraser must erase regardless of what the shared paint setting says.
  const paintDragRef = useRef<{
    nodeId: string;
    comp: Array<{ x: number; y: number }>;
    screen: Array<{ x: number; y: number }>;
    mode: PaintMode;
    /** The layer's paint space, resolved at PRESS time: the stroke maps through
     *  the pose it was drawn over, even if the playhead moves before release. */
    space: PaintSpace;
    /** Pointer timestamps (Write On replays them) and pen input, per sample. */
    times: number[];
    pen: Array<{ pressure: number; tiltX: number; tiltY: number } | null>;
    /** Shift: continue the previous stroke. Ctrl+Shift eraser: Last Stroke Only. */
    shift: boolean;
    lastStrokeOnly: boolean;
    /** Comp seconds at press — the stroke's Duration starts there. */
    compTime: number;
  } | null>(null);
  /** Ctrl-drag in the viewer with a paint tool: Diameter, then Hardness once
   *  Ctrl is released (AE). `at` is the press point, in overlay px. */
  const brushSizeDragRef = useRef<{ at: { x: number; y: number }; startX: number; start: { size: number; hardness: number } } | null>(null);
  /** Pointer over the viewer while cloning (overlay px) — the Clone Source
   *  Overlay follows it. `compOffset` is Aligned's comp-space offset, fixed by
   *  the first stroke after aiming. */
  const cloneHoverRef = useRef<{ x: number; y: number } | null>(null);
  const cloneCompOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const creationDragRef = useRef<{ start: { x: number; y: number }; current: { x: number; y: number }; tool: Tool } | null>(null);
  /** Type tool: the text layer a press landed on, edited on release. */
  const typeEditRef = useRef<string | null>(null);
  /**
   * A press on open canvas that has not yet earned the "dragging" label.
   *
   * The UI drag flag drives Adaptive Resolution, and a resolution change
   * reallocates the content canvas' drawing buffer. Raising the flag on PRESS
   * therefore made every ordinary click in the viewport — selecting a layer,
   * clicking empty space to deselect — degrade the preview to the adaptive
   * floor and snap it back a frame after release, which reads as the artwork
   * popping under the cursor for exactly as long as the mouse is held.
   *
   * A press is not a drag until it moves, so the press is ARMED here and
   * promoted in `onMove` once it clears `VIEWPORT_DRAG_SLOP`.
   */
  const viewportPressRef = useRef<{ pointerId: number; x: number; y: number; dragging: boolean } | null>(null);
  // Active ruler-guide drag (drag-out / move / delete), or null.
  const guideDragRef = useRef<GuideDrag | null>(null);
  /** Active Region-of-Interest grip drag (comp space). */
  const roiDragRef = useRef<{ handle: RoiHandle; pointerId: number } | null>(null);
  // True while we override the engine cursor with a guide resize cursor.
  const guideCursorRef = useRef(false);
  // The playhead the render loop draws. Written by the clock subscription
  // below, not by React — see "Playhead → render".
  const timeRef = useRef(playheadTime());

  const rulers = useGuidesStore((s) => s.rulers);
  const grid = useGuidesStore((s) => s.grid);
  const gridSpacing = useGuidesStore((s) => s.gridSpacing);
  const gridSubdivisions = useGuidesStore((s) => s.gridSubdivisions);
  const gridStyle = useGuidesStore((s) => s.gridStyle);
  const gridColor = useGuidesStore((s) => s.gridColor);
  const proportionalGrid = useGuidesStore((s) => s.proportionalGrid);
  const proportionalColumns = useGuidesStore((s) => s.proportionalColumns);
  const proportionalRows = useGuidesStore((s) => s.proportionalRows);
  const safeArea = useGuidesStore((s) => s.safeArea);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  // Custom-view params: nav writes replace the record, so this subscription
  // re-fires the render effect while orbiting a custom view.
  const customViews = useGuidesStore((s) => s.customViews);
  const gridOverlays = {
    rulers, grid, gridSpacing, gridSubdivisions, gridStyle, gridColor,
    proportionalGrid, proportionalColumns, proportionalRows, safeArea,
  };
  const overlaysRef = useRef(gridOverlays);
  overlaysRef.current = gridOverlays;

  // Per-view framing: stash the outgoing view's pan/zoom and restore the
  // incoming one. Without this every view shared a single viewport transform,
  // so framing up a Top view also re-framed Active Camera — you could not
  // inspect the scene from the side without disturbing the shot.
  const framingViewRef = useRef(camera3dMode);
  useEffect(() => {
    const prev = framingViewRef.current;
    if (prev === camera3dMode) return;
    framingViewRef.current = camera3dMode;
    const controller = getWorkspaceController();
    const g = useGuidesStore.getState();
    g.saveViewFraming(prev, controller.framing());
    const saved = g.viewFraming[camera3dMode];
    // No stashed framing yet ⇒ frame the comp, which is the sane first look at
    // a view you have never opened.
    if (saved) controller.restoreFraming(saved);
    else controller.fitComposition();
  }, [camera3dMode]);
  // Draft 3D (fast preview: no DOF, no lighting) — same ref pattern, same
  // reason. Flows into buildSnapshot as a comp INPUT, never into the pipeline.
  // In the render deps so toggling the Region of Interest repaints immediately.
  const roi = useGuidesStore((s) => s.roi);
  const draft3d = useGuidesStore((s) => s.draft3d);


  // The composition's motion-blur settings, from the document mirror.
  const {
    enabled: mbEnabled,
    shutterAngle: mbShutter,
    samples: mbSamples,
  } = useActiveMotionBlur();
  // Draft preview quality skips the expensive motion-blur multi-sample pass.
  const draft = useRenderQualityStore((s) => s.draft);

  // The active composition as its record, from the document mirror (B4); the
  // auto-fit below reacts to its size (a document fact).
  const activeMirrorComp = useActiveMirrorComp();
  const activeCompSettings = activeMirrorComp?.settings;
  const compWidth = activeCompSettings?.width;
  const compHeight = activeCompSettings?.height;
  const compRecord = activeMirrorComp ? compRecordFromSettings(activeMirrorComp.id, activeMirrorComp.settings) : DEFAULT_COMPOSITION;
  const compKey = compKeyFor(compRecord);
  const compRef = useRef(compRecord);
  compRef.current = compRecord;


  // Bumps when canvas/stage refs weren't ready on the first effect tick so we
  // can re-enter attach instead of leaving the viewport spinner forever.
  const [attachTick, setAttachTick] = useState(0);

  // ── Backend attach + size + render loop (once) ─────────────────────
  useEffect(() => {
    const controller = getWorkspaceController();
    const content = contentCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    const stage = stageRef.current;
    // Refs can briefly be null if this effect races the first paint (tab
    // switch / Suspense). A bare `return` left ready=false forever because the
    // effect deps (ref objects) never change.
    if (!content || !overlay || !stage) {
      if (attachTick >= 30) {
        setRenderError('The preview canvas could not be attached.');
        return;
      }
      const retry = requestAnimationFrame(() => setAttachTick((t) => t + 1));
      return () => cancelAnimationFrame(retry);
    }
    // Electron shows the window after first paint (`show: false` until
    // ready-to-show). Attaching a GPU context to a 0×0 canvas is the classic
    // "dark preview, chrome is fine" failure on a freshly launched desktop
    // build: getContext can succeed, configure/resize then fail, and the
    // element is burned for every other tier. Wait for a real layout box.
    if ((stage.clientWidth < 2 || stage.clientHeight < 2) && attachTick < 60) {
      const retry = requestAnimationFrame(() => setAttachTick((t) => t + 1));
      return () => cancelAnimationFrame(retry);
    }

    // `window.__motionPerf` (dev builds) — the per-stage timings the HUD shows.
    installPerfDevGlobal();
    // The HUD's counters for the real-app harness (D5 measurements: the same
    // numbers the HUD shows, TS path or engine path). Read-only use.
    (window as unknown as { __premationViewportHud?: typeof viewportHudStats }).__premationViewportHud = viewportHudStats;

    const paintChrome = (): void => {
      paintOverlay(overlay, controller.ws.overlay(), dprRef.current, guideDragRef.current, controller, paintDragRef.current?.screen ?? null, timeRef.current, creationDragRef.current, paintDragRef.current?.mode ?? 'paint', {
        brushRing: brushSizeDragRef.current
          ? { at: brushSizeDragRef.current.at, px: drawToolOptions.brushSize * (controller.getView().scale || 1), hardness: usePaintStore.getState().hardness }
          : null,
        cloneHover: cloneHoverRef.current,
        cloneCompOffset: cloneCompOffsetRef.current,
        content: contentCanvasRef.current,
      });
      paintMotionPath(overlay, controller, timeRef.current, dprRef.current);
      paintRoi(overlay, controller, dprRef.current);
      paintFaceSelection(overlay, controller, dprRef.current);
    };

    // The engine draws the composition (EngineSurface, under this overlay); the
    // page draws only what it owns: handles, guides, motion paths, the ROI, the
    // face selection.
    const render = (): void => {
      paintChrome();
    };
    const disposeRender = controller.onRender(render);

    // One-shot guard: frame the comp the first time the stage settles this
    // mount. The WorkspaceController is a singleton, so its camera/auto-fit
    // state outlives a single editor visit.
    let didInitialFit = false;
    const sizeAll = (): void => {
      const rect = stage.getBoundingClientRect();
      // Skip degenerate layouts (0×0 during mount/transition) so we never poison
      // the engine viewport to 1×1 or waste the one-shot fit-to-composition.
      if (rect.width < 1 || rect.height < 1) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprRef.current = dpr;
      // Guarded the same way the content backbuffer is: writing `width` on a
      // canvas reallocates (and clears) it even when the value is unchanged,
      // and sizeAll runs from a ResizeObserver, a window resize, a rAF and a
      // settle timer — most of which arrive at a size that already holds.
      const ow = Math.max(1, Math.round(rect.width * dpr));
      const oh = Math.max(1, Math.round(rect.height * dpr));
      if (overlay.width !== ow) overlay.width = ow;
      if (overlay.height !== oh) overlay.height = oh;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      // Re-fit while auto-fit is on so the comp keeps filling the available
      // space as panels collapse/expand (AE-style). The `settled` guard avoids
      // fitting against a briefly-collapsed stage on first load (mid-mount /
      // behind the onboarding tour), which would pin the zoom to ~5%. A manual
      // zoom/pan turns auto-fit off, so this stops honoring it until "Fit".
      const settled = rect.width >= 240 && rect.height >= 160;
      // On a fresh mount (crucially, RE-ENTERING a project), frame the comp once
      // the stage settles. The singleton controller keeps the camera + auto-fit
      // flag from a previous visit, so a prior pan/zoom would otherwise leave the
      // composition framed out of view — the canvas reads as blank while the rest
      // of the editor renders. After the initial fit, honor the live auto-fit.
      if (settled && !didInitialFit) {
        didInitialFit = true;
        controller.resize(rect.width, rect.height, dpr, false);
        controller.fitComposition();
      } else {
        controller.resize(rect.width, rect.height, dpr, controller.autoFit && settled);
      }
      render();
    };
    const ro = new ResizeObserver(sizeAll);
    ro.observe(stage);
    sizeAll();
    // Catch the size once layout settles (first frame after mount).
    const raf = requestAnimationFrame(sizeAll);
    // Backstops: a window resize + a delayed re-measure recover the fit even if
    // the ResizeObserver misses a late layout settle (observed on first load).
    window.addEventListener('resize', sizeAll);
    const settleTimer = setTimeout(sizeAll, 600);

    // The picture is the engine's (EngineSurface shows its own status until the
    // first frame); the chrome is ready as soon as the overlay is sized.
    setRenderError(null);
    setReady(true);

    // The document changed (a node, a key, a clip bar): the chrome follows.
    // During playback the playhead pump already repaints every frame, so a
    // decode-landing repaint on top of that is not asked for.
    const offFrameChanged = onDocumentFrameChanged((change) => {
      if (change === 'clips' || change === 'node' || change === 'animation') {
        controller.requestRender();
        return;
      }
      const ws = useWorkspaceStore.getState();
      const tabPlaying = ws.activeTabId ? ws.tabs[ws.activeTabId]?.playing : false;
      if (!tabPlaying) controller.requestRender();
    });

    // Leaving playback repaints the chrome at the frame the playhead stopped on.
    let wasPlaying = false;
    const playSub = useWorkspaceStore.subscribe((s) => {
      const t = s.activeTabId ? s.tabs[s.activeTabId] : null;
      const playing = t?.playing === true;
      if (playing === wasPlaying) return;
      wasPlaying = playing;
      if (!playing) controller.requestRender();
    });
    // Reflect the engine cursor on the overlay (rich resize/rotate cursors).
    const cursorSub = controller.ws.cursor.events.on('changed', ({ css }) => {
      overlay.style.cursor = css;
    });
    overlay.style.cursor = controller.ws.cursor.css;

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      window.removeEventListener('resize', sizeAll);
      ro.disconnect();
      offFrameChanged();
      playSub();
      cursorSub.dispose();
      // Drop only OUR subscription. This used to install a no-op callback,
      // which — under the old single-slot onRender — silently unsubscribed
      // every other listener (both canvas overlays) as a side effect.
      disposeRender();
    };
  }, [contentCanvasRef, overlayCanvasRef, stageRef, attachTick]);

  // Publish the content canvas so surfaces OUTSIDE the viewport can find it
  // without `document.querySelector('canvas')` — which returns whichever
  // canvas is first in the DOM (a scope, a secondary pane) rather than the
  // composited frame. Cleared on unmount so a stale detached canvas is never
  // handed out.
  useEffect(() => {
    getWorkspaceController().setContentCanvas(contentCanvasRef.current);
    return () => getWorkspaceController().setContentCanvas(null);
  }, [contentCanvasRef, attachTick]);

  // ── Channel Filter Effect ──────────────────────────────────────────
  const channel = useGuidesStore((s) => s.channel);

  // ── Re-render on scene / playhead / guide changes ──────────────────
  //
  // Throttle snapshots during a property drag. `sceneRev` fires on every
  // property-edit tick (a single slider drag = 30-60 revs/second), and each
  // one rebuilds the whole snapshot — a 3D project with per-character
  // extrusion makes that expensive. Coalesce mid-drag ticks into ONE
  // trailing snapshot after the drag settles (rAF + a 50ms grace). Outside
  // a drag, render eagerly so the next paint reflects the latest edit.
  //
  // `time` is not here at all: the playhead drives the render through the
  // clock subscription below ("Playhead → render"), without React.
  const isDragging = useUIStore((s) => s.isDragging);
  useEffect(() => {
    const controller = getWorkspaceController();
    if (!isDragging) {
      controller.requestRender();
      return;
    }
    // LEADING rAF throttle, not a trailing timeout.
    //
    // The old code set a 50ms trailing timer and cancelled it in the effect's
    // cleanup — but the effect re-runs on every `sceneRev` bump, so a drag that
    // emits ticks faster than 50ms cancelled its own pending render every time
    // and NOTHING rendered until the pointer stopped. That froze the viewport
    // while scrubbing any numeric inspector field (ValueField / AngleDial both
    // set isDragging) and made Alt+drag orbit on a real Camera layer dead
    // mid-gesture, since camera nav signals only through bumpScene.
    // Rendering on the leading edge, coalesced to one frame, keeps the preview
    // live at exactly the cadence the display can show.
    let raf: number | null = requestAnimationFrame(() => {
      raf = null;
      controller.requestRender();
    });
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [sceneRev, isDragging]);
  // ── Playhead → render ──────────────────────────────────────────────
  //
  // The playhead used to reach the renderer as a React prop: clock tick →
  // WorkspaceViewport re-render (the whole viewport shell and every overlay
  // under it) → this hook's effect → requestRender for the NEXT animation
  // frame. A React commit and one vsync of latency on every played frame.
  //
  // Now the clock store is subscribed directly. A tick writes `timeRef` and
  // asks for a redraw; the playback pump then flushes that redraw inside its
  // own frame (`flushRenderNow`), and anything else — a paused seek, a scrub —
  // lands on the controller's rAF, which coalesces a burst of seeks to the
  // latest time because `render()` reads `timeRef` when it runs.
  useEffect(() => {
    const controller = getWorkspaceController();
    const sync = (): void => {
      const t = playheadTime();
      if (t === timeRef.current) return;
      timeRef.current = t;
      controller.requestRender();
    };
    sync();
    const offClock = usePlaybackClockStore.subscribe(sync);
    // Switching tabs changes WHICH clock is the playhead without either clock
    // changing value.
    const offTab = useWorkspaceStore.subscribe((s, prev) => {
      if (s.activeTabId !== prev.activeTabId) sync();
    });
    return () => {
      offClock();
      offTab();
    };
  }, []);

  useEffect(() => {
    getWorkspaceController().requestRender();
  }, [focusKey, rulers, grid, gridSpacing, gridSubdivisions, gridStyle, gridColor, proportionalGrid, proportionalColumns, proportionalRows, safeArea, camera3dMode, customViews, draft3d, channel, draft, roi, mbEnabled, mbShutter, mbSamples, compKey]);

  // ── Auto-fit on comp-size change ───────────────────────────────────
  // Switching resolution (e.g. a 9:16 reel ↔ 16:9) re-frames the comp to fill
  // the viewport, like After Effects fitting a freshly-sized comp. This also
  // re-enables auto-fit so subsequent panel collapse/expand keeps tracking.
  // Skipped on the very first mount — the mount effect's initial fit handles it.
  const didMountFitRef = useRef(false);
  useEffect(() => {
    if (!didMountFitRef.current) {
      didMountFitRef.current = true;
      return;
    }
    const controller = getWorkspaceController();
    controller.fitComposition();
    controller.requestRender();
  }, [compWidth, compHeight]);

  // ── Tool bar → engine tool ─────────────────────────────────────────
  useEffect(() => {
    const controller = getWorkspaceController();
    controller.applyUITool(useUIStore.getState().activeTool);
    return useUIStore.subscribe(
      (s) => s.activeTool,
      (tool) => controller.applyUITool(tool),
    );
  }, []);

  // ── Snap toggle → engine SnapEngine ────────────────────────────────
  // The TopNav magnet button writes uiStore.snap; the engine's snapping
  // lives in ws.setSnap — without this bridge the button is cosmetic.
  useEffect(() => {
    const controller = getWorkspaceController();
    controller.ws.setSnap({ enabled: useUIStore.getState().snap });
    return useUIStore.subscribe(
      (s) => s.snap,
      (snap) => controller.ws.setSnap({ enabled: snap }),
    );
  }, []);

  // ── Snap to Grid + grid spacing → engine ───────────────────────────
  //
  // Two things the engine could not know on its own:
  //
  //  1. `toGrid` is AE's Snap to Grid command, which is INDEPENDENT of Show
  //     Grid — AE snaps to a hidden grid, so this must not read `s.grid`.
  //  2. `snapSpacing` pins snapping to the spacing actually drawn. Without it
  //     the engine falls back to its adaptive stepper and snaps to positions
  //     that land on no visible line, and change as you zoom.
  //
  // Snapping to SUBDIVISION lines, not just gridlines, because those are drawn
  // and AE snaps to them too.
  useEffect(() => {
    const controller = getWorkspaceController();
    const apply = (s: ReturnType<typeof useGuidesStore.getState>): void => {
      const subs = Math.max(1, s.gridSubdivisions);
      controller.ws.setSnap({ toGrid: s.snapToGrid });
      controller.ws.setGrid({ visible: s.grid, snapSpacing: s.gridSpacing / subs });
    };
    apply(useGuidesStore.getState());
    let last = useGuidesStore.getState();
    // Plain subscribe + manual compare: `guidesStore` has no
    // `subscribeWithSelector` middleware (uiStore above does), so the two-arg
    // selector form would hand the whole STATE to the listener as the value.
    return useGuidesStore.subscribe((s) => {
      if (s.snapToGrid === last.snapToGrid && s.grid === last.grid
        && s.gridSpacing === last.gridSpacing && s.gridSubdivisions === last.gridSubdivisions) return;
      last = s;
      apply(s);
    });
  }, []);

  // B4 round 2: the overlays' geometry push (setOverlayGeometry) follows the selection —
  // drawn boxes and matrices for every selected layer, the motion path and text box for
  // a single one; an engine-drawn frame's geometry repaints the chrome over it.
  useEffect(() => {
    const controller = getWorkspaceController();
    const sync = (ids: readonly string[]): void => {
      void requestOverlayLayers(MAIN_VIEWPORT, 'selection', ids, ids.length === 1 ? OVERLAY_KINDS_ONE : OVERLAY_KINDS_MANY);
      // A single layer's parent: its matrix maps a motion-path drag back into the space the path is keyed in.
      const parent = ids.length === 1 ? documentMirror().layer(ids[0]!)?.parent : undefined;
      void requestOverlayLayers(MAIN_VIEWPORT, 'selectionParent', parent ? [parent] : [], ['transform']);
      // The Paint panel's clone source on another layer: its space maps an Alt-click aim.
      const source = usePaintStore.getState().cloneSourceLayerId;
      void requestOverlayLayers(MAIN_VIEWPORT, 'paintSource', source && !ids.includes(source) ? [source] : [], ['transform']);
    };
    sync(useSelectionStore.getState().ids);
    const unSel = useSelectionStore.subscribe((st) => sync(st.ids));
    const unSource = usePaintStore.subscribe((st, prev) => { if (st.cloneSourceLayerId !== prev.cloneSourceLayerId) sync(useSelectionStore.getState().ids); });
    const unGeo = subscribeOverlayGeometry(MAIN_VIEWPORT, () => controller.requestRender());
    // B4 round 5: the main view mode's camera rides every frame (camera navigation,
    // the motion path's 3D projection and the looked-through test read it — viewNav.ts).
    const unView = requestMainViewCamera();
    return () => {
      unSel();
      unSource();
      unGeo();
      unView();
    };
  }, []);

  // Face-select chrome lives on the overlay, which only repaints when something
  // asks it to — without this the highlight would not appear until the next
  // unrelated interaction.
  useEffect(() => {
    const controller = getWorkspaceController();
    const unFace = useFaceSelectionStore.subscribe(() => controller.requestRender());
    // The engine's faces landing (getLayerFaces) repaint the highlight.
    const unFaces = onLayerFaces(() => { if (useFaceSelectionStore.getState().enabled) controller.requestRender(); });
    // A face belongs to its layer: selecting a different layer must drop it,
    // or the inspector would keep pointing at a side of something else.
    const unSel = useSelectionStore.subscribe((s) => {
      const fs = useFaceSelectionStore.getState();
      if (fs.nodeId && !s.ids.includes(fs.nodeId)) fs.clear();
    });
    return () => {
      unFace();
      unFaces();
      unSel();
    };
  }, []);

  // ── Pointer + wheel input on the overlay canvas ────────────────────
  useEffect(() => {
    const controller = getWorkspaceController();
    const overlay = overlayCanvasRef.current;
    const stage = stageRef.current;
    if (!overlay || !stage) return;

    const local = (e: MouseEvent): { x: number; y: number } => {
      const rect = stage.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const buttonName = (b: number): PointerInput['button'] =>
      b === 0 ? 'left' : b === 1 ? 'middle' : b === 2 ? 'right' : 'none';
    const toPointer = (e: PointerEvent): PointerInput => ({
      position: local(e),
      pointerType: e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse',
      button: buttonName(e.button),
      buttons: { left: (e.buttons & 1) !== 0, right: (e.buttons & 2) !== 0, middle: (e.buttons & 4) !== 0 },
      modifiers: modifiersFrom(e),
      pressure: e.pressure || 0.5,
      time: performance.now(),
      pointerId: e.pointerId,
    });

    // ── AE-style viewport camera navigation ─────────────────────────
    // Orbit:  Alt+drag on the canvas        → orbitYaw / orbitPitch
    // Track:  Shift+Alt+drag or Alt+middle  → camera x/y (+ POI when two-node)
    // Dolly:  Alt+wheel                     → camera z along the view axis
    // Plus the C-key camera tool (guidesStore.cameraTool): left-drag runs the
    // active mode with NO modifier; Esc or any tool pick returns to selection.
    // Active when the comp has a Camera layer AND at least one 3D layer — or,
    // in a CUSTOM view, whenever the comp has any 3D layer (custom views need
    // no camera: nav writes the view's stored params, not scene nodes).
    // The write logic itself lives in @core/workspace/cameraNav (shared).
    let camNav: {
      target: NavTarget;
      mode: CameraNavMode;
      last: { x: number; y: number };
      pointerId: number;
      /** Orbit pivot captured at DRAG START (cursor/scene pivot modes); null
       *  = the classic POI orbit. Frozen for the gesture so it cannot slide. */
      pivot: { x: number; y: number; z: number } | null;
      /** The Unified Camera's right-drag ran a dolly: the context menu that
       *  right-RELEASE would open must be swallowed once (and only then). */
      suppressContextMenu: boolean;
    } | null = null;
    let altHintCursor = false;
    // Set when a unified right-drag ends: the browser fires contextmenu AFTER
    // pointerup, so the flag must outlive camNav by exactly one event.
    let swallowNextContextMenu = false;

    const cameraToolCursor = (mode: CameraNavMode | 'unified'): string =>
      mode === 'pan' ? 'grab' : mode === 'dolly' ? 'ns-resize' : 'move';
    const restoreCursor = (): void => {
      const tool = useGuidesStore.getState().cameraTool;
      overlay.style.cursor = tool !== 'none' ? cameraToolCursor(tool) : controller.ws.cursor.css;
    };

    const startCameraNav = (e: PointerEvent, mode: CameraNavMode, opts?: { suppressContextMenu?: boolean }): boolean => {
      // B4 round 5: the target from the frame on screen (the pushed view camera, viewNav.ts).
      const target = navTargetNow();
      if (!target) {
        // Say WHY rather than doing nothing. Inertness here is correct — a
        // camera only moves 3D layers — but silent inertness is indistinguishable
        // from a broken tool, and was reported as one.
        const why = navUnavailableNow();
        if (why) useUIStore.getState().notify({ level: 'info', message: why, durationMs: 6000 });
        return false;
      }
      // Orbit pivot (AE's Orbit Around Cursor / Scene): resolved ONCE, at drag
      // start, from the pointer's comp position — only for scene cameras;
      // views keep their promote-to-custom-view orbit (orbitNavBy ignores it).
      const pivot = mode === 'orbit' && target.kind === 'scene'
        ? orbitPivotNow(
            controller.ws.screenToWorld(local(e)),
            compRef.current.width,
            compRef.current.height,
          )
        : null;
      camNav = {
        target, mode, last: local(e), pointerId: e.pointerId, pivot,
        suppressContextMenu: opts?.suppressContextMenu === true,
      };
      e.preventDefault();
      try {
        overlay.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      useUIStore.getState().setDragging(true);
      overlay.style.cursor = mode === 'pan' ? 'grabbing' : cameraToolCursor(mode);
      return true;
    };

    const moveCameraNav = (e: PointerEvent): void => {
      const nav = camNav;
      if (!nav) return;
      const p = local(e);
      const dx = p.x - nav.last.x;
      const dy = p.y - nav.last.y;
      nav.last = p;
      if (dx === 0 && dy === 0) return;
      if (nav.mode === 'orbit') {
        orbitNavBy(nav.target, dx, dy, nav.pivot);
      } else if (nav.mode === 'dolly') {
        // Drag up (dy < 0) = dolly IN, matching Alt+wheel-up. Direct (unsmoothed)
        // writes: a drag is already continuous, easing would add lag.
        dollyNavBy(nav.target, dy, compRef.current.width, compRef.current.height);
      } else {
        trackNavBy(nav.target, dx, dy, controller.getView().scale || 1, compRef.current.width, compRef.current.height);
      }
    };

    const endCameraNav = (): void => {
      // The contextmenu event arrives after pointerup — remember the swallow
      // past camNav's lifetime (see onContextMenu).
      if (camNav?.suppressContextMenu) swallowNextContextMenu = true;
      camNav = null;
      useUIStore.getState().setDragging(false);
      restoreCursor();
    };

    // Cursor hint while Alt is held over the canvas and camera nav is possible;
    // Escape leaves the C-key camera tool (back to plain selection).
    const onAltDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && useGuidesStore.getState().cameraTool !== 'none') {
        useGuidesStore.getState().setCameraTool('none');
        return;
      }
      if (e.key !== 'Alt' || camNav || altHintCursor) return;
      if (!navTargetNow()) return;
      overlay.style.cursor = 'move';
      altHintCursor = true;
    };
    // Esc mid-drag reverts what the drag has written so far (the engine
    // gesture is cancelled; the rest of the drag is ignored until release).
    // Capture phase, so the same Esc does not also clear the selection.
    const onEscCancel = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (!cancelToolGesture()) return;
      e.preventDefault();
      e.stopPropagation();
      controller.requestRender();
    };
    const onAltUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Alt' || !altHintCursor) return;
      altHintCursor = false;
      if (!camNav) restoreCursor();
    };

    // The camera tool owns the viewport cursor while active; picking any
    // toolbar tool (V etc.) exits camera mode — AE's "V returns to selection".
    const guidesSub = useGuidesStore.subscribe((s, prev) => {
      if (s.cameraTool !== prev.cameraTool && !camNav) {
        overlay.style.cursor =
          s.cameraTool !== 'none' ? cameraToolCursor(s.cameraTool) : controller.ws.cursor.css;
      }
      // Leaving the camera tool cancels any in-flight eased wheel dolly.
      if (s.cameraTool === 'none' && prev.cameraTool !== 'none') cancelSmoothDolly();
    });
    const toolSub = useUIStore.subscribe(
      (s) => s.activeTool,
      () => {
        if (useGuidesStore.getState().cameraTool !== 'none') {
          useGuidesStore.getState().setCameraTool('none');
        }
      },
    );

    const onDown = (e: PointerEvent): void => {
      // One anim/scene transaction per pointer gesture — every write between
      // here and pointerup batches (see viewportGesture.ts). Ending any stale
      // gesture first keeps a lost pointerup (capture failed, window switch)
      // from leaking a permanently-open transaction.
      endViewportGesture();
      beginViewportGesture();
      // Any press in the main viewport takes the active viewer back from a
      // secondary pane, so the focus ring always names the viewport that will
      // receive the next keyboard action.
      if (useGuidesStore.getState().activeViewPane !== null) {
        useGuidesStore.getState().setActiveViewPane(null);
      }
      // Alt+middle-drag = camera Track XY — claim before the left-button guard.
      if (e.button === 1 && e.altKey && startCameraNav(e, 'pan')) return;
      // Unified Camera (AE): while armed, the BUTTON picks the gesture —
      // left orbits, middle pans (track XY), right dollies (track Z). Claimed
      // before the left-only guard because its middle/right drags are camera
      // gestures, not canvas interactions; the right-drag also swallows the
      // context menu its release would otherwise open (only while armed).
      if (useGuidesStore.getState().cameraTool === 'unified') {
        const mode = unifiedNavModeFor(e.button);
        if (mode && startCameraNav(e, mode, { suppressContextMenu: e.button === 2 })) return;
      }
      if (e.button !== 0) return; // left-button interactions only
      // C-key camera tool: plain left-drag runs the active orbit/pan/dolly
      // mode (no Alt needed). Claims the press before any canvas interaction.
      {
        const camTool = useGuidesStore.getState().cameraTool;
        if (camTool !== 'none' && camTool !== 'unified' && startCameraNav(e, camTool)) return;
      }
      // Ruler guides: pointer-down inside a ruler strip drags out a NEW guide
      // (top strip → horizontal 'y' guide, left strip → vertical 'x' guide).
      // Checked before anything is forwarded to the engine.
      if (overlaysRef.current.rulers) {
        const p = local(e);
        const strips = rulerStrips(stage.clientWidth, stage.clientHeight);
        const axis: GuideAxis | null = inStrip(strips.top, p) ? 'y' : inStrip(strips.left, p) ? 'x' : null;
        if (axis) {
          guideDragRef.current = { axis, guideId: null, screen: p, overRuler: true };
          try {
            overlay.setPointerCapture(e.pointerId);
          } catch {
            /* best-effort */
          }
          useUIStore.getState().setDragging(true);
          overlay.style.cursor = guideCursor(axis);
          guideCursorRef.current = true;
          controller.requestRender();
          return;
        }
      }
      // Region of Interest: grabbing a grip resizes the region. Only the EDGES
      // are interactive (roiHandleAt ignores the interior), so clicking inside
      // the region still selects the layer under it, as in AE.
      {
        const roi = useGuidesStore.getState().roi;
        if (roi) {
          const cp = controller.ws.screenToWorld(local(e));
          const tol = 8 / (controller.getView().scale || 1);
          const handle = roiHandleAt(roi, cp, tol);
          if (handle) {
            e.preventDefault();
            roiDragRef.current = { handle, pointerId: e.pointerId };
            try {
              overlay.setPointerCapture(e.pointerId);
            } catch {
              /* best-effort */
            }
            useUIStore.getState().setDragging(true);
            overlay.style.cursor = roiHandleCursor(handle);
            return;
          }
        }
      }
      // Face-select mode: a click picks the SIDE of an extruded object under the
      // pointer instead of starting a layer drag, so the Face Materials editor
      // can target it. Off by default — ordinary clicks must keep selecting and
      // moving layers.
      if (useFaceSelectionStore.getState().enabled) {
        const comp = compSize();
        const at = controller.ws.screenToWorld(local(e));
        const time = playheadTime();
        e.preventDefault();
        // The faces are the ENGINE's (getLayerFaces, B4 round 8): a layer's
        // faces this frame, projected through the view on screen. The pick
        // resolves when the answer lands (at once when it is cached).
        const faceOf = async (id: string | undefined) => {
          if (!id) return null;
          const faces = await fetchLayerFaces(id, time);
          const face = pickFace(projectFacesForView(faces, time, comp.w, comp.h), at);
          return face ? { id, face } : null;
        };
        const selected = useSelectionStore.getState().ids[0];
        const hit = controller.ws.hitTestScreen(local(e))?.id;
        void (async () => {
          // The layer being styled wins over whatever the plain hit-test finds:
          // a flat layer drawn in front of it would otherwise swallow every
          // click, and it has no faces to offer in exchange.
          const picked = (await faceOf(selected)) ?? (hit !== selected ? await faceOf(hit) : null);
          if (picked) {
            // Select the layer too: the inspector edits face materials on the
            // selected layer, so a face with no layer selected has nothing to
            // write to.
            useSelectionStore.getState().set([picked.id]);
            useFaceSelectionStore.getState().select(picked.id, picked.face.kind, picked.face.suffix);
          } else {
            // Clicking empty canvas in face mode drops the face, keeping the layer.
            useFaceSelectionStore.getState().clear();
          }
          controller.requestRender();
        })();
        return;
      }
      /*
       * PAINT — AE's Paint effect: strokes stored on an existing layer.
       *
       * Its own tool, and that is the fix for a real bug. This used to be a
       * hidden mode of the BRUSH: "brush tool + exactly one paintable layer
       * selected + the pointer is over it" silently painted into that layer
       * instead of drawing a freehand ribbon. Every branch of that condition is
       * satisfied by accident, because `createNode` selects the layer it just
       * made — so the FIRST brush stroke created a ribbon layer and selected it,
       * and the SECOND stroke, if it started anywhere on top of the first, was
       * quietly a different tool. It painted into the first stroke's layer, in
       * that layer's local space, clipped to that layer's box.
       *
       * That is precisely the reported symptom: draw, stop, draw again, and the
       * second stroke comes out looking nothing like the first with part of it
       * missing — while a single unbroken stroke was always fine, because a
       * stroke that never ends never re-enters this branch.
       *
       * Two tools cannot share one gesture and be told apart by what happens to
       * be under the cursor. Paint is now something the user picks.
       */
      const paintTool = useUIStore.getState().activeTool;
      if (paintTool === 'paint' || paintTool === 'eraser') {
        const erasing = paintTool === 'eraser';
        const ids = useSelectionStore.getState().ids;
        const node = ids.length === 1 ? documentMirror().layer(ids[0]!) : undefined;
        if (!node || !isPaintableLayer(node)) {
          // Say why nothing happened. Silently falling through to the engine
          // here is what a marquee-select on a paint stroke would look like.
          useUIStore.getState().notify({
            level: 'info',
            message: erasing ? 'Select one layer to erase on.' : 'Select one layer to paint on.',
            durationMs: 2600,
          });
          return;
        }
        // No hit-test against the stack. This used to require the selected layer
        // to be the TOPMOST thing under the cursor, so a layer lying under
        // another one silently took no paint at all. AE paints the layer you
        // target, wherever it sits; a stroke off its surface simply clips.
        e.preventDefault();
        const cp = controller.ws.screenToWorld(local(e));
        // The layer's placement AT THE PLAYHEAD — parent chain, keyframes, and
        // for a 3D layer the view on screen. Resolved once and carried on the
        // drag, so the whole stroke maps through the pose it was drawn over.
        const comp = compSize();
        const space = paintSpaceFromPush(node.id, playheadTime(), { width: comp.w, height: comp.h });
        const pressLocal = space?.toLocal(cp) ?? null;
        if (!space || !pressLocal) {
          // Edge-on to the view (or scaled to nothing): there is no surface
          // under the pointer, and guessing one paints somewhere else.
          useUIStore.getState().notify({
            level: 'info',
            message: 'This layer has no surface under the pointer in this view — turn it or change the view to paint on it.',
            durationMs: 2600,
          });
          return;
        }
        // The mode rides on the DRAG, not on the store. The eraser is not "paint
        // with a checkbox someone remembered to tick" — its whole identity is
        // that it erases, so it must not be able to lay down colour because a
        // shared setting happened to be on `paint` when it started.
        const paintSettings = usePaintStore.getState();
        // Ctrl-drag sizes the brush instead of painting (Ctrl+Shift stays the
        // eraser's Last Stroke Only).
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
          brushSizeDragRef.current = { at: local(e), startX: e.clientX, start: { size: drawToolOptions.brushSize, hardness: paintSettings.hardness } };
          try {
            overlay.setPointerCapture(e.pointerId);
          } catch {
            /* best-effort */
          }
          controller.requestRender();
          return;
        }
        const dragMode = erasing ? 'erase' : paintSettings.mode === 'clone' ? 'clone' : 'paint';
        if (dragMode === 'clone') {
          // Clone stamp aiming: Alt-click SETS the source and lays no paint —
          // the classic gesture. Stored in the SOURCE layer's own space (this
          // layer, or the Paint panel's Source layer), so it follows that layer
          // through its animation and cannot leak onto an unrelated one.
          if (e.altKey) {
            const srcId = paintSettings.cloneSourceLayerId && paintSettings.cloneSourceLayerId !== node.id
              ? paintSettings.cloneSourceLayerId
              : node.id;
            const srcSpace = srcId === node.id ? space : paintSpaceFromPush(srcId, playheadTime(), { width: comp.w, height: comp.h });
            const at = srcSpace?.toLocal(cp) ?? null;
            if (!at) return;
            paintSettings.set({ cloneSource: { nodeId: srcId, x: at.x, y: at.y, compX: cp.x, compY: cp.y }, alignedOffset: null });
            cloneCompOffsetRef.current = null;
            useUIStore.getState().notify({ level: 'info', message: 'Clone source set.', durationMs: 1400 });
            return;
          }
          // A stroke without a usable source has nothing to sample, so it
          // refuses with the reason instead of painting nothing silently. A
          // source aimed on another layer counts only when the Paint panel's
          // Source names that layer; otherwise it is dropped, not reinterpreted.
          const source = paintSettings.cloneSource;
          if (!source || (source.nodeId !== node.id && source.nodeId !== paintSettings.cloneSourceLayerId)) {
            if (source) paintSettings.set({ cloneSource: null });
            useUIStore.getState().notify({
              level: 'info',
              message: 'Alt-click to set the clone source first.',
              durationMs: 2600,
            });
            return;
          }
          // Aligned: the first stroke after aiming fixes the overlay's offset too.
          if (!paintSettings.alignedOffset && source.compX !== undefined && source.compY !== undefined) {
            cloneCompOffsetRef.current = { x: source.compX - cp.x, y: source.compY - cp.y };
          }
        }
        paintDragRef.current = {
          nodeId: node.id,
          comp: [cp],
          screen: [local(e)],
          mode: dragMode,
          space,
          times: [e.timeStamp],
          pen: [penSample(e)],
          shift: e.shiftKey && !(e.ctrlKey || e.metaKey),
          lastStrokeOnly: erasing && e.shiftKey && (e.ctrlKey || e.metaKey),
          compTime: playheadTime(),
        };
        try {
          overlay.setPointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }
        useUIStore.getState().setDragging(true);
        controller.requestRender();
        return;
      }
      // E4: grabbing a motion-path keyframe dot starts a local drag that edits
      // the keyframe directly (the engine never sees it, so it can't also
      // move/marquee the layer).
      const hit = hitMotionPathKeyframe(controller, local(e));
      if (hit) {
        // AE Convert Vertex: Ctrl/Cmd(+Alt)-click a path vertex toggles it
        // between a corner (Linear) and Auto Bezier — a click, not a drag.
        if (hit.part === 'point' && (e.ctrlKey || e.metaKey)) {
          void convertMotionPathVertex(hit.nodeId, hit.t).then(() => controller.requestRender());
          return;
        }
        // B4: the drag starts from the engine's stored Position tracks
        // (getMemberKeyframes), asked at press; moves before they land are
        // replayed once they do (`latest`).
        const mp = {
          ...hit,
          gesture: new GestureSession(hit.part === 'point' ? 'Move keyframe' : 'Adjust path tangent'),
          start: {} as PositionTracks,
          ids: null as PositionKeyIds | null,
          latest: null as (() => Command[]) | null,
          continuous: true,
          broken: false,
          ready: Promise.resolve(),
        };
        mp.ready = capturePositionTracks(hit.nodeId).then(async (start) => {
          mp.start = start;
          mp.continuous = positionTangentContinuous(hit.nodeId, hit.t, start);
          mp.ids = await resolvePositionKeyIds(hit.nodeId, start);
          if (mp.latest) mp.gesture.send(mp.latest());
        });
        mpDragRef.current = mp;
        try {
          overlay.setPointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }
        useUIStore.getState().setDragging(true);
        return;
      }
      // AE-style camera navigation: Alt+drag orbits, Shift+Alt+drag tracks XY.
      // Checked AFTER the motion-path handle test above, so Alt+dragging a path
      // tangent handle keeps its break-the-pair behavior (see onMove's
      // setPathTangent), and camera nav only claims presses on open canvas.
      if (e.altKey && startCameraNav(e, e.shiftKey ? 'pan' : 'orbit')) return;
      // Ruler guides: grabbing an existing guide line (rulers visible) moves it.
      if (overlaysRef.current.rulers) {
        const p = local(e);
        const g = hitGuideAt(controller, p);
        if (g) {
          guideDragRef.current = { axis: g.axis, guideId: g.id, screen: p, overRuler: false };
          try {
            overlay.setPointerCapture(e.pointerId);
          } catch {
            /* best-effort */
          }
          useUIStore.getState().setDragging(true);
          overlay.style.cursor = guideCursor(g.axis);
          guideCursorRef.current = true;
          return;
        }
      }
      try {
        overlay.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer — capture is best-effort */
      }
      const activeTool = useUIStore.getState().activeTool;
      // AE Type tool: a press on an EXISTING text layer edits it rather than
      // creating another. Resolved on release (see onUp), so the press's own
      // mousedown cannot blur the editor it would open.
      if ((activeTool === 'text' || activeTool === 'vertical-text') && !e.shiftKey) {
        const hit = controller.ws.hitTestScreen(local(e));
        const hitNode = hit ? documentMirror().layer(hit.id) : undefined;
        if (hitNode && !hitNode.switches.locked && hitNode.kind === 'text') {
          typeEditRef.current = hitNode.id;
          return;
        }
      }
      // 'text': a Type-tool drag draws a paragraph box, previewed like a shape.
      const isCreationTool = ['shape', 'ellipse', 'polygon', 'star', 'line', 'mask-rect', 'mask-ellipse', 'text', 'vertical-text'].includes(activeTool);
      if (isCreationTool) {
        const p = local(e);
        creationDragRef.current = { start: p, current: p, tool: activeTool };
      }
      viewportPressRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
      controller.ws.setFocused(true);
      controller.ws.feedPointerDown(toPointer(e));
    };
    const onMove = (e: PointerEvent): void => {
      // Promote an armed press to a real drag on the first movement past the
      // threshold, so `isDragging` means "the pointer is actually dragging"
      // rather than "a button is down". Matches the engine's own drag
      // threshold (InputSystem's `dragThreshold`), so the UI flag and the
      // tool's onDragStart flip on the same movement.
      const press = viewportPressRef.current;
      if (press && !press.dragging && press.pointerId === e.pointerId
          && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= VIEWPORT_DRAG_SLOP) {
        press.dragging = true;
        useUIStore.getState().setDragging(true);
      }
      // Active viewport-camera navigation (orbit / track) claims the move.
      if (camNav && camNav.pointerId === e.pointerId) {
        moveCameraNav(e);
        return;
      }
      // Region-of-Interest resize in progress.
      {
        const rd = roiDragRef.current;
        if (rd && rd.pointerId === e.pointerId) {
          const roi = useGuidesStore.getState().roi;
          if (roi) {
            const cp = controller.ws.screenToWorld(local(e));
            const comp = compSize();
            useGuidesStore.getState().setRoi(
              clampRoi(resizeRoi(roi, rd.handle, cp), comp.w, comp.h),
            );
          }
          return;
        }
      }
      // Info readout (AE's Info panel): comp-space position + the sampled
      // pixel under the cursor. `useWorkspaceProbe` documents why the pixel
      // half is hover-only.
      {
        const p = local(e);
        publishProbe({
          screen: p,
          world: controller.ws.screenToWorld(p),
          content: contentCanvasRef.current,
          buttons: e.buttons,
        });
      }
      // Ctrl-drag brush sizing: Diameter while Ctrl is held, Hardness after.
      if (brushSizeDragRef.current) {
        const bs = brushSizeDragRef.current;
        const zoom = controller.getView().scale || 1;
        const phase = e.ctrlKey || e.metaKey ? 'size' : 'hardness';
        const next = ctrlDragBrush(bs.start, (e.clientX - bs.startX) / zoom, phase);
        drawToolOptions.brushSize = next.size;
        if (phase === 'hardness') usePaintStore.getState().set({ hardness: next.hardness });
        controller.requestRender();
        return;
      }
      // Clone Source Overlay follows the pointer while cloning.
      {
        const ps = usePaintStore.getState();
        const cloning = useUIStore.getState().activeTool === 'paint' && ps.mode === 'clone' && ps.cloneOverlay;
        if (cloning) {
          cloneHoverRef.current = local(e);
          if (!paintDragRef.current) controller.requestRender();
        } else if (cloneHoverRef.current) {
          cloneHoverRef.current = null;
          controller.requestRender();
        }
      }
      // Active Brush paint: append the sample and repaint the wet-stroke preview.
      if (paintDragRef.current) {
        paintDragRef.current.comp.push(controller.ws.screenToWorld(local(e)));
        paintDragRef.current.screen.push(local(e));
        paintDragRef.current.times.push(e.timeStamp);
        paintDragRef.current.pen.push(penSample(e));
        controller.requestRender();
        return;
      }
      // Active ruler-guide drag: track the pointer, live-move existing guides,
      // and flag when the pointer is back over the source ruler (= cancel/delete).
      const gd = guideDragRef.current;
      if (gd) {
        const p = local(e);
        gd.screen = p;
        const strips = rulerStrips(stage.clientWidth, stage.clientHeight);
        gd.overRuler = inStrip(gd.axis === 'y' ? strips.top : strips.left, p);
        if (gd.guideId) {
          const w = controller.ws.screenToWorld(p);
          controller.ws.guides.move(gd.guideId, gd.axis === 'x' ? w.x : w.y);
        }
        controller.requestRender();
        return;
      }
      // Hover cursor over rulers / guide lines (only while no buttons are down).
      if (overlaysRef.current.rulers && e.buttons === 0) {
        const p = local(e);
        const strips = rulerStrips(stage.clientWidth, stage.clientHeight);
        const cursor = inStrip(strips.top, p)
          ? 'ns-resize'
          : inStrip(strips.left, p)
            ? 'ew-resize'
            : (() => {
                const g = hitGuideAt(controller, p);
                return g ? guideCursor(g.axis) : null;
              })();
        if (cursor) {
          overlay.style.cursor = cursor;
          guideCursorRef.current = true;
        } else if (guideCursorRef.current) {
          overlay.style.cursor = controller.ws.cursor.css;
          guideCursorRef.current = false;
        }
      }
      // Motion-path handle hover (idle only): light the dot before the press.
      if (e.buttons === 0 && useGuidesStore.getState().motionPathVisible) {
        const hover = hitMotionPathKeyframe(controller, local(e));
        if (
          (hover?.nodeId ?? null) !== (mpHover?.nodeId ?? null) ||
          hover?.t !== mpHover?.t ||
          hover?.part !== mpHover?.part
        ) {
          mpHover = hover;
          controller.requestRender();
        }
      }
      const drag = mpDragRef.current;
      if (drag) {
        const w = controller.ws.screenToWorld(local(e));
        const part = drag.part;
        // Back through the parent chain: `w` is where the pointer is in COMP
        // space and the x/y tracks hold parent-space values.
        const lp = compToPath(drag.nodeId, playheadTime(), w);
        // Alt breaks the handle pair and it STAYS broken for the rest of the
        // drag (and, via Keyframe.continuous, for the next one).
        if (e.altKey) drag.broken = true;
        const { nodeId, t } = drag;
        // One undo step for the whole drag: the engine gesture opened on press.
        // Every message is built from the PRESS state (`drag.start`, read when
        // the thunk runs — it may land after the first moves) + this pointer.
        drag.latest = part === 'point'
          // Move the point in 2D (both axis tracks get a key at this time;
          // spatial tangents are relative offsets, so they travel with it).
          // `t` is ALREADY the stored keyframe time.
          ? () => positionKeyPatchCommands(nodeId, drag.start, drag.ids!, (scratch) => {
            scratch.setKeyframe(nodeId, 'x', t, lp.x);
            scratch.setKeyframe(nodeId, 'y', t, lp.y);
          })
          // Pull a spatial tangent handle — bends the path. Mirrored when the
          // point is still continuous (AE smooth).
          : () => positionKeyPatchCommands(nodeId, drag.start, drag.ids!, (scratch) => {
            // B3-legacy: not a write — the tangent arithmetic runs on the scratch engine passed
            // in; the document edit is the `updateKeyframes` built from it (rule false positive).
            setPathTangent(nodeId, t, part, lp, drag.continuous && !drag.broken, scratch);
          });
        if (drag.ids) drag.gesture.send(drag.latest());
        controller.requestRender();
        return;
      }
      if (creationDragRef.current) {
        creationDragRef.current.current = local(e);
      }
      controller.ws.feedPointerMove(toPointer(e));
      if (e.buttons > 0) {
        controller.requestRender();
      }
    };
    const onUp = (e: PointerEvent): void => {
      // Close the gesture FIRST: every early-returning branch below is part of
      // the same pointer gesture, and the final writes all happened on the
      // preceding moves. Records the drag's single undo command and fires the
      // one deferred structural bump.
      endViewportGesture();
      try {
        if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (typeEditRef.current) {
        const id = typeEditRef.current;
        typeEditRef.current = null;
        useSelectionStore.getState().set([id]);
        useTextEditStore.getState().begin(id);
        controller.requestRender();
        return;
      }
      if (roiDragRef.current && roiDragRef.current.pointerId === e.pointerId) {
        roiDragRef.current = null;
        useUIStore.getState().setDragging(false);
        restoreCursor();
        controller.requestRender();
        return;
      }
      // Finish a viewport-camera navigation drag (props already written live).
      if (camNav && camNav.pointerId === e.pointerId) {
        endCameraNav();
        return;
      }
      if (brushSizeDragRef.current) {
        brushSizeDragRef.current = null;
        controller.requestRender();
        return;
      }
      // Commit the Brush paint pass: map every sample into layer space and add
      // ONE stroke (one undo step), then clear the wet-stroke preview.
      const pd = paintDragRef.current;
      if (pd) {
        paintDragRef.current = null;
        useUIStore.getState().setDragging(false);
        if (documentMirror().layer(pd.nodeId)) {
          // Thin the drag first. Every pointer sample used to be stored, so a
          // slow stroke carried thousands of sub-pixel-apart points into the
          // document, every undo snapshot and every raster's cache key. Same
          // 0.5 px jitter rule the Layer panel applies as it samples.
          const keptIdx = thinSamples(pd.screen, 0.5);
          // Through the pose resolved at press time (parents, keyframes, 3D).
          // A sample that slid off an edge-on layer is dropped, not pinned to
          // the layer origin — with its timestamp and pen input, so the three
          // stay parallel.
          const points: Array<{ x: number; y: number }> = [];
          const times: number[] = [];
          const pen: typeof pd.pen = [];
          for (const i of keptIdx) {
            const p = pd.space.toLocal(pd.comp[i]!);
            if (!p) continue;
            points.push(p);
            times.push(pd.times[i] ?? 0);
            pen.push(pd.pen[i] ?? null);
          }
          if (points.length > 0) {
            // One stroke, ONE undo step, through the commit the Layer panel
            // uses. Mode comes from the DRAG, not the store: the eraser decided
            // it when the stroke began. Size is a comp-pixel diameter → the
            // layer's local units, measured through the same mapping as the
            // points, so parent, animated and 3D scale all count.
            // One engine edit, the same commit as the Layer panel's surface.
            void commitPaintDrag({
              nodeId: pd.nodeId,
              mode: pd.mode,
              points,
              times,
              pen,
              size: pd.space.brushSize(pd.comp[keptIdx[0] ?? 0]!, drawToolOptions.brushSize),
              compTime: pd.compTime,
              continueStroke: pd.shift,
              lastStrokeOnly: pd.lastStrokeOnly,
            }).then((result) => {
              if (!result.ok && result.reason) {
                useUIStore.getState().notify({ level: 'info', message: result.reason, durationMs: 2600 });
              }
            });
          }
        }
        controller.requestRender();
        return;
      }
      // Finish a ruler-guide drag: commit (add/move) or cancel/delete on the ruler.
      const gd = guideDragRef.current;
      if (gd) {
        guideDragRef.current = null;
        useUIStore.getState().setDragging(false);
        const p = local(e);
        const strips = rulerStrips(stage.clientWidth, stage.clientHeight);
        const overRuler = inStrip(gd.axis === 'y' ? strips.top : strips.left, p);
        const w = controller.ws.screenToWorld(p);
        const pos = gd.axis === 'x' ? w.x : w.y;
        if (gd.guideId) {
          if (overRuler) controller.ws.removeGuide(gd.guideId);
          else controller.ws.guides.move(gd.guideId, pos);
        } else if (!overRuler) {
          controller.ws.addGuide(gd.axis, pos);
        }
        restoreCursor();
        guideCursorRef.current = false;
        controller.requestRender();
        return;
      }
      if (mpDragRef.current) {
        const mp = mpDragRef.current;
        mpDragRef.current = null;
        // Commit once the key ids (and so the last move) have landed.
        void mp.ready.then(() => mp.gesture.end());
        useUIStore.getState().setDragging(false);
        return;
      }
      if (creationDragRef.current) {
        creationDragRef.current = null;
        controller.requestRender();
      }
      viewportPressRef.current = null;
      useUIStore.getState().setDragging(false);
      controller.ws.feedPointerUp(toPointer(e));
    };
    const onDoubleClick = (e: MouseEvent): void => {
      // AE 26.5: double-click a guide → its editor (position, unit, pin, colour).
      {
        const g = hitGuideAt(controller, local(e as unknown as PointerEvent), true);
        if (g && g.kind === 'user') {
          e.preventDefault();
          e.stopPropagation();
          openGuideEditor(g.id);
          return;
        }
      }
      const sel = useSelectionStore.getState().ids;
      if (sel.length === 1) {
        const m = documentMirror();
        const node = m.layer(sel[0]!);
        if (node) {
          if (node.kind === 'text') {
            e.preventDefault();
            e.stopPropagation();
            // On-canvas editor (TextEditOverlay, mounted by Workspace) — NOT
            // window.prompt, which Electron's Chromium refuses to show, so the
            // desktop app's double-click did nothing at all.
            useTextEditStore.getState().begin(node.id);
            return;
          }
          // AE: double-clicking a layer in the Composition panel opens it — a
          // precomp's composition, footage and solids in the Layer panel — per
          // the two "Opening Layers with Double-click" preferences, Alt
          // swapping them (see openLayer.ts). Only with the Selection tool or
          // a paint/roto tool (AE opens the Layer panel for those), and only
          // ON the layer — a double-click on empty canvas while it happens to
          // be selected, or a pen tool closing a path, is not a request to
          // open anything.
          const tool = useUIStore.getState().activeTool as string;
          if (tool === 'select' || tool === 'brush' || tool === 'paint' || tool === 'eraser' || tool === 'roto') {
            const hit = controller.ws.hitTestScreen(local(e as unknown as PointerEvent));
            if (hit && (hit.id === node.id || isMirrorDescendantOf(m, hit.id, node.id)) && openLayerOnDoubleClick(node.id, { alt: e.altKey })) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }
        }
      }

      controller.ws.feedPointerUp({
        position: local(e as unknown as PointerEvent),
        pointerType: 'mouse',
        button: 'left',
        buttons: { left: false, right: false, middle: false },
        modifiers: modifiersFrom(e),
        pressure: 0.5,
        time: performance.now(),
        pointerId: 0,
      });
    };
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      // The Unified Camera's right-drag was a dolly, not a menu request. The
      // swallow is one-shot and armed only by that gesture, so the context
      // menu behaves normally the moment the tool is released.
      if (swallowNextContextMenu) {
        swallowNextContextMenu = false;
        return;
      }
      // A right-PRESS while the unified tool is armed that produced no drag
      // (startCameraNav refused: no camera/3D) still falls through here and
      // opens the menu — the tool only owns the button when it can act.
      if (camNav?.suppressContextMenu) return;
      // A motion-path keyframe first (the most specific target under the
      // pointer): AE's Keyframe Interpolation ▸ Spatial Interpolation.
      if (useGuidesStore.getState().motionPathVisible) {
        const mp = hitMotionPathKeyframe(controller, local(e));
        if (mp && mp.part === 'point') {
          openContextMenu(e.clientX, e.clientY, motionPathKeyframeMenuItems(mp.nodeId, mp.t));
          return;
        }
      }
      // Then a user guide (locked ones too — the menu is how you unlock it).
      {
        const g = hitGuideAt(controller, local(e), true);
        if (g && g.kind === 'user') {
          openContextMenu(e.clientX, e.clientY, guideContextMenuItems(g.id));
          return;
        }
      }
      const node = controller.ws.hitTestScreen(local(e));
      if (node) {
        // Match click-select behavior: right-clicking an unselected node selects it.
        const sel = useSelectionStore.getState();
        if (!sel.ids.includes(node.id)) sel.set([node.id]);
        openContextMenu(e.clientX, e.clientY, nodeContextMenuItems(node.id));
      } else {
        openContextMenu(e.clientX, e.clientY, canvasContextMenuItems(controller));
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      // Alt+wheel = camera dolly along the view axis (toward/away from POI).
      // Default z is -focalLength (comp plane 1:1), so wheel-up (deltaY < 0)
      // pushes z toward 0 = dolly IN.
      // The unified tool wheels a dolly too — AE's Unified Camera does.
      if (
        e.altKey
        || useGuidesStore.getState().cameraTool === 'dolly'
        || useGuidesStore.getState().cameraTool === 'unified'
      ) {
        if (navTargetNow()) {
          // Smooth dolly: wheel ticks feed an rAF easer instead of stepping z
          // (or a custom view's distance) directly — see cameraNav.ts.
          smoothDollyNavBy(e.deltaY, compRef.current.width, compRef.current.height);
          return;
        }
      }
      const w: WheelInput = {
        position: local(e),
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        isZoom: e.ctrlKey,
        modifiers: modifiersFrom(e),
        time: performance.now(),
      };
      controller.ws.feedWheel(w);
    };

    // Info readout: clear the pixel/position when the cursor leaves the canvas.
    const onLeave = (): void => {
      clearProbe();
      if (mpHover) {
        mpHover = null;
        controller.requestRender();
      }
      if (!camNav && !roiDragRef.current && !guideDragRef.current && !altHintCursor) {
        guideCursorRef.current = false;
        restoreCursor();
      }
    };

    overlay.addEventListener('pointerdown', onDown);
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', onUp);
    overlay.addEventListener('pointerleave', onLeave);
    overlay.addEventListener('dblclick', onDoubleClick);
    overlay.addEventListener('contextmenu', onContextMenu);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onAltDown);
    window.addEventListener('keydown', onEscCancel, true);
    window.addEventListener('keyup', onAltUp);

    return () => {
      overlay.removeEventListener('pointerdown', onDown);
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      overlay.removeEventListener('pointercancel', onUp);
      overlay.removeEventListener('pointerleave', onLeave);
      overlay.removeEventListener('dblclick', onDoubleClick);
      overlay.removeEventListener('contextmenu', onContextMenu);
      overlay.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onAltDown);
      window.removeEventListener('keydown', onEscCancel, true);
      window.removeEventListener('keyup', onAltUp);
      guidesSub();
      toolSub();
      cancelSmoothDolly();
      controller.ws.cancelTransientInput();
      // Unmounting mid-drag must not leak an open gesture transaction.
      endViewportGesture();
      // …nor an open engine gesture (an open one refuses undo): commit it.
      const mp = mpDragRef.current;
      mpDragRef.current = null;
      if (mp) void mp.ready.then(() => mp.gesture.end());
      useUIStore.getState().setDragging(false);
      overlay.style.cursor = '';
    };
  }, [overlayCanvasRef, stageRef]);

  return { ready, renderError };
}

/*
 * The canvas context menus moved to `useWorkspaceContextMenu.ts`.
 *
 * They were ~290 lines of pure top-level builders — node menu, footage
 * submenu, empty-canvas menu, and the four helpers they share — with no
 * dependency on this hook's refs, backend or render loop. That made them the
 * one block that could leave without threading state, which is why they were
 * the first to go.
 */


// ── Overlay painter ──────────────────────────────────────────────────
/**
 * Overlay opacity (View Options / the header strip's slider) folded into a
 * painter's own alpha.
 *
 * The reference chrome — guides and the safe-area cage — is drawn over the
 * COMPOSITION, and how loud it should be depends on the footage under it: a
 * dashed white cage that reads perfectly over a dark plate is unusable over a
 * white one. `guidesStore.overlayOpacity` is that dial, and it MULTIPLIES the
 * alpha each painter already chose rather than replacing it, so the relative
 * weighting between (say) the action-safe box and its label survives.
 *
 * Interactive handles are deliberately NOT faded by it: a grip you are about
 * to drag has to stay solid, or the dial becomes a way to make the viewport
 * unusable.
 */
function refAlpha(base: number): number {
  return base * clampOverlayOpacity(useGuidesStore.getState().overlayOpacity);
}

function paintOverlay(
  canvas: HTMLCanvasElement,
  overlay: WorkspaceOverlay,
  dpr: number,
  guideDrag: GuideDrag | null = null,
  controller?: WorkspaceController,
  paintStroke: Array<{ x: number; y: number }> | null = null,
  // Kept for call-site positional compatibility; the playhead-sampled camera
  // and light guides that used it now live in the 3D gizmo overlay.
  _time = 0,
  creationDrag: { start: { x: number; y: number }; current: { x: number; y: number }; tool: Tool } | null = null,
  /**
   * The in-flight stroke's mode, captured when it started.
   *
   * Passed in rather than read from `usePaintStore` here, because the ERASER
   * forces `erase` on its own drag while the shared store may still say
   * `paint` — reading the store would preview white ink for a stroke that is
   * about to cut a hole.
   */
  paintMode: PaintMode = 'paint',
  /**
   * Paint-tool chrome: the Ctrl-drag Diameter/Hardness ring, and the Clone
   * Source Overlay — what the clone stamp would lay down under the pointer,
   * sampled from the rendered viewport at the source offset (the Aligned
   * offset once a stroke has fixed it, else the aimed source point).
   */
  paintChrome: {
    brushRing: { at: { x: number; y: number }; px: number; hardness: number } | null;
    cloneHover: { x: number; y: number } | null;
    cloneCompOffset: { x: number; y: number } | null;
    content: HTMLCanvasElement | null;
  } | null = null,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;

  const guidesState = useGuidesStore.getState();
  if (guidesState.safeArea && controller) {
    paintSafeArea(ctx, controller);
  }

  // Display mode. Drawn FIRST so the selection outline, handles and every
  // other piece of chrome stay on top of it.
  const displayMode = useViewportDisplayStore.getState().displayMode;
  if (displayMode !== 'shaded' && controller) {
    paintDisplayMode(ctx, controller, displayMode);
  }
  // Per-layer Quality = Wireframe: the renderer skipped these layers' pixels.
  // Gated: `sceneNodes()` resolves every layer's world geometry, which is
  // only worth paying when there is a wireframe layer to draw.
  if (controller && compHasWireframeQualityLayer()) {
    paintWireframeQualityLayers(ctx, controller.sceneNodes(), (p) => controller.ws.worldToScreen(p), themeGuides().TEXT);
  }

  // Wet-stroke preview: the Brush's in-flight samples (screen space), drawn as
  // round-capped ink at brush width so what you drag IS what commits on release.
  if (paintStroke && paintStroke.length > 0) {
    const s = usePaintStore.getState();
    const erasing = paintMode === 'erase';
    const zoom = controller?.getView().scale ?? 1;
    const w = Math.max(1, drawToolOptions.brushSize * zoom);
    ctx.save();
    ctx.globalAlpha = erasing ? 0.5 : s.opacity;
    ctx.strokeStyle = erasing ? '#ffffff' : drawToolOptions.brushColor;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (erasing) ctx.setLineDash([Math.max(4, w / 2), Math.max(4, w / 2)]);
    if (paintStroke.length === 1) {
      const p = paintStroke[0]!;
      ctx.beginPath();
      ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(paintStroke[0]!.x, paintStroke[0]!.y);
      for (let i = 1; i < paintStroke.length; i++) ctx.lineTo(paintStroke[i]!.x, paintStroke[i]!.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Ctrl-drag brush sizing: the tip at its new diameter, hardness as an inner ring.
  if (paintChrome?.brushRing) {
    const { at, px, hardness } = paintChrome.brushRing;
    const r = Math.max(1, px / 2);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();
    if (hardness < 1) {
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(0.5, r * hardness), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Clone Source Overlay: a lens at the pointer showing the source content the
  // stamp would paint there — semi-transparent, or as a Difference against the
  // pixels under it (black where source and destination already match).
  {
    const ps = usePaintStore.getState();
    const hover = paintChrome?.cloneHover;
    const content = paintChrome?.content;
    const src = ps.cloneSource;
    if (hover && content && controller && ps.cloneOverlay && ps.mode === 'clone'
        && src?.compX !== undefined && src.compY !== undefined && content.width > 0 && cssW > 0 && cssH > 0) {
      const hw = controller.ws.screenToWorld(hover);
      const off = ps.cloneAligned && ps.alignedOffset && paintChrome?.cloneCompOffset
        ? paintChrome.cloneCompOffset
        : { x: src.compX - hw.x, y: src.compY - hw.y };
      const at = controller.ws.worldToScreen({ x: hw.x + off.x, y: hw.y + off.y });
      const zoom = controller.getView().scale || 1;
      const r = Math.max(48, drawToolOptions.brushSize * zoom * 1.5);
      const kx = content.width / cssW;
      const ky = content.height / cssH;
      ctx.save();
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha = Math.max(0, Math.min(1, ps.cloneOverlayOpacity));
      try {
        if (ps.cloneOverlayDifference) {
          ctx.drawImage(content, (hover.x - r) * kx, (hover.y - r) * ky, 2 * r * kx, 2 * r * ky, hover.x - r, hover.y - r, 2 * r, 2 * r);
          ctx.globalCompositeOperation = 'difference';
        }
        ctx.drawImage(content, (at.x - r) * kx, (at.y - r) * ky, 2 * r * kx, 2 * r * ky, hover.x - r, hover.y - r, 2 * r, 2 * r);
      } catch {
        // A WebGL canvas mid-resize can refuse a read; the lens just skips a frame.
      }
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Persistent ruler guides (screen-space, from the engine's overlay). Hidden
  // wholesale by View ▸ Show Guides; lock is per guide and lives in the engine.
  if (overlay.guides.length && guidesState.guidesVisible) {
    ctx.save();
    ctx.globalAlpha = refAlpha(GUIDE_ALPHA);
    ctx.strokeStyle = guideColor();
    ctx.lineWidth = 1;
    for (const g of overlay.guides) {
      // Per-guide colour (AE 26.5); absent = the theme guide colour.
      ctx.strokeStyle = g.color ?? guideColor();
      ctx.beginPath();
      if (g.axis === 'x') {
        ctx.moveTo(g.position + 0.5, 0);
        ctx.lineTo(g.position + 0.5, cssH);
      } else {
        ctx.moveTo(0, g.position + 0.5);
        ctx.lineTo(cssW, g.position + 0.5);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Live preview while dragging a NEW guide out of a ruler (hidden while the
  // pointer is back over the ruler — releasing there cancels).
  if (guideDrag && !guideDrag.guideId && !guideDrag.overRuler) {
    ctx.save();
    ctx.globalAlpha = refAlpha(GUIDE_ALPHA);
    ctx.strokeStyle = guideColor();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    if (guideDrag.axis === 'x') {
      ctx.moveTo(guideDrag.screen.x + 0.5, 0);
      ctx.lineTo(guideDrag.screen.x + 0.5, cssH);
    } else {
      ctx.moveTo(0, guideDrag.screen.y + 0.5);
      ctx.lineTo(cssW, guideDrag.screen.y + 0.5);
    }
    ctx.stroke();
    // setLineDash was reset by hand here; the save/restore pair now covers it
    // along with the alpha and stroke colour.
    ctx.restore();
  }

  // Selection chrome follows the theme's selection token (white in the
  // monochrome dark theme, the accent in light) — not a hardcoded blue.
  const { ACCENT, ACCENT_SOFT, HOVER } = themeChrome();
  const SNAP = '#ff3ba7';

  // Hover affordance: CORNER MARKS, not a full outline.
  //
  // A full box on hover competes with the selection box for the same visual
  // language, and over stacked layers it turns every mouse move into a flicker
  // of near-identical rectangles. Corner marks say "this is what you would get"
  // without claiming to be a selection, which is what makes overlapping layers
  // navigable without clicking through them.
  if (overlay.hoveredCorners) {
    ctx.strokeStyle = HOVER;
    ctx.lineWidth = 1;
    strokeCornerMarks(ctx, overlay.hoveredCorners);
  }

  const activeTool = creationDrag ? creationDrag.tool : useUIStore.getState().activeTool;
  const isFreehandTool = activeTool === 'pencil' || activeTool === 'brush';

  const cDragRect = creationDrag ? {
    x: Math.min(creationDrag.start.x, creationDrag.current.x),
    y: Math.min(creationDrag.start.y, creationDrag.current.y),
    width: Math.abs(creationDrag.current.x - creationDrag.start.x),
    height: Math.abs(creationDrag.current.y - creationDrag.start.y),
  } : null;

  const m = (cDragRect && (cDragRect.width > 2 || cDragRect.height > 2)) ? cDragRect : overlay.marquee;

  // Live Marquee & Creation Drag Preview (Rectangle, Ellipse, Polygon, Star, Masks ONLY - NOT Pencil/Brush).
  if (m && !isFreehandTool) {
    const isEllipse = activeTool === 'ellipse' || activeTool === 'mask-ellipse';
    const rx = Math.abs(m.width) / 2;
    const ry = Math.abs(m.height) / 2;
    const cx = m.x + m.width / 2;
    const cy = m.y + m.height / 2;

    ctx.save();
    ctx.fillStyle = ACCENT_SOFT;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);

    if (isEllipse) {
      // Live blueprint Ellipse preview fill + dashed outline
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Outer blueprint bounding box
      strokeRect(ctx, m);
    } else {
      // Live blueprint Rectangle / Polygon / Star creation preview
      ctx.fillRect(m.x, m.y, m.width, m.height);
      strokeRect(ctx, m);
    }

    ctx.setLineDash([]);

    // Draw blueprint corner & center dots while dragging to create
    if (activeTool !== 'select' && activeTool !== 'direct-select') {
      const dots = [
        { x: m.x, y: m.y },
        { x: m.x + m.width, y: m.y },
        { x: m.x, y: m.y + m.height },
        { x: m.x + m.width, y: m.y + m.height },
        { x: cx, y: cy },
      ];
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      for (const d of dots) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // Snap lines.
  if (overlay.snapLines.length) {
    ctx.strokeStyle = SNAP;
    ctx.lineWidth = 1;
    for (const l of overlay.snapLines) {
      ctx.beginPath();
      if (l.axis === 'x') {
        ctx.moveTo(l.position + 0.5, l.from);
        ctx.lineTo(l.position + 0.5, l.to);
      } else {
        ctx.moveTo(l.from, l.position + 0.5);
        ctx.lineTo(l.to, l.position + 0.5);
      }
      ctx.stroke();
    }
  }

  // A 3D layer is manipulated by its 3D gizmo (axis arrows + rotation rings),
  // so the 2D chrome steps back to a thin outline: drawing an axis-aligned box
  // with eight scale handles and a rotate handle ON TOP of the gizmo is both
  // unreadable and misleading, because those handles drive AABB-space maths that
  // does not describe a projected 3D layer. AE behaves the same way — a 3D layer
  // shows its bounding box and the axis arrows, not the 2D scale handles.
  const sel3D = (() => {
    const ids = useSelectionStore.getState().ids;
    if (ids.length !== 1) return false;
    return documentMirror().layer(ids[0]!)?.switches.threeD === true;
  })();

  const isActivelyDrawing = isFreehandTool || !!paintStroke;

  // Selection outline (hidden while actively drawing or painting a stroke).
  //
  // ONE BOX PER SELECTED LAYER, each rotated with its own layer. The old single
  // union rectangle belonged to no layer in particular: with three layers
  // selected it enclosed whatever happened to lie between them, and on any
  // rotation that was not a multiple of 90° it was visibly larger than the
  // artwork with dead padding at every corner.
  if (!isActivelyDrawing && overlay.selectionBoxes.length > 0) {
    if (sel3D) ctx.setLineDash([4, 3]);
    for (const box of overlay.selectionBoxes) {
      // Each outline takes its OWN layer's label colour, so with several layers
      // selected you can tell which box belongs to which timeline row. That
      // linkage is the point of label colours. No label set ⇒ the accent,
      // exactly as before.
      const label = mirrorLabelColor(documentMirror().layer(box.id));

      // A pale label over a pale composition is nearly invisible, and AE has
      // this weakness. A dark halo UNDER the hairline is the fix, rather than
      // handles with a contrasting core: the halo costs the outline no colour,
      // so the label stays the thing you read, and it only guarantees the line
      // separates from whatever is behind it. A contrasting core would split
      // every outline into two colours and make the palette harder to
      // recognise at a glance — which defeats the feature.
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 3;
      strokeCorners(ctx, box.corners);

      // Hairline. A 2px selection stroke is the single loudest tell of an
      // unpolished editor — it reads as chrome competing with the artwork
      // rather than a thin annotation over it.
      ctx.strokeStyle = label ?? ACCENT;
      ctx.lineWidth = 1;
      strokeCorners(ctx, box.corners);
    }
    if (sel3D) ctx.setLineDash([]);
  }

  // Handles (hidden while actively drawing or painting a stroke, and in 3D).
  if (!isActivelyDrawing && !sel3D) {
    // Handles belong to the selection as a whole, not to one layer, so they
    // only take a label colour when exactly ONE layer is selected. With two
    // selected there is no non-arbitrary answer, and picking the first would
    // assert a linkage that is not there.
    const only = overlay.selectionBoxes.length === 1 ? overlay.selectionBoxes[0] : null;
    const handleAccent = (only ? mirrorLabelColor(documentMirror().layer(only.id)) : undefined) ?? ACCENT;
    for (const h of overlay.handles) {
      if (h.kind === 'anchor') {
        // The pivot, as a crosshair/target — deliberately unlike every square
        // resize grip, because it does something completely different and may
        // sit outside the box entirely. Previously it fell through to the
        // default branch and drew as a plain square, indistinguishable from a
        // handle that scales the layer.
        drawAnchorWidget(ctx, h.position.x, h.position.y, handleAccent);
      } else if (h.kind === 'rotate') {
        // No rotate handle is produced any more (rotation is a tool mode), but
        // a stale overlay from another tool could still carry one.
        ctx.beginPath();
        ctx.arc(h.position.x, h.position.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = handleAccent;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (h.kind === 'point') {
        // Vertex anchor. AE: SELECTED vertices are filled, the rest hollow —
        // which is how a multi-vertex selection reads at all. An overlay with
        // no selection flags anywhere (every tool but Direct Selection) keeps
        // the old all-filled look. The FIRST vertex is drawn larger (AE Set
        // First Vertex), since it decides where Trim Paths starts.
        const anySelected = overlay.handles.some((o) => o.selected);
        const filled = !anySelected || h.selected === true;
        const half = h.first ? 5.5 : 4;
        ctx.fillStyle = filled ? handleAccent : '#fff';
        ctx.strokeStyle = filled ? '#fff' : handleAccent;
        ctx.lineWidth = 1.5;
        ctx.fillRect(h.position.x - half, h.position.y - half, half * 2, half * 2);
        ctx.strokeRect(h.position.x - half, h.position.y - half, half * 2, half * 2);
      } else if (h.kind === 'feather') {
        // Mask feather point: a ring at the feather width, tied to its vertex.
        if (h.origin) {
          ctx.beginPath();
          ctx.moveTo(h.origin.x, h.origin.y);
          ctx.lineTo(h.position.x, h.position.y);
          ctx.strokeStyle = handleAccent;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(h.position.x, h.position.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = h.hovered ? handleAccent : '#fff';
        ctx.fill();
        ctx.strokeStyle = handleAccent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (h.kind === 'tangent-in' || h.kind === 'tangent-out') {
        // Tangent handle: circle, on an arm from its vertex when the tool
        // says where that is.
        if (h.origin) {
          ctx.beginPath();
          ctx.moveTo(h.origin.x, h.origin.y);
          ctx.lineTo(h.position.x, h.position.y);
          ctx.strokeStyle = 'rgba(90,140,255,0.7)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(h.position.x, h.position.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = handleAccent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        // 8px filled square with a 1px contrasting outline: squares read as
        // precise where circles read as a design tool, and the fill/outline
        // contrast is what keeps them visible over both light and dark artwork.
        // Hovered: 10px, accent-filled, with a soft halo — "grabbable", said
        // by the grip itself rather than only by the cursor.
        const r = h.hovered ? 5 : 4;
        if (h.hovered) {
          ctx.beginPath();
          ctx.arc(h.position.x, h.position.y, 9, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fill();
        }
        ctx.fillStyle = h.hovered ? handleAccent : '#fff';
        ctx.strokeStyle = h.hovered ? '#fff' : handleAccent;
        ctx.lineWidth = 1;
        ctx.fillRect(h.position.x - r, h.position.y - r, r * 2, r * 2);
        ctx.strokeRect(h.position.x - r, h.position.y - r, r * 2, r * 2);
      }
    }
  }

  // Free Transform Points: the box around the selected vertices. Its grips and
  // anchor come through `handles` like any other; this is the outline.
  if (overlay.pathTransformBox) {
    const c = overlay.pathTransformBox.corners;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i]!.x, c[i]!.y);
    ctx.closePath();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }

  // Draw tangent arm lines (connect vertex to its tangent handles)
  // We pair them by looking for handles with same node+index prefix
  if (!isFreehandTool) {
    const vertMap = new Map<string, { x: number; y: number }>();
    for (const h of overlay.handles) {
      if (h.kind === 'point') {
        const key = h.id.replace(/^vert_/, '');
        vertMap.set(key, h.position);
      }
    }
    for (const h of overlay.handles) {
      if (h.kind === 'tangent-in' || h.kind === 'tangent-out') {
        const key = h.id.replace(/^t(?:in|out)_/, '');
        const vert = vertMap.get(key);
        if (vert) {
          ctx.beginPath();
          ctx.moveTo(vert.x, vert.y);
          ctx.lineTo(h.position.x, h.position.y);
          ctx.strokeStyle = 'rgba(90,140,255,0.7)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }

  // Pending Path (Pen / Pencil Tool) — drawn as live bezier preview
  if (overlay.pendingPath && overlay.pendingPath.length > 0) {
    const pts = overlay.pendingPath as Array<{x:number;y:number;inX:number;inY:number;outX:number;outY:number}>;
    const isPencil = activeTool === 'pencil';

    // Draw the committed bezier curve segments
    if (pts.length >= 2) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 0; i < pts.length - 1; i++) {
        const curr = pts[i]!;
        const next = pts[i + 1]!;
        ctx.bezierCurveTo(curr.outX, curr.outY, next.inX, next.inY, next.x, next.y);
      }
      if (isPencil) {
        ctx.strokeStyle = drawToolOptions.pencilColor || ACCENT;
        const zoom = controller?.getView().scale ?? 1;
        ctx.lineWidth = Math.max(1, drawToolOptions.pencilWidth * zoom);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      } else {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
      }
      ctx.stroke();
      ctx.restore();
    }

    // Tangent arms and vertex anchor dots are ONLY drawn for Pen / Vector editing, NEVER for freehand Pencil / Brush
    if (!isPencil && !isFreehandTool) {
      for (const pt of pts) {
        const hasTangent = pt.outX !== pt.x || pt.outY !== pt.y;
        if (hasTangent) {
          // Out-handle arm
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y);
          ctx.lineTo(pt.outX, pt.outY);
          ctx.strokeStyle = 'rgba(90,140,255,0.7)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          // In-handle arm
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y);
          ctx.lineTo(pt.inX, pt.inY);
          ctx.strokeStyle = 'rgba(90,140,255,0.7)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          // Tangent handle dots
          ctx.beginPath();
          ctx.arc(pt.outX, pt.outY, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(pt.inX, pt.inY, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        // Anchor square
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.fillRect(pt.x - 3, pt.y - 3, 6, 6);
        ctx.strokeRect(pt.x - 3, pt.y - 3, 6, 6);
      }
    }
  }

  // The Camera / Light guide icons that used to be drawn here are GONE.
  //
  // They were a second, incompatible representation of every camera and light:
  // a fixed-size camcorder glyph and a starburst, painted on the 2D canvas at
  // `worldToScreen({x, y})` — the raw local props with **z dropped** and no
  // parent lift, rotated only by the 2D z-rotation, and never passed through the
  // view projection at all.
  //
  // Every symptom followed from that. The glyph sat on the comp plane however
  // far the camera was pulled back (z was discarded), so it disagreed with its
  // own frustum — two pictures of one camera, hundreds of pixels apart. It was
  // the same size and faced the same way in every view, because a 2D rotation
  // cannot express yaw or pitch: in a Left view it still faced right while the
  // camera it stood for was aimed left. And it was drawn for cameras in OTHER
  // compositions too.
  //
  // `SceneGizmos` already draws both devices properly — oriented 3D chassis,
  // frustum cone, spot cones and falloff spheres, all parent-aware and all
  // projected through whatever view is active (see sceneGizmoData.ts and
  // SceneGeometryOverlay.tsx). That is the one truth; this was the other one.
  if (guidesState.rulers && controller) {
    paintRulers(ctx, controller, cssW, cssH);
  }

  // Drag measurement badge (the 2D twin of the 3D gizmo's HUD): Δx/Δy while
  // moving, W×H or scale % while resizing, degrees while rotating. Drawn last
  // so nothing paints over the numbers, offset below-right of the pointer so
  // the artwork being manipulated stays visible.
  if (overlay.dragHud && overlay.dragHud.lines.length > 0) {
    const hud = overlay.dragHud;
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const padX = 6;
    const lineH = 15;
    let textW = 0;
    for (const line of hud.lines) textW = Math.max(textW, ctx.measureText(line).width);
    const w = Math.ceil(textW) + padX * 2;
    const h = hud.lines.length * lineH + 6;
    // Keep the badge on-canvas when the pointer runs against an edge.
    const bx = Math.min(Math.max(4, hud.anchor.x + 14), cssW - w - 4);
    const by = Math.min(Math.max(4, hud.anchor.y + 16), cssH - h - 4);
    ctx.beginPath();
    // node-canvas (jsdom tests) predates roundRect; square corners there.
    if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, w, h, 4);
    else ctx.rect(bx, by, w, h);
    ctx.fillStyle = 'rgba(20, 22, 26, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.textBaseline = 'middle';
    hud.lines.forEach((line, i) => {
      ctx.fillText(line, bx + padX, by + 3 + lineH * i + lineH / 2);
    });
    ctx.restore();
  }
}

/**
 * COMPOSITION space → the layer's position-track space, for writing a dragged
 * point back: the 2D inverse of the parent's world matrix the motion path is
 * drawn through (the overlay geometry push maps it into comp space). Through
 * the parent chain matters: a path drawn in the parent's space but written as
 * comp coordinates would teleport the key by the parent's transform.
 */
function compToPath(nodeId: string, time: number, p: { x: number; y: number }): { x: number; y: number } {
  const parent = documentMirror().layer(nodeId)?.parent;
  if (!parent) return p;
  // The parent's layer → comp matrix from the push (the 2D chain; a 3D parent's world, sliced to its plane).
  const m = overlayLayer(MAIN_VIEWPORT, parent, secondsToFlicks(time))?.matrix;
  if (!m || m.length < 16) return p;
  return Matrix.transformPoint(Matrix.invert({ a: m[0]!, b: m[1]!, c: m[4]!, d: m[5]!, e: m[12]!, f: m[13]! }), p);
}

/**
 * Hit-test the selected layer's motion-path keyframe dots and tangent handles
 * at a screen point (within a small radius). Returns the grabbed part — the
 * keyframe 'point' itself or its 'in'/'out' spatial tangent handle — or null.
 * Handles are tested first: they can sit close to the point and are the finer
 * target. Used to start an on-canvas motion-path drag.
 */
/**
 * Motion-path handle under the idle cursor — the painter enlarges/halos it so
 * a dot answers "grabbable?" before the press (the path handles had cursor
 * feedback nowhere and visual feedback nowhere). Written by the viewport's
 * pointermove (idle only), read by paintMotionPath, cleared on pointerleave.
 * Left in place when a drag begins, so the dragged handle stays lit.
 */
let mpHover: { nodeId: string; t: number; part: 'point' | 'in' | 'out' } | null = null;

/**
 * The keyframe-time span of the selected layer's motion path to draw (AE's
 * motion-path display preference): all, none (null), or a window of
 * `motionPathWindowSeconds` centred on the playhead on the layer's keyframe axis.
 */
function motionPathWindowFor(nodeId: string, compTime: number): { min: number; max: number } | null {
  const g = useGuidesStore.getState();
  if (g.motionPathShow === 'all') return { min: -Infinity, max: Infinity };
  // Display read: the drawn window is on the keyframe axis the path is sampled
  // on (B4's mirror replaces it); nothing is written.
  return motionPathTimeWindow(g.motionPathShow, g.motionPathWindowSeconds, keyAxisTimeForDisplay(nodeId, compTime, 'x'));
}

const inMotionPathWindow = (t: number, w: { min: number; max: number }): boolean =>
  t >= w.min - 1e-9 && t <= w.max + 1e-9;

function hitMotionPathKeyframe(
  controller: WorkspaceController,
  screen: { x: number; y: number },
): { nodeId: string; t: number; part: 'point' | 'in' | 'out' } | null {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return null;
  const nodeId = ids[0]!;
  const m = documentMirror();
  if (!hasPositionKeys(m, nodeId)) return null;
  const time = playheadTime();
  // The engine's motion path for the frame on screen (the overlay geometry push).
  const path = motionPathOverlay(nodeId, time);
  if (!path) return null;
  const R = 8; // grab radius, screen px
  // Must use the SAME projection the painter does, or a 3D layer's dots are
  // drawn in one place and grabbable in another.
  const toS = motionPathProjector(controller, m, nodeId, time);
  // Only what is DRAWN is grabbable — the display window hides the rest.
  const win = motionPathWindowFor(nodeId, time);
  if (!win) return null;
  const near = (x: number, y: number, z: number): boolean => {
    const s = toS(x, y, z);
    return Math.hypot(s.x - screen.x, s.y - screen.y) <= R;
  };
  const keys = pathKeysOf(path).filter((k) => inMotionPathWindow(k.t, win));
  for (const k of keys) {
    if (k.out && near(k.out.x, k.out.y, k.z)) return { nodeId, t: k.t, part: 'out' };
    if (k.in && near(k.in.x, k.in.y, k.z)) return { nodeId, t: k.t, part: 'in' };
  }
  for (const k of keys) {
    if (near(k.x, k.y, k.z)) return { nodeId, t: k.t, part: 'point' };
  }
  return null;
}

/** The overlay geometry push's kinds: every selected layer's box and matrix; a single one's motion path and text box too. */
const OVERLAY_KINDS_MANY: ReadonlyArray<OverlayKind> = ['transform', 'bounds'];
const OVERLAY_KINDS_ONE: ReadonlyArray<OverlayKind> = ['transform', 'bounds', 'motionPath', 'textBox'];

/** The layer's motion path for the frame at comp `seconds`, from the overlay geometry push; undefined without keys. */
function motionPathOverlay(nodeId: string, seconds: number): OverlayLayer | undefined {
  const g = overlayLayer(MAIN_VIEWPORT, nodeId, secondsToFlicks(seconds));
  return g && g.pathKeys.length >= 8 ? g : undefined;
}

interface PathKey { t: number; x: number; y: number; z: number; in: { x: number; y: number } | null; out: { x: number; y: number } | null }

/** `pathKeys` (t, x, y, z, inX, inY, outX, outY per key; NaN = no handle) as records. */
function pathKeysOf(g: OverlayLayer): PathKey[] {
  const out: PathKey[] = [];
  const k = g.pathKeys;
  for (let i = 0; i + 7 < k.length; i += 8) {
    out.push({
      t: k[i]!, x: k[i + 1]!, y: k[i + 2]!, z: k[i + 3]!,
      in: Number.isNaN(k[i + 4]!) ? null : { x: k[i + 4]!, y: k[i + 5]! },
      out: Number.isNaN(k[i + 6]!) ? null : { x: k[i + 6]!, y: k[i + 7]! },
    });
  }
  return out;
}

/** Comp-space (x, y, z) → screen: through the view camera for a 3D layer (at the painted time), else the 2D camera. */
function motionPathProjector(
  controller: WorkspaceController,
  m: ReturnType<typeof documentMirror>,
  nodeId: string,
  time: number,
): (x: number, y: number, z: number) => { x: number; y: number } {
  const comp = compSize();
  const is3D = m.layer(nodeId)?.switches.threeD === true;
  // For a 3D layer the trajectory goes through the SAME camera the renderer uses; the projector is
  // built at the playhead (the path shows where the trajectory lies in the view you look at now).
  const project = is3D ? viewProjectorNow(comp.w, comp.h, time) : null;
  return (x, y, z) => {
    if (!project) return controller.ws.worldToScreen({ x, y });
    const q = project({ x, y, z });
    return controller.ws.worldToScreen({ x: q.x, y: q.y });
  };
}

/**
 * Region of Interest — border, dimmed surround and the eight resize grips.
 *
 * Without this the ROI was invisible: the menu set a region and the renderer
 * clipped to it, but nothing drew it, so there was no way to see what had been
 * restricted or to tell a working ROI from a broken preview. `roiGeometry` (the
 * pure hit-test/resize maths this pairs with) had no callers at all.
 */
/**
 * Theme colours for the selection chrome, read ONCE per theme.
 *
 * `getComputedStyle` + `getPropertyValue` forces a style recalculation, and this
 * ran inside the overlay paint — i.e. inside the rAF callback, on every frame of
 * playback and every drag tick — to fetch three tokens that only change when the
 * theme does. The theme is stamped on the root element, so that attribute is the
 * cache key.
 */
let chromeCache: { key: string; ACCENT: string; ACCENT_SOFT: string; HOVER: string } | null = null;

function themeChrome(): { ACCENT: string; ACCENT_SOFT: string; HOVER: string } {
  const el = document.documentElement;
  const key = `${el.getAttribute('data-theme') ?? ''}|${el.className}`;
  if (chromeCache && chromeCache.key === key) return chromeCache;
  const root = getComputedStyle(el);
  chromeCache = {
    key,
    ACCENT: root.getPropertyValue('--color-selection').trim() || '#f2f2f3',
    ACCENT_SOFT: root.getPropertyValue('--color-primary-subtle').trim() || 'rgba(255,255,255,0.14)',
    HOVER: root.getPropertyValue('--color-border-strong').trim() || 'rgba(255,255,255,0.35)',
  };
  return chromeCache;
}

/**
 * Theme colours for the RULER and SAFE-AREA overlays, on the same
 * once-per-theme cache as `themeChrome` above and for the same reason.
 *
 * These two overlays were the last surfaces in the app painted from literals,
 * and not even from ONE set of literals: the ruler bar was `#12131a` on a
 * `#161616` app, its borders `#2e3440` / `#3b4252` (Nord), its corner `#1a1b26`
 * (Tokyo Night), its text `#e2e8f0` (Tailwind slate) and its accent `#38bdf8`
 * (Tailwind sky) — while the app's accent is `#2988ff`. Three borrowed palettes
 * and a blue-black bar over a neutral-grey editor, which is what made the strip
 * read as pasted on from somewhere else. The safe-area boxes used the same
 * foreign sky blue.
 *
 * Reading tokens means these also follow the LIGHT theme, which literals could
 * never do: a `#12131a` bar stayed near-black on a light canvas.
 */
let guideCache: {
  key: string; BAR: string; CORNER: string; BORDER: string;
  ACCENT: string; TEXT: string; TICK: string; GUIDE: string;
} | null = null;

function themeGuides(): Omit<NonNullable<typeof guideCache>, 'key'> {
  const el = document.documentElement;
  const key = `${el.getAttribute('data-theme') ?? ''}|${el.className}`;
  if (guideCache && guideCache.key === key) return guideCache;
  const root = getComputedStyle(el);
  const read = (token: string, fallback: string): string =>
    root.getPropertyValue(token).trim() || fallback;
  guideCache = {
    key,
    // Dark dedicated ruler surface to ensure distinct contrast against sidebars (#232323) and canvas
    BAR: read('--color-ruler-bg', '#111111'),
    CORNER: read('--color-ruler-corner', '#161616'),
    BORDER: read('--color-ruler-border', '#262626'),
    ACCENT: read('--color-primary', '#2988ff'),
    TEXT: read('--color-ruler-text', '#cccccc'),
    TICK: read('--color-ruler-tick', '#707070'),
    GUIDE: read('--color-ruler-guide', '#2dd4eb'),
  };
  return guideCache;
}

/**
 * Face-select chrome — the picked face filled and outlined, plus every other
 * face of the object faintly outlined so it's obvious what else can be clicked.
 *
 * Drawn from the SAME projected quads the picker hit-tests, so the highlight can
 * never disagree with what a click would select.
 */
function paintFaceSelection(canvas: HTMLCanvasElement, controller: WorkspaceController, dpr: number): void {
  const fs = useFaceSelectionStore.getState();
  if (!fs.enabled) return;
  const nodeId = fs.nodeId ?? useSelectionStore.getState().ids[0];
  if (!nodeId) return;
  const { w: cw, h: ch } = compSize();
  const time = playheadTime();
  const world = layerFacesNow(nodeId, time);
  if (!world) return;
  const faces = projectFacesForView(world, time, cw, ch);
  if (faces.length === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const toScreen = (p: { x: number; y: number }) => controller.ws.worldToScreen(p);

  // Faces are grouped into SURFACES: a quad face is its own surface, while on
  // the mesh path every visible triangle of a kind (all of a glyph set's walls,
  // say) is one surface — filled as one path and outlined along its boundary
  // edges only, so the highlight is the object's face and not a wireframe.
  // Far surfaces first so the near ones outline on top. Edge-on faces are
  // dropped by the grouping for the same reason the picker skips them: an
  // invisible sliver drawn as a line reads as a stray scratch on the object.
  const groups = faceHighlightGroups(faces).sort((a, b) => b.depth - a.depth);
  ctx.lineWidth = 1;
  for (const g of groups) {
    const active = fs.nodeId === nodeId && g.suffix === fs.suffix;
    if (active) {
      ctx.beginPath();
      for (const poly of g.polygons) {
        poly.forEach((p, i) => {
          const s = toScreen(p);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(120,170,255,0.28)';
      ctx.fill();
    }
    ctx.beginPath();
    for (const [a, b] of g.outline) {
      const sa = toScreen(a);
      const sb = toScreen(b);
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
    }
    if (active) {
      ctx.strokeStyle = 'rgba(150,195,255,1)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = 'rgba(150,195,255,0.28)';
      ctx.stroke();
    }
  }
  ctx.restore();
}

function paintRoi(canvas: HTMLCanvasElement, controller: WorkspaceController, dpr: number): void {
  const roi = useGuidesStore.getState().roi;
  if (!roi) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const tl = controller.ws.worldToScreen({ x: roi.x, y: roi.y });
  const br = controller.ws.worldToScreen({ x: roi.x + roi.width, y: roi.y + roi.height });
  const x = tl.x;
  const y = tl.y;
  const w = br.x - tl.x;
  const h = br.y - tl.y;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Dim everything outside the region — the part that will not be rendered.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width / dpr, canvas.height / dpr);
  ctx.rect(x, y, w, h);
  ctx.fill('evenodd');

  ctx.strokeStyle = 'rgba(120,170,255,0.95)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.setLineDash([]);

  // Eight grips, matching the corners/edges roiHandleAt tests for.
  const grips: Array<[number, number]> = [
    [x, y], [x + w / 2, y], [x + w, y],
    [x + w, y + h / 2], [x + w, y + h],
    [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
  ];
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(120,170,255,1)';
  for (const [gx, gy] of grips) {
    ctx.beginPath();
    ctx.rect(gx - 3, gy - 3, 6, 6);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Motion path (E4) — draws the selected layer's animated-position trajectory
 * over the interaction overlay: a spatial curve through the sampled positions,
 * a dot at each keyframe, and a marker at the current playhead position. Comp
 * positions are projected to screen through the camera. Only shows for a single
 * selection that actually has a position animation.
 */
function paintMotionPath(
  canvas: HTMLCanvasElement,
  controller: WorkspaceController,
  time: number,
  dpr: number,
): void {
  // Honour the visibility toggle. `motionPathVisible` had NO reader anywhere: this
  // function ran unconditionally from paintChrome, so the button in the viewport
  // header, the "Motion Paths" menu entry and the Ctrl+Alt+M command all flipped a
  // flag that changed nothing — the path was always drawn.
  const guides = useGuidesStore.getState();
  if (!guides.motionPathVisible) return;

  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return;
  const nodeId = ids[0]!;
  const m = documentMirror();
  if (!hasPositionKeys(m, nodeId)) return;
  // A camera's own path, seen through that camera, is a line across the frame.
  if (isLookedThroughNow(nodeId)) return;
  const win = motionPathWindowFor(nodeId, time);
  if (!win) return;
  // The engine's motion path for the frame on screen (the overlay geometry push): comp-space
  // points (x, y through the parent at this frame; z raw), keys with their tangent handles,
  // the per-frame dots and the position now.
  const path = motionPathOverlay(nodeId, time);
  if (!path) return;
  const samples: Array<{ t: number; x: number; y: number; z: number }> = [];
  for (let i = 0; i + 3 < path.path.length; i += 4) {
    const t = path.path[i]!;
    if (inMotionPathWindow(t, win)) samples.push({ t, x: path.path[i + 1]!, y: path.path[i + 2]!, z: path.path[i + 3]! });
  }
  if (samples.length < 2) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw ON TOP of the overlay (no clear)

  // For a 3D layer the trajectory goes through the SAME camera the renderer uses (motionPathProjector);
  // `z` is per point, so a layer animating in depth curves correctly.
  const project = motionPathProjector(controller, m, nodeId, time);
  const toS = (p: { x: number; y: number; z: number }): { x: number; y: number } => project(p.x, p.y, p.z);

  // Trajectory curve.
  ctx.beginPath();
  const s0 = toS(samples[0]!);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < samples.length; i++) {
    const q = toS(samples[i]!);
    ctx.lineTo(q.x, q.y);
  }
  ctx.strokeStyle = 'rgba(120,170,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Spatial tangent handles — a thin stem from each keyframe to its in/out
  // control point, with a small square grab dot (AE-style). Drawn under the
  // keyframe dots so the points stay the primary target.
  const keys = pathKeysOf(path);
  for (const k of keys) {
    if (!inMotionPathWindow(k.t, win)) continue;
    const p = toS(k);
    for (const [part, h] of [['out', k.out], ['in', k.in]] as const) {
      if (!h) continue;
      const hs = toS({ x: h.x, y: h.y, z: k.z });
      const hovered = mpHover !== null && mpHover.nodeId === nodeId
        && Math.abs(mpHover.t - k.t) < 1e-9 && mpHover.part === part;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(hs.x, hs.y);
      ctx.strokeStyle = hovered ? 'rgba(160,200,255,0.9)' : 'rgba(120,170,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = hovered ? '#fff' : 'rgba(120,170,255,1)';
      const r = hovered ? 3.5 : 2.5;
      ctx.fillRect(hs.x - r, hs.y - r, r * 2, r * 2);
      if (hovered) {
        ctx.strokeStyle = 'rgba(120,170,255,1)';
        ctx.strokeRect(hs.x - r, hs.y - r, r * 2, r * 2);
      }
    }
  }

  // Per-frame velocity tick dots (AE-style speed spacing) and keyframe markers.
  if (guides.motionPathDots !== 'off') {
    const frameDotRadius =
      guides.motionPathDots === 'small' ? 1.25
      : guides.motionPathDots === 'large' ? 2.25
      : 1.75; // 'medium'

    const kfRadius =
      guides.motionPathDots === 'small' ? 3.5
      : guides.motionPathDots === 'large' ? 5.5
      : 4.5; // 'medium'

    // 1. Draw per-frame velocity tick dots along the trajectory
    ctx.fillStyle = 'rgba(160, 205, 255, 0.9)';
    for (let i = 0; i + 3 < path.pathFrames.length; i += 4) {
      if (!inMotionPathWindow(path.pathFrames[i]!, win)) continue;
      const q = toS({ x: path.pathFrames[i + 1]!, y: path.pathFrames[i + 2]!, z: path.pathFrames[i + 3]! });
      ctx.beginPath();
      ctx.arc(q.x, q.y, frameDotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Draw keyframe markers (distinct larger dots with white center & blue border)
    for (const k of keys) {
      if (!inMotionPathWindow(k.t, win)) continue;
      const q = toS(k);
      const hovered = mpHover !== null && mpHover.nodeId === nodeId
        && Math.abs(mpHover.t - k.t) < 1e-9 && mpHover.part === 'point';
      if (hovered) {
        // Halo behind the dot — "grabbable", said before the press.
        ctx.beginPath();
        ctx.arc(q.x, q.y, kfRadius + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120,170,255,0.25)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(q.x, q.y, hovered ? kfRadius + 1 : kfRadius, 0, Math.PI * 2);
      ctx.fillStyle = hovered ? 'rgba(120,170,255,1)' : '#fff';
      ctx.fill();
      ctx.strokeStyle = hovered ? '#fff' : 'rgba(100, 160, 255, 1)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Current-position marker at the playhead.
  if (path.pathNow.length >= 3) {
    const cur = toS({ x: path.pathNow[0]!, y: path.pathNow[1]!, z: path.pathNow[2]! });
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,214,90,1)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/**
 * Stroke an oriented box as a closed polygon.
 *
 * The half-pixel offset is the same crispness trick `strokeRect` uses — a 1px
 * stroke centred on an integer coordinate straddles two device pixels and
 * renders as a 2px blur. It only helps on axis-aligned edges; a rotated box is
 * antialiased regardless, and the offset costs nothing there.
 */
function strokeCorners(
  ctx: CanvasRenderingContext2D,
  c: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
): void {
  ctx.beginPath();
  ctx.moveTo(c[0].x + 0.5, c[0].y + 0.5);
  for (let i = 1; i < 4; i++) ctx.lineTo(c[i]!.x + 0.5, c[i]!.y + 0.5);
  ctx.closePath();
  ctx.stroke();
}

/**
 * Corner marks: a short L at each corner of an oriented box, drawn along the
 * box's own edges so they rotate with it. Length is capped at a third of the
 * shorter edge so a small layer gets proportionate marks rather than four Ls
 * that meet in the middle.
 */
function strokeCornerMarks(
  ctx: CanvasRenderingContext2D,
  c: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  length = 8,
): void {
  const edge = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { ux: dx / len, uy: dy / len, len };
  };
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const cur = c[i]!;
    const next = c[(i + 1) % 4]!;
    const prev = c[(i + 3) % 4]!;
    const fwd = edge(cur, next);
    const back = edge(cur, prev);
    const n = Math.min(length, fwd.len / 3);
    const b = Math.min(length, back.len / 3);
    ctx.moveTo(cur.x + fwd.ux * n + 0.5, cur.y + fwd.uy * n + 0.5);
    ctx.lineTo(cur.x + 0.5, cur.y + 0.5);
    ctx.lineTo(cur.x + back.ux * b + 0.5, cur.y + back.uy * b + 0.5);
  }
  ctx.stroke();
}

/**
 * The anchor point: a small hollow circle with four radiating ticks — a target
 * glyph. Visually distinct from every square resize grip at a glance, which
 * matters because it is the only handle that changes what rotation and scale
 * pivot around rather than changing the layer's size.
 */
function drawAnchorWidget(ctx: CanvasRenderingContext2D, x: number, y: number, accent: string): void {
  const r = 4;
  const tick = 4;
  ctx.save();
  // A dark halo first, so the widget survives being dropped on white artwork.
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r - tick, y); ctx.lineTo(x - r, y);
  ctx.moveTo(x + r, y);        ctx.lineTo(x + r + tick, y);
  ctx.moveTo(x, y - r - tick); ctx.lineTo(x, y - r);
  ctx.moveTo(x, y + r);        ctx.lineTo(x, y + r + tick);
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r - tick, y); ctx.lineTo(x - r, y);
  ctx.moveTo(x + r, y);        ctx.lineTo(x + r + tick, y);
  ctx.moveTo(x, y - r - tick); ctx.lineTo(x, y - r);
  ctx.moveTo(x, y + r);        ctx.lineTo(x, y + r + tick);
  ctx.stroke();
  ctx.restore();
}

function strokeRect(ctx: CanvasRenderingContext2D, r: { x: number; y: number; width: number; height: number }): void {
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width, r.height);
}

/**
 * Wireframe / bounding-box DISPLAY MODES.
 *
 * ## Why the overlay draws this and the renderer does not
 *
 * A true GPU wireframe means a `line-list` pipeline, and a triangle index
 * buffer cannot be reused for one: reinterpreting `[a,b,c]` triangles as
 * `[a,b],[c,…]` line pairs draws a zigzag, not edges. It would need its own
 * index buffer, its own shader in both backends (`shaderBackendParity`), and a
 * new uniform struct (`uniformPackerSize` PACKERS row). That is a renderer
 * feature, not a small change — so the modes are drawn here, over a hidden
 * content canvas (`Workspace.module.css` → `.canvasHidden`), which gives the
 * same READING of the scene at overlay cost.
 *
 * What that trades away: per-triangle mesh edges. You get every layer's
 * oriented box and, in wireframe, its diagonals — enough to see depth,
 * stacking, off-screen layers and a rotated layer's true footprint, which is
 * what the mode is for on a dense 3D comp.
 *
 * ## Geometry
 *
 * `worldCorners` is the oriented box the selection outline already uses, so a
 * rotated layer draws rotated and a parented one draws where its parent puts
 * it. Falls back to the AABB when an adapter has not supplied corners.
 */
function paintDisplayMode(
  ctx: CanvasRenderingContext2D,
  controller: WorkspaceController,
  mode: 'wireframe' | 'bounds',
): void {
  const C = themeGuides();
  ctx.save();
  ctx.strokeStyle = C.ACCENT;
  ctx.lineWidth = 1;
  ctx.globalAlpha = refAlpha(mode === 'wireframe' ? 0.9 : 0.65);
  for (const node of controller.sceneNodes()) {
    if (!node) continue;
    const b = node.worldBounds;
    const corners =
      node.worldCorners ??
      ([
        { x: b.x, y: b.y },
        { x: b.x + b.width, y: b.y },
        { x: b.x + b.width, y: b.y + b.height },
        { x: b.x, y: b.y + b.height },
      ] as const);
    const p = corners.map((c) => controller.ws.worldToScreen({ x: c.x, y: c.y }));
    if (p.length < 4 || p.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) continue;
    ctx.beginPath();
    ctx.moveTo(p[0]!.x, p[0]!.y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i]!.x, p[i]!.y);
    ctx.closePath();
    if (mode === 'wireframe') {
      // The two diagonals: the cheapest thing that turns a rectangle into a
      // readable SURFACE, and what tells two overlapping layers apart.
      ctx.moveTo(p[0]!.x, p[0]!.y);
      ctx.lineTo(p[2]!.x, p[2]!.y);
      ctx.moveTo(p[1]!.x, p[1]!.y);
      ctx.lineTo(p[3]!.x, p[3]!.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// AE's per-layer Quality = WIREFRAME is painted by `wireframeQualityOverlay.ts`,
// shared with the 2-up/4-up panes and Presentation Mode (useViewportRenderer).

function paintSafeArea(ctx: CanvasRenderingContext2D, controller: WorkspaceController): void {
  try {
    const comp = compSize();
    if (comp.w <= 0 || comp.h <= 0) return;
    const p0 = controller.ws.worldToScreen({ x: 0, y: 0 });
    const p1 = controller.ws.worldToScreen({ x: comp.w, y: comp.h });
    if (!Number.isFinite(p0.x) || !Number.isFinite(p0.y) || !Number.isFinite(p1.x) || !Number.isFinite(p1.y)) return;
    const w = p1.x - p0.x;
    const h = p1.y - p0.y;
    if (w <= 0 || h <= 0) return;

    const C = themeGuides();

    ctx.save();
    ctx.lineWidth = 1;
    // Alpha comes from globalAlpha, not from baking it into an rgba() literal —
    // that is what lets every stroke here be the theme's accent token.
    ctx.strokeStyle = C.ACCENT;
    ctx.fillStyle = C.ACCENT;

    // Action Safe Box (90%)
    const asX = p0.x + w * 0.05;
    const asY = p0.y + h * 0.05;
    const asW = w * 0.9;
    const asH = h * 0.9;
    ctx.globalAlpha = refAlpha(0.55);
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(asX + 0.5, asY + 0.5, asW, asH);

    // Title Safe Box (80%)
    const tsX = p0.x + w * 0.1;
    const tsY = p0.y + h * 0.1;
    const tsW = w * 0.8;
    const tsH = h * 0.8;
    ctx.globalAlpha = refAlpha(0.45);
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(tsX + 0.5, tsY + 0.5, tsW, tsH);

    // Center crosshair
    const cx = p0.x + w / 2;
    const cy = p0.y + h / 2;
    ctx.setLineDash([]);
    ctx.globalAlpha = refAlpha(0.7);
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy + 0.5); ctx.lineTo(cx + 10, cy + 0.5);
    ctx.moveTo(cx + 0.5, cy - 10); ctx.lineTo(cx + 0.5, cy + 10);
    ctx.stroke();

    // Labels. Tracked uppercase at 9px is the app's chrome-label convention,
    // and the tracking is what keeps it legible over busy footage.
    ctx.globalAlpha = refAlpha(0.85);
    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
    ctx.letterSpacing = '0.06em';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('ACTION SAFE 90%', asX + 4, asY + 12);
    ctx.fillText('TITLE SAFE 80%', tsX + 4, tsY + 12);

    ctx.restore();
  } catch (e) {
    console.error('[paintSafeArea] Error rendering safe area:', e);
  }
}

function paintRulers(
  ctx: CanvasRenderingContext2D,
  controller: WorkspaceController,
  cssW: number,
  cssH: number,
): void {
  try {
    // The SAME number `rulerStrips` hit-tests with — see RULER_CSS_PX.
    const rulerHeight = RULER_CSS_PX;
    const C = themeGuides();

    ctx.save();

    // Top & Left ruler background strip
    ctx.fillStyle = C.BAR;
    ctx.fillRect(0, 0, cssW, rulerHeight);
    ctx.fillRect(0, 0, rulerHeight, cssH);

    // Border lines
    ctx.strokeStyle = C.BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerHeight + 0.5);
    ctx.lineTo(cssW, rulerHeight + 0.5);
    ctx.moveTo(rulerHeight + 0.5, 0);
    ctx.lineTo(rulerHeight + 0.5, cssH);
    ctx.stroke();

    // Corner (0,0) square. Inset by the half-pixel the stroke occupies, so the
    // box lands ON the 22px gutter instead of overhanging it by a pixel into
    // the canvas — which is what put a stray light line down the artboard edge.
    ctx.fillStyle = C.CORNER;
    ctx.fillRect(0, 0, rulerHeight, rulerHeight);
    ctx.strokeStyle = C.BORDER;
    ctx.strokeRect(0.5, 0.5, rulerHeight - 1, rulerHeight - 1);
    ctx.fillStyle = C.ACCENT;
    ctx.font = 'bold 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('px', rulerHeight / 2, rulerHeight / 2);

    // Step sizing based on zoom scale
    const scale = Math.max(0.01, controller.getView().scale ?? 1);
    let stepWorld = 100;
    if (scale > 3) stepWorld = 10;
    else if (scale > 1.5) stepWorld = 20;
    else if (scale > 0.8) stepWorld = 50;
    else if (scale < 0.3) stepWorld = 500;
    else if (scale < 0.6) stepWorld = 200;

    const w1 = controller.ws.screenToWorld({ x: rulerHeight, y: 0 });
    const w2 = controller.ws.screenToWorld({ x: cssW, y: 0 });
    if (!Number.isFinite(w1.x) || !Number.isFinite(w2.x)) {
      ctx.restore();
      return;
    }

    const minXWorld = Math.floor(Math.min(w1.x, w2.x) / stepWorld) * stepWorld;
    const maxXWorld = Math.ceil(Math.max(w1.x, w2.x) / stepWorld) * stepWorld;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const MAX_TICKS = 150;
    let ticksX = 0;
    for (let x = minXWorld; x <= maxXWorld && ticksX < MAX_TICKS; x += stepWorld) {
      ticksX++;
      const sx = controller.ws.worldToScreen({ x, y: 0 }).x;
      if (Number.isFinite(sx) && sx >= rulerHeight && sx <= cssW) {
        const isZero = x === 0;
        ctx.beginPath();
        ctx.moveTo(Math.floor(sx) + 0.5, rulerHeight - 7);
        ctx.lineTo(Math.floor(sx) + 0.5, rulerHeight);
        ctx.strokeStyle = isZero ? C.ACCENT : C.TEXT;
        ctx.lineWidth = isZero ? 1.5 : 1;
        ctx.stroke();

        ctx.font = isZero ? 'bold 10px ui-monospace, monospace' : '10px ui-monospace, monospace';
        ctx.fillStyle = isZero ? C.ACCENT : C.TEXT;
        ctx.fillText(String(x), Math.floor(sx), 2);

        // Minor ticks: the token at reduced alpha rather than a hardcoded
        // white wash, which was invisible in the light theme.
        const minorStep = stepWorld / 5;
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = C.TICK;
        ctx.lineWidth = 1;
        for (let m = 1; m < 5; m++) {
          const msx = controller.ws.worldToScreen({ x: x + m * minorStep, y: 0 }).x;
          if (Number.isFinite(msx) && msx >= rulerHeight && msx <= cssW) {
            ctx.beginPath();
            ctx.moveTo(Math.floor(msx) + 0.5, rulerHeight - 4);
            ctx.lineTo(Math.floor(msx) + 0.5, rulerHeight);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    // Left Ruler (Y Axis)
    const h1 = controller.ws.screenToWorld({ x: 0, y: rulerHeight });
    const h2 = controller.ws.screenToWorld({ x: 0, y: cssH });
    if (!Number.isFinite(h1.y) || !Number.isFinite(h2.y)) {
      ctx.restore();
      return;
    }

    const minYWorld = Math.floor(Math.min(h1.y, h2.y) / stepWorld) * stepWorld;
    const maxYWorld = Math.ceil(Math.max(h1.y, h2.y) / stepWorld) * stepWorld;

    let ticksY = 0;
    for (let y = minYWorld; y <= maxYWorld && ticksY < MAX_TICKS; y += stepWorld) {
      ticksY++;
      const sy = controller.ws.worldToScreen({ x: 0, y }).y;
      if (Number.isFinite(sy) && sy >= rulerHeight && sy <= cssH) {
        const isZero = y === 0;
        ctx.beginPath();
        ctx.moveTo(rulerHeight - 7, Math.floor(sy) + 0.5);
        ctx.lineTo(rulerHeight, Math.floor(sy) + 0.5);
        ctx.strokeStyle = isZero ? C.ACCENT : C.TEXT;
        ctx.lineWidth = isZero ? 1.5 : 1;
        ctx.stroke();

        ctx.save();
        ctx.translate(2, Math.floor(sy) - 2);
        ctx.font = isZero ? 'bold 9px ui-monospace, monospace' : '9px ui-monospace, monospace';
        ctx.fillStyle = isZero ? C.ACCENT : C.TEXT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(y), 0, 0);
        ctx.restore();

        const minorStep = stepWorld / 5;
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = C.TICK;
        ctx.lineWidth = 1;
        for (let m = 1; m < 5; m++) {
          const msy = controller.ws.worldToScreen({ x: 0, y: y + m * minorStep }).y;
          if (Number.isFinite(msy) && msy >= rulerHeight && msy <= cssH) {
            ctx.beginPath();
            ctx.moveTo(rulerHeight - 4, Math.floor(msy) + 0.5);
            ctx.lineTo(rulerHeight, Math.floor(msy) + 0.5);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    ctx.restore();
  } catch (e) {
    console.error('[paintRulers] Error rendering rulers:', e);
  }
}

