import { getNodeLabelColor } from '@core/scene/labelColor';
import { getTimelineController } from '@core/timeline/TimelineController';
/**
 * useWorkspace — the React⇄Workspace-engine seam for the viewport.
 *
 * React owns only DOM elements (a content canvas + an overlay canvas + the
 * stage) and forwards raw pointer/wheel input to the engine. The engine does
 * everything else: camera, tools, selection, hit-testing, snapping. This hook
 * (1) renders scene content through the Canvas2D backend using the engine's
 * camera view, (2) paints the interaction overlay (selection, handles, marquee,
 * snap lines, hover) from `ws.overlay`, and (3) feeds normalized input in.
 *
 * It supersedes the old `useViewportRenderer` (content-only, fixed fit) — one
 * render loop now drives both content and interaction (consolidated).
 */

import { useEffect, useRef, useState } from 'react';
import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend } from '@core/rendering/RenderBackend';
import { buildSnapshot, type SnapshotFocus } from '@core/rendering/buildSnapshot';
import type { Guide, GuideAxis, WorkspaceOverlay } from '@motion/workspace';
import { modifiersFrom, drawToolOptions, type PointerInput, type WheelInput } from '@motion/workspace';
import renderCache from '@core/rendering/renderCache';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { applyChannelViewToCanvas, channelNeedsPass } from '@core/rendering/channelView';
import { mayServeCachedFrame, mayFillFromPausedRender, playbackBlitWorthwhile } from '@core/rendering/previewCacheGate';
import { useWorkspaceStore } from '@stores/projectStore';
import workspaceStyles from './Workspace.module.css';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { compHasWireframeQualityLayer, paintWireframeQualityLayers } from './wireframeQualityOverlay';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore, clampOverlayOpacity } from '@stores/guidesStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { idleCacheSpan, nextSpanFrame } from '@core/rendering/idleCacheSpan';
import { onPreviewCacheRequest } from '@stores/cacheRequestStore';
import { publishFrame } from '@core/rendering/frameTap';
import { clipGeometrySignature } from '@core/timeline/TimelineController';
import { roiHandleAt, resizeRoi, clampRoi, roiHandleCursor, type RoiHandle } from '@core/rendering/roiGeometry';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { previewIncludesVideo } from '@stores/previewBehaviorStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { useRenderQueueStore } from '@stores/renderQueueStore';
import { useModalStore } from '@stores/modalStore';
import { useCompositionStore, compKeyFor } from '@stores/compositionStore';
import { useUIStore, type Tool } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { is3DEnabled, readNode3D } from '@core/scene/threeD';
import { currentViewProjector } from '@core/workspace/viewProjection';
import { isLookedThrough } from '@core/workspace/ports';


import { getWorkspaceController, type WorkspaceController } from '@core/workspace/WorkspaceController';
import {
  hasPositionAnimation,
  motionPathSamples,
  motionPathKeyframes,
  motionPathFrameSamples,
  motionPathTangents,
  setPathTangent,
  isPathTangentContinuous,
  positionSamplerFor,
  motionPathTimeWindow,
} from '@core/motion/motionPath';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { motionPathKeyframeMenuItems, guideContextMenuItems, convertMotionPathVertex } from './viewportPrecisionMenus';
import { openGuideEditor } from './GuideEditorDialog';
import { beginViewportGesture, cancelToolGesture, endViewportGesture } from '@core/workspace/viewportGesture';
import type { Command } from '@motion/engine-api';
import { GestureSession } from '@core/engine/uiEdits';
import {
  capturePositionTracks,
  positionKeyPatchCommands,
  resolvePositionKeyIds,
  type PositionKeyIds,
  type PositionTracks,
} from './viewportEdits';
import { parentWorld2DAt } from '@core/scene/layerSpace';
import { Matrix } from '@motion/scene';
import { useTextEditStore } from '@stores/textEditStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { useOnionSkinStore } from '@stores/onionSkinStore';
import { createOnionSkinPainter } from '@core/rendering/onionSkinPainter';
import { memoizedSceneContentHash } from '@core/rendering/sceneContentHash';
import type { PaintMode } from '@core/paint/paintStrokes';
import { commitPaintDrag } from '@core/paint/paintCommit';
import { ctrlDragBrush, penSample } from '@core/paint/paintCapture';
import { isPaintableKind } from '@core/paint/paintCoords';
import { paintSpaceAt, thinSamples, type PaintSpace } from '@core/paint/paintSpace';
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
import { useCompareStore, captureLiveFrame, needsLiveFrame } from '@stores/compareStore';
import { useViewportDisplayStore, viewportHudStats } from '@stores/viewportDisplayStore';
import { usePlaybackClockStore } from '@stores/playbackClockStore';
import { framePerf, perfBegin, perfEnd, PerfStage, installPerfDevGlobal } from '@core/perf/framePerf';
import {
  cancelSmoothDolly,
  dollyNavBy,
  describeNavUnavailable,
  findNavTarget,
  orbitNavBy,
  resolveOrbitPivot,
  resolveViewCameraInput,
  smoothDollyNavBy,
  trackNavBy,
  unifiedNavModeFor,
  type CameraNavMode,
  type NavTarget,
} from '@core/workspace/cameraNav';
import { useFaceSelectionStore } from '@stores/faceSelectionStore';
import { facesOfNode, pickFace, faceHighlightGroups } from '@core/scene/facePicking';
import { isSceneCameraView } from '@core/scene/cameraViewMode';
import { compSizeOf } from '@core/composition/compSizes';
import { isDescendantOf } from '@core/composition/compNavigation';
import { openLayerOnDoubleClick } from '@layout/LayerViewer/openLayer';
import { RULER_CSS_PX, inStrip, rulerStrips } from './rulerGeometry';
import {
  paintPluginDrawLists,
  pluginPointerDown,
  pluginPointerMove,
  pluginPointerUp,
  cancelPluginGesture,
  type PluginModifiers,
} from './pluginDrawOverlay';
import { onPluginDrawChanged } from '@core/plugins/uiCanvas';


/**
 * Screen-px a viewport press must travel before it counts as a drag.
 *
 * Mirrors the engine's `InputSystem` default `dragThreshold`, so the UI drag
 * flag and the tool's `onDragStart` flip on the same movement instead of on
 * two slightly different ones.
 */
const VIEWPORT_DRAG_SLOP = 3;

/** Frame-render failures already reported — one console line per distinct message. */
const reportedRenderErrors = new Set<string>();

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
  /** RAM-preview blit layer (optional — the aux viewport has none). */
  cacheCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** Onion-skin ghost layer (optional, same reason). */
  onionCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  stageRef: React.RefObject<HTMLElement | null>;
  sceneRev: number;
  // No `time`: the playhead reaches the render loop through a clock
  // subscription (see "Playhead → render"), never through a React prop.
  focus?: SnapshotFocus;
  focusKey?: string;
}

export function useWorkspace(args: UseWorkspaceArgs): { ready: boolean; renderError: string | null } {
  const { contentCanvasRef, overlayCanvasRef, cacheCanvasRef, onionCanvasRef, stageRef, sceneRev, focus, focusKey } = args;

  const backendRef = useRef<RenderBackend | null>(null);
  const dprRef = useRef(1);
  // False until the GPU backend has come up and painted the first frame, so the
  // viewport can show a loading state instead of a blank canvas on (re-)entry.
  const [ready, setReady] = useState(false);
  // Non-null when GPU init FAILED on every tier (readyPromise resolves either
  // way — see MotionRendererBackend.initFailed). The viewport shows a visible
  // error instead of dismissing the spinner into a silent blank canvas.
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
  const focusRef = useRef(focus);
  focusRef.current = focus;

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
  // Via ref so the mount-scoped render closure always reads the CURRENT view
  // mode — the raw closure froze it at mount and deadened the 3D/2D toggle.
  const camera3dModeRef = useRef(camera3dMode);
  camera3dModeRef.current = camera3dMode;

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
  const draft3dRef = useRef(draft3d);
  draft3dRef.current = draft3d;

  // Proxies are a VIEWPORT concession — the other opt-in site is
  // useViewportRenderer. Export never sets this. See `@core/assets/proxy`.
  const useProxiesPref = usePreferenceStore((s) => s.useProxies);
  const useProxiesRef = useRef(useProxiesPref);
  useProxiesRef.current = useProxiesPref;

  const mbEnabled = useMotionBlurStore((s) => s.enabled);
  const mbShutter = useMotionBlurStore((s) => s.shutterAngle);
  const mbPhase = useMotionBlurStore((s) => s.shutterPhase);
  const mbSamples = useMotionBlurStore((s) => s.samples);
  const mbLimit = useMotionBlurStore((s) => s.adaptiveSampleLimit);
  // Draft preview quality skips the expensive motion-blur multi-sample pass.
  const draft = useRenderQualityStore((s) => s.draft);

  const compKey = useCompositionStore((s) => s.key());
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compRef = useRef(useCompositionStore.getState().comp());
  compRef.current = useCompositionStore.getState().comp();

  // RAM preview (frame cache) inputs, threaded via refs into the mount-scoped
  // render closure. The cache only fills AND serves during PLAYBACK (read
  // straight off the store at render time): canvas drags can repaint
  // mid-gesture without bumping any revision, so caching interactive renders
  // could blit stale (or half-dragged) pixels back.
  const sceneRevRef = useRef(sceneRev);
  sceneRevRef.current = sceneRev;
  const focusKeyRef = useRef(focusKey);
  focusKeyRef.current = focusKey;

  const activeFps = compRef.current.fps || 60;
  const motionBlurRef = useRef({ enabled: mbEnabled && !draft, shutterAngle: mbShutter, shutterPhase: mbPhase, samples: mbSamples, adaptiveSampleLimit: mbLimit, fps: activeFps });
  motionBlurRef.current = { enabled: mbEnabled && !draft, shutterAngle: mbShutter, shutterPhase: mbPhase, samples: mbSamples, adaptiveSampleLimit: mbLimit, fps: activeFps };

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

    const backend = createRenderBackend();
    backend.attach(content);
    backend.setPreviewChrome?.(true);
    backendRef.current = backend;
    // `window.__motionPerf` (dev builds) — the per-stage timings the HUD shows.
    installPerfDevGlobal();

    // AnimationChanged revision — part of the cache key so a keyframe edit
    // during a playing loop invalidates every cached frame. Media decode
    // completions (video frames landing, texture uploads) also emit
    // AnimationChanged but must NOT bump this — doing so cleared the RAM
    // preview cache on every decoded frame and playback could never warm up.
    let animRev = 0;
    /*
      CLIP-GEOMETRY revision — the bars, which live in the Timeline Engine.

      `sceneContentHash` is exhaustive over the scene graph and the animation
      engine, and a clip bar is in neither: its start, duration and source-in
      belong to the timeline, whose edits deliberately never bump the scene
      revision (see `useClipRevision`). So moving or trimming a bar changed the
      picture and left the cache key identical — frames rendered before the drag
      stayed servable after it, playback interleaved them with fresh ones, and a
      moved layer flickered in and out at times it no longer occupied until
      every frame had been re-rendered.
    */
    let clipRev = 0;
    /** `clipGeometrySignature`, at most once per bar edit rather than per frame. */
    let clipSigMemo: { rev: number; compId: string; sig: string } | null = null;
    const clipSignature = (compId: string): string => {
      if (clipSigMemo && clipSigMemo.rev === clipRev && clipSigMemo.compId === compId) {
        return clipSigMemo.sig;
      }
      const sig = clipGeometrySignature(compId);
      clipSigMemo = { rev: clipRev, compId, sig };
      return sig;
    };
    let lastPlaybackFrame = -1;
    /** Last frame written into the RAM preview this play-through. Used to fill
     *  skipped frames when the playhead outruns rendering (the green cache bar
     *  used to read as disconnected dots). */
    let lastPlaybackPutFrame = -1;
    // Live-layer-set tracking for the playback auto-quality sampler: a frame
    // where the set changes pays materialization costs and is not a fair
    // sample of steady-state render speed (see renderAt).
    let lastLiveSetSig = '';
    let liveSetChangedThisRender = false;
    /** The last `renderFrameAt` threw — its canvas must not enter the RAM preview. */
    let lastRenderFailed = false;
    /** CSS viewport size — part of the cache key (framing), set by sizeAll. */
    let lastCssSize = '';
    const cacheVisibleClass = workspaceStyles.cacheCanvasVisible ?? 'cacheCanvasVisible';

    /**
     * Channel view (Red / Green / Blue / Alpha): copy the frame just rendered
     * onto the 2D blit layer and rewrite its pixels there. See
     * `core/rendering/channelView.ts` for why this is a pixel pass and not a
     * CSS filter. A no-op in RGB, which is every frame that is not being
     * inspected.
     */
    const presentChannelView = (): void => {
      const channel = useGuidesStore.getState().channel;
      if (!channelNeedsPass(channel)) return;
      const content = contentCanvasRef?.current;
      const cache = cacheCanvasRef?.current;
      if (!content || !cache) return;
      const mctx = cache.getContext('2d');
      if (!mctx) return;
      if (cache.width !== content.width || cache.height !== content.height) {
        cache.width = content.width;
        cache.height = content.height;
      }
      mctx.clearRect(0, 0, cache.width, cache.height);
      mctx.drawImage(content, 0, 0);
      applyChannelViewToCanvas(cache, channel);
      cache.classList.add(cacheVisibleClass);
    };

    const onionPainter = createOnionSkinPainter({
      content: () => contentCanvasRef?.current ?? null,
      target: () => onionCanvasRef?.current ?? null,
      settings: () => useOnionSkinStore.getState(),
      // The comp's own frame range. Ghosts outside it are dropped rather than
      // clamped, so the first frame does not wear a stack of identical ghosts.
      bounds: () => {
        const c = compRef.current;
        const f = c.fps || 60;
        const start = c.startFrame ?? 0;
        return { min: start, max: start + Math.round((c.durationSeconds || 0) * f) };
      },
      visibleClass: workspaceStyles.onionCanvasVisible ?? 'onionCanvasVisible',
    });

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
      // Third-party gizmos, last so they sit above the app's own chrome — a
      // plugin's handles are what the user is about to grab.
      paintPluginDrawLists(overlay, controller, timeRef.current, dprRef.current);
    };

    /**
     * Render one comp frame to the content canvas. `ghost` renders the same
     * scene with a TRANSPARENT background, the same way a precomp does, so
     * onion skins layer over each other and over the live frame instead of
     * each one painting an opaque plate over the last.
     *
     * Effect-scoped (not inside render()) because the idle-caching pump also
     * renders frames — with the identical snapshot construction, which is the
     * whole correctness argument for caching what it renders.
     */
    const renderFrameAt = (t: number, ghost = false): void => {
      lastRenderFailed = false;
      try {
        renderFrameAtUnguarded(t, ghost);
      } catch (err) {
        // One bad layer used to throw straight out of the rAF callback: the
        // frame blanked, the chrome never repainted and every later render
        // threw the same way. Contain it to this frame, say so once per
        // distinct message, and keep the canvas out of the RAM preview (it
        // holds the PREVIOUS frame's pixels, or none).
        lastRenderFailed = true;
        const error = err instanceof Error ? err : new Error(String(err));
        if (!reportedRenderErrors.has(error.message)) {
          reportedRenderErrors.add(error.message);
          console.error('[viewport] frame render failed', error);
          getEventBus().emit('EngineError', { engine: 'viewport-render', role: 'viewport', error });
        }
      }
    };
    const renderFrameAtUnguarded = (t: number, ghost: boolean): void => {
      perfBegin(PerfStage.snapshot);
      const snap = {
        ...buildSnapshot(
          defaultSceneGraph,
          defaultAnimation,
          t,
          focusRef.current,
          overlaysRef.current,
          controller.getView(),
          motionBlurRef.current,
          // rootId scopes the render to the ACTIVE composition's subtree. Without
          // it, buildSnapshot flattens every root and draws all comps stacked on
          // top of each other — and the preview (which DOES pass rootId) then
          // showed a different picture than the editor. Both scope the same now.
          {
            ...compRef.current,
            rootId: compRef.current.id,
            compSizeOf,
            // Custom views resolve to a pre-built override camera; ortho /
            // active pass straight through (resolveViewCameraInput reads the
            // live store, so the closure never freezes a stale view).
            ...resolveViewCameraInput(compRef.current.width, compRef.current.height, camera3dModeRef.current),
            draft3d: draft3dRef.current,
            useProxies: useProxiesRef.current,
            // Viewport-only: Quality = Wireframe layers hide their pixels and
            // `paintWireframeQualityLayers` strokes their boxes instead.
            wireframeLayers: true,
            // Alpha view: the comp's own alpha is the picture, so the opaque
            // background plate must not be composited under the layers — with
            // it, every pixel is alpha 1 and the matte reads as solid white.
            ...(ghost || useGuidesStore.getState().channel === 'alpha'
              ? { transparent: true, backgroundPaint: undefined }
              : {}),
          },
        ),
        // The only producer of `snapshot.roi`. Read live from the store so the
        // region takes effect on the very next frame after the menu toggles it.
        roi: useGuidesStore.getState().roi ?? undefined,
        // Ortho / custom views must not be cropped to the comp rect; a
        // camera view is a shot, and is — like Active Camera.
        viewIsActiveCamera: isSceneCameraView(camera3dModeRef.current),
      };
      perfEnd(PerfStage.snapshot);
      // Detect a live-set change (a layer crossed its in/out point this
      // frame). That frame pays one-off costs — rasterize the new layer's
      // texture, upload it, spin up its decoder — that say nothing about the
      // comp's steady-state render cost, so the playback auto-quality
      // sampler skips it (see the reportPlaybackFrame call below). Without
      // this, a layer starting at 2s spiked the frame budget exactly at 2s,
      // slowPlayback tripped, and the WHOLE viewport dropped to Half and
      // stayed blurry for the 45-frame restore run — the "everything
      // flashes and goes soft when my layer appears" report.
      if (!ghost) {
        const sig = snap.layers.map((l) => l.id).join('\n');
        if (sig !== lastLiveSetSig) {
          lastLiveSetSig = sig;
          liveSetChangedThisRender = true;
        }
      }
      backend.renderFrame(snap);
      // The scopes panel (and anything else that wants the composited
      // frame) taps it HERE, the one place the content canvas is guaranteed
      // freshly drawn — a cache blit leaves it stale.
      if (!ghost) {
        publishFrame(content, t);
        // Snapshot compare (F5) reads the WebGL canvas in the same task as the
        // draw for the same reason; `captureFrom` is a no-op unless armed.
        if (useCompareStore.getState().pending) {
          useCompareStore.getState().captureFrom(content, t, controller.getView());
        }
        // Difference mode is the one comparison that needs BOTH pictures, so
        // it needs a live copy per frame. Gated, because it is a full-canvas
        // `drawImage` — the other three modes let the content canvas itself be
        // the live half and pay nothing here.
        if (needsLiveFrame()) captureLiveFrame(content);
      }
    };

    // ── Idle caching (the After Effects idle pump) ─────────────────────
    //
    // While the editor is PAUSED and quiet, quietly render frames into the RAM
    // preview — one slice at a time, masked behind the cache overlay so nothing
    // flashes on screen. Pressing play then starts on green instead of paying
    // the first pass live. Any real render (scrub, edit, play, decode landing)
    // bumps `renderSeq` and the pass silently stands down; a media decode still
    // in flight ends the pass early and the decode's own repaint re-arms it.
    //
    // ── How far ahead ──────────────────────────────────────────────────
    // The WORK AREA, from the playhead forward and then wrapping to its start —
    // which is what After Effects fills, and what makes the green bar mean
    // "this is ready" rather than "the next few seconds are ready". A five
    // second look-ahead only ever helped the first press of play; a filled work
    // area makes the whole loop real-time, which is the thing people actually
    // want from a preview.
    //
    // Wrapping matters as much as the span. Caching forward-only from the
    // playhead leaves the head of the work area cold, so playing the loop again
    // — the single most common thing anyone does with a work area — starts on
    // the one part that was never cached.
    //
    // One PASS per invalidation, tracked by `visited`. Without that bound, a
    // span larger than the cache would evict its own head and the pump would
    // re-render forever on a paused editor. The disk tier keeps evicted frames
    // (the blue lane), so a long pass is not wasted work even when RAM cannot
    // hold all of it.
    //
    // `idleCacheWorkArea` turns the span back down to a short look-ahead for
    // anyone who would rather their machine stayed quiet.
    const IDLE_CACHE_DELAY_MS = 1500;
    const IDLE_CACHE_AHEAD_SEC = 5;
    /** How long one idle slice may hold the main thread before yielding. */
    const IDLE_CACHE_SLICE_BUDGET_MS = 8;
    /** Re-arm delay after a pass stopped on still-decoding media — short,
     *  because user quiescence is already established by then. */
    const IDLE_CACHE_MEDIA_RETRY_MS = 150;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleSliceTimer: ReturnType<typeof setTimeout> | null = null;
    let renderSeq = 0;
    /**
     * Consecutive passes that stopped on unsettled media without caching a
     * single frame. Bounds the fast retry: a source that never becomes exact
     * (a broken decode, an offline file) would otherwise hold the pump in a
     * 150ms loop of two full comp renders each — forever, on a PAUSED editor.
     * That is the same perpetual-tickover failure the all-cached early-out
     * exists to prevent, so the fast path has to be able to give up.
     */
    let idleMediaRetries = 0;
    const IDLE_CACHE_MAX_MEDIA_RETRIES = 6;

    const isPlayingNow = (): boolean => {
      const s = useWorkspaceStore.getState();
      const t = s.activeTabId ? s.tabs[s.activeTabId] : null;
      return t?.playing === true;
    };

    /** True while an export or the Export dialog's live preview is running.
     *  The idle pump must stand down then: exports share the exact-decoder
     *  singleton, and interleaving the pump's frame requests with the
     *  export's forward walk kills the export's streaming readers on every
     *  alternation — a paused viewport quietly making a queued render slow. */
    const isExportBusy = (): boolean =>
      useRenderQueueStore.getState().isRunning
      || useModalStore.getState().stack.some((m) => m.id === 'export-dialog');

    const cancelIdleCache = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (idleSliceTimer !== null) {
        clearTimeout(idleSliceTimer);
        idleSliceTimer = null;
      }
    };

    // Set by an explicit "Cache Work Area Now"; read once by the next pass.
    let explicitCacheRequest = false;
    const startIdlePass = (): void => {
      idleTimer = null;
      const b = backendRef.current;
      if (!b || b !== backend || isPlayingNow() || isExportBusy()) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const fps = compRef.current.fps || 60;
      const lastCompFrame = Math.max(0, Math.round((compRef.current.durationSeconds || 0) * fps) - 1);
      // Which frames, and where to start — pure and unit-tested, because a span
      // that is one frame long or one frame off is invisible from in here.
      // An explicit request means the whole span whatever the idle preference
      // says — the toast promised the work area.
      const wantWholeSpan = explicitCacheRequest || usePreferenceStore.getState().idleCacheWorkArea;
      explicitCacheRequest = false;
      const span = idleCacheSpan({
        playhead: Math.round(timeRef.current * fps),
        lastCompFrame,
        fps,
        workArea: wantWholeSpan ? getTimelineController().getWorkArea() : null,
        wholeSpan: wantWholeSpan,
        aheadSeconds: IDLE_CACHE_AHEAD_SEC,
      });
      if (!span) return;

      let f = span.from;
      /** Frames examined this pass. The pass ends after one lap of the span. */
      let visited = 0;
      /** Advance the cursor, wrapping at the end of the span. */
      const step = (): void => {
        f = nextSpanFrame(f, span);
        visited += 1;
      };
      /** Skip to the next frame this pass still has to render. */
      const skipCached = (): void => {
        while (visited < span.length && viewportFrameCache.has(f)) step();
      };

      // Let the disk tier start promoting this window back into RAM. Probing
      // with `has` (below) deliberately does not do this, so without an
      // explicit nudge the pump would re-render from scratch every frame that
      // had been evicted from RAM but is still on disk.
      viewportFrameCache.prefetchFrom(f);
      // Find the first frame that actually needs rendering BEFORE disturbing
      // anything. `has` rather than `get`: a probe must not re-order the LRU
      // (scanning a cached run used to promote all of it to most-recently-used,
      // so eviction then dropped the frames NEAREST the playhead) and must not
      // fire a disk look-ahead per probe.
      skipCached();
      // Nothing to do. Return without masking, without re-rendering and without
      // re-arming — otherwise a settled editor sitting on a fully cached span
      // woke every 1.5s forever to mask, scan, render the current frame again
      // and re-arm itself: a permanent GPU/CPU tickover on an idle app.
      // Any real render (scrub, edit, decode landing) re-arms via armIdleCache.
      if (visited >= span.length) return;

      const cacheCanvas = cacheCanvasRef?.current;
      if (!cacheCanvas) return;
      const mctx = cacheCanvas.getContext('2d');
      if (!mctx) return;

      // ── The freeze-mask ────────────────────────────────────────────────
      //
      // Hold the CURRENT picture on this 2D layer while future frames render
      // invisibly beneath it on the WebGL content canvas.
      //
      // The mask must be snapshotted from a drawing buffer that still HOLDS
      // those pixels, which means rendering the current frame right here, in
      // this same task, and reading it back before the compositor runs. The
      // WebGL2 context is created without `preserveDrawingBuffer` (the default,
      // and the right default — preserving it costs a full extra buffer copy on
      // every composited frame of playback), so its contents are undefined once
      // the frame has been presented. This pass fires 1500ms after the last
      // real paint, so the old code's bare `drawImage(content, 0, 0)` copied a
      // cleared buffer: the mask was fully transparent, hid nothing, and the
      // user watched the pump render five seconds of future frames onto the
      // live canvas. That is the "it plays even though I never pressed play"
      // report — the playhead never moved, only the picture did.
      renderFrameAt(timeRef.current);
      // A backend that is still initializing coalesces the snapshot instead of
      // drawing it, which would put us right back to masking with stale or
      // empty pixels. Stand down and let the next real render re-arm us.
      // A frame that THREW is the same case.
      if (lastRenderFailed || b.lastFrameDidRender?.() === false) return;
      if (cacheCanvas.width !== content.width || cacheCanvas.height !== content.height) {
        cacheCanvas.width = content.width;
        cacheCanvas.height = content.height;
      }
      mctx.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
      mctx.drawImage(content, 0, 0);
      {
        const viewChannel = useGuidesStore.getState().channel;
        if (channelNeedsPass(viewChannel)) applyChannelViewToCanvas(cacheCanvas, viewChannel);
      }
      cacheCanvas.classList.add(cacheVisibleClass);

      const seqAtStart = renderSeq;
      const finish = (): void => {
        idleSliceTimer = null;
        // Restore the live picture unless something else already rendered
        // (a real render unmasks and repaints on its own).
        if (renderSeq === seqAtStart && !isPlayingNow()) render();
      };
      const slice = (): void => {
        idleSliceTimer = null;
        if (renderSeq !== seqAtStart || isPlayingNow() || isExportBusy() || backendRef.current !== backend) return;
        skipCached();
        if (visited >= span.length) {
          finish();
          return;
        }
        // Time-budget the slice instead of rendering exactly one frame per
        // task. Back-to-back `setTimeout(…, 0)` full comp renders starve input
        // handlers on a heavy comp, so a paused editor felt sticky to click
        // while it pre-rendered; yielding on a budget keeps the main thread
        // responsive without giving up throughput on light comps.
        const sliceStart = performance.now();
        while (visited < span.length) {
          renderFrameAt(f / fps);
          // Only a frame that actually drew, with settled media, may be kept.
          if (lastRenderFailed || b.lastFrameDidRender?.() === false) {
            finish();
            return;
          }
          if (b.lastFrameMediaExact?.() === false) {
            // Media still decoding. Its landing repaints and re-arms the pump,
            // but a decode that lands without a repaint would otherwise leave
            // the pass parked for the full idle delay — on a video comp that
            // meant roughly one cached frame per 1.5 seconds. Retry soon, but
            // only while that is plausibly a decode in flight: past the cap,
            // fall back to the normal idle delay so a source that never settles
            // cannot pin a paused editor in a busy loop.
            finish();
            cancelIdleCache();
            idleMediaRetries += 1;
            idleTimer = setTimeout(
              startIdlePass,
              idleMediaRetries <= IDLE_CACHE_MAX_MEDIA_RETRIES
                ? IDLE_CACHE_MEDIA_RETRY_MS
                : IDLE_CACHE_DELAY_MS,
            );
            return;
          }
          viewportFrameCache.put(f, content);
          // Progress: the fast retry has earned its budget back.
          idleMediaRetries = 0;
          step();
          if (performance.now() - sliceStart >= IDLE_CACHE_SLICE_BUDGET_MS) break;
          skipCached();
        }
        if (visited >= span.length) {
          finish();
          return;
        }
        idleSliceTimer = setTimeout(slice, 0);
      };
      idleSliceTimer = setTimeout(slice, 0);
    };

    const armIdleCache = (): void => {
      cancelIdleCache();
      idleTimer = setTimeout(startIdlePass, IDLE_CACHE_DELAY_MS);
    };
    const cacheRequestSub = onPreviewCacheRequest(() => {
      explicitCacheRequest = true;
      cancelIdleCache();
      startIdlePass();
    });

    const render = (): void => {
      const b = backendRef.current;
      if (!b) return;
      renderSeq += 1;

      // ── RAM preview ────────────────────────────────────────────────
      //
      // Fill AND serve only while PLAYING: an interactive repaint (a canvas
      // drag, a hover) can happen mid-gesture without bumping any revision, so
      // caching those would blit half-dragged pixels back later. That is the
      // contract `frameCache` was written for; nothing had ever called it, so
      // the cache stayed empty, `ranges` always returned [] and the timeline's
      // cache bar could never draw.
      const ws = useWorkspaceStore.getState();
      const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : null;
      const playing = tab?.playing === true;
      // AE's audio-only preview: the transport runs, the sound plays, the
      // viewer holds the frame it was on. Returning before any render work is
      // the point — with no picture to draw there is nothing to fall behind,
      // which is why AE offers this for auditioning a long comp at real speed.
      // Only while PLAYING: a paused viewport must still repaint, or toggling
      // the switch would blank the editor.
      if (playing && !previewIncludesVideo()) return;
      b.setPlaybackMode?.(playing);
      if (!playing && useRenderQualityStore.getState().slowPlayback) {
        // Stopped: back to the chosen quality for the frame the user is looking at.
        useRenderQualityStore.getState().setSlowPlayback(false);
      }
      const fps = compRef.current.fps || 60;
      const frame = Math.round(timeRef.current * fps);
      if (playing) {
        // Loop wrap: only reset the catch-up cursor. The RAM/disk caches
        // SURVIVE the wrap — that is their entire purpose ("the second pass
        // over a heavy comp plays at full rate"). Stale-video poisoning, the
        // reason a wrap used to wipe everything, is prevented at the source:
        // frames rendered with unsettled media never enter the cache at all
        // (see the lastFrameMediaExact gate below).
        if (lastPlaybackFrame >= 0 && frame < lastPlaybackFrame) {
          lastPlaybackPutFrame = -1;
        }
        lastPlaybackFrame = frame;
      }
      // Everything that changes pixels goes in the key; a change clears the RAM
      // cache wholesale. Built from scalars rather than JSON.stringify — this
      // runs every frame while playing, including on the cache-hit path below.
      //
      // Computed unconditionally rather than inside `if (playing)` because the
      // ONION SKINS memoize on it too, and they only ever run while PAUSED —
      // leaving it in the playing branch would have left them with no way to
      // tell an edit from a mouse move.
      const view = controller.getView();
      const ov = overlaysRef.current;
      const mb = motionBlurRef.current;
      const roiK = useGuidesStore.getState().roi;
      // The scene's CONTENT, not its revision counter.
      //
      // A counter answers "did anything change?" and nothing else, and that
      // cost in two places: an UNDO bumped the rev and threw away a cache whose
      // pixels were now identical to the ones it had just evicted, and a
      // counter that resets to 0 every launch cannot identify a scene across a
      // restart — which is why the disk tier still purges on open.
      //
      // Memoized ON those counters, so it costs one scene walk per EDIT rather
      // than one per frame; the counters keep doing the O(1) job they are
      // actually good at.
      const contentKey = memoizedSceneContentHash(
        defaultSceneGraph, defaultAnimation, sceneRevRef.current, animRev,
      );
      // NOTE: adaptive/preview RESOLUTION is deliberately absent — it changes
      // quality, not content, and including it wiped the whole RAM+disk
      // preview twice per adaptive flip (degrade AND restore), so the green
      // bar could never complete on exactly the comps that need the cache
      // most. Cached frames keep whatever resolution they were rendered at,
      // like After Effects. CSS size IS included: it changes framing.
      const invalidationKey = [
        contentKey, clipSignature(compRef.current.id), focusKeyRef.current,
        // The WHOLE comp key, not just id/size/fps. Background colour, gradient
        // paint and Transparent were absent, so toggling Transparent (or the
        // colour) kept serving the cached opaque frames — from RAM and, after
        // a clear, promoted straight back from the disk tier — and the
        // composition looked unchanged until something unrelated invalidated
        // the cache. "Transparent does nothing" was that.
        compRef.current.id, compKeyFor(compRef.current), fps,
        // Alpha view renders without the background plate (renderFrameAt), so
        // its frames must never be blitted back into the RGB view or vice versa.
        useGuidesStore.getState().channel === 'alpha' ? 'A' : 'C',
        camera3dModeRef.current, draft3dRef.current ? 1 : 0,
        lastCssSize,
        view.scale, view.offsetX, view.offsetY,
        ov.rulers ? 1 : 0, ov.grid ? 1 : 0, ov.gridSpacing, ov.gridSubdivisions, ov.gridStyle, ov.gridColor, ov.proportionalGrid ? 1 : 0, ov.proportionalColumns, ov.proportionalRows, ov.safeArea ? 1 : 0,
        mb.enabled ? 1 : 0, mb.shutterAngle, mb.shutterPhase, mb.samples, mb.adaptiveSampleLimit,
        roiK ? `${roiK.x},${roiK.y},${roiK.width},${roiK.height}` : '-',
      ].join(':');
      // Turn the cache over on EVERY render, not just playing ones.
      //
      // This used to live inside `if (playing)`, from when playback was the
      // only thing that touched the cache. The idle pre-render pump broke that
      // assumption: it fills both tiers while PAUSED, so all of its traffic ran
      // under whatever key was last set — an empty string on a project that has
      // never been played. Consequences, all of them real:
      //
      //   • An edit made while paused did not clear the cache, so the pump then
      //     SKIPPED those frames as already cached and the stale pre-edit
      //     pixels blitted on the next play.
      //   • Post-edit frames were stored under the pre-edit key, and the disk
      //     tier persisted them there — servable as wrong pixels later.
      //   • The disk tier stayed inert before the first play (it refuses to
      //     write without a generation), so a paused pre-render was RAM-only.
      //
      // `setKey` is a string compare when nothing changed, so this is free on
      // the hot path.
      viewportFrameCache.setKey(invalidationKey, content.width, content.height);

      // SERVE and FILL while paused too, not only while playing — scrubbing
      // back over a green region used to re-render every frame from scratch.
      // The conditions, and the four separate hazards they answer, are in
      // `previewCacheGate`.

      const interacting = useRenderQualityStore.getState().interacting;
      const gateState = {
        playing,
        interacting,
        onionSkins: useOnionSkinStore.getState().enabled,
        timeSec: timeRef.current,
        fps,
        frame,
      };
      if (mayServeCachedFrame(gateState)) {
        const hit = viewportFrameCache.get(frame);
        const cacheCanvas = cacheCanvasRef?.current;
        // During playback an ISOLATED hit is worse than a miss: the blit path
        // parks the video elements and the live path, one frame later, demands
        // them back — a hard seek per fragment boundary, felt as freeze /
        // old-frames / fast-pass. Blit only with a real run ahead; a paused
        // serve has no next frame and skips the check. See previewCacheGate.
        // (Computed once — the park instruction below reuses it.)
        const runEnd = hit ? viewportFrameCache.contiguousEnd(frame) : frame;
        const runOk = !playing || playbackBlitWorthwhile(frame, runEnd);
        if (hit && cacheCanvas && runOk) {
          // Blit instead of re-rendering the whole comp — the entire point of a
          // RAM preview: the second pass over a heavy comp plays at full rate.
          // It goes on its own 2D layer because the content canvas is WebGL and
          // a canvas only ever has one context.
          if (cacheCanvas.width !== hit.width || cacheCanvas.height !== hit.height) {
            cacheCanvas.width = hit.width;
            cacheCanvas.height = hit.height;
          }
          const ctx = cacheCanvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
            ctx.drawImage(hit, 0, 0);
            // Cached frames are stored as rendered (RGBA); the channel view
            // is applied to the copy on screen, never to the cache itself.
            const viewChannel = useGuidesStore.getState().channel;
            if (channelNeedsPass(viewChannel)) applyChannelViewToCanvas(cacheCanvas, viewChannel);
            cacheCanvas.classList.add(cacheVisibleClass);
            // Playback bookkeeping only: this cursor drives the catch-up loop,
            // which does not run while paused.
            if (playing) lastPlaybackPutFrame = frame;
            // Blits bypass renderFrame, so nothing else drives the playback
            // video elements — keep them tracking the playhead or the next
            // cache miss pays a hard mid-GOP seek (a visibly frozen picture).
            // The second argument tells the provider where this green span
            // ENDS, so a decoder that can't sustain realtime is parked there,
            // decoded and ready, instead of chasing a playhead whose frames
            // are already cached.
            b.syncPlaybackVideo?.(frame / fps, runEnd / fps);
            renderCache.mark(timeRef.current);
            viewportHudStats.report(0, true);
            paintChrome();
            return;
          }
        }
      }
      // Anything that renders for real must reveal the live canvas again.
      cacheCanvasRef?.current?.classList.remove(cacheVisibleClass);

      // Renders one frame of the comp — hoisted to `renderFrameAt` at effect
      // scope so the idle-caching pump can render ahead with the exact same
      // snapshot construction. This local alias keeps the onion painter's
      // (t, ghost) callback signature.
      const renderAt = (t: number, ghost = false): void => renderFrameAt(t, ghost);
      /** HUD sample for this real render — the wall time of the whole tick. */
      const hudStart = performance.now();
      // Per-stage timings belong to REAL renders only: the blit path above
      // returned before opening a frame, so cached frames never dilute them.
      framePerf.beginFrame();
      perfBegin(PerfStage.total);

      // ── Onion skins ────────────────────────────────────────────────
      //
      // Each ghost costs a FULL comp render, so this is gated three ways: off
      // by default, never while playing, and memoized on a signature that moves
      // only when the ghosts would actually differ (playhead, settings, edit,
      // view). A hover or a selection change must not re-render the set.
      //
      // Ghosts are rendered BEFORE the live frame because every render
      // overwrites the same content canvas — the live frame has to be the last
      // thing in it when this function returns.
      onionPainter.paint(renderAt, frame, fps, playing, invalidationKey);

      if (playing) {
        // Catch up SMALL gaps the playhead skipped while the last render was
        // in flight, so the cache bar stays contiguous. Large gaps mean the
        // comp is behind realtime — rendering every missed frame then made a
        // stall WORSE (up to 15 full comp renders in one tick, only the last
        // ever displayed) and, divided out below, hid the overload from the
        // adaptive-quality sampler exactly when it was needed. Behind by more
        // than the small gap: render only the current frame and let the next
        // loop pass fill the cache.
        const catchFrom = lastPlaybackPutFrame >= 0 ? lastPlaybackPutFrame + 1 : frame;
        const maxCatchUp = 3;
        const from = catchFrom <= frame && frame - catchFrom + 1 > maxCatchUp
          ? frame
          : catchFrom;
        const renderStart = performance.now();
        liveSetChangedThisRender = false;
        for (let f = from; f <= frame; f++) {
          renderAt(f / fps);
          // Frames holding stand-in video pixels (element mid-seek at a loop
          // wrap, a decode still warming) must not be cached — they would
          // replay their stale pixels on every later pass.
          if (!lastRenderFailed && b.lastFrameMediaExact?.() !== false) {
            perfBegin(PerfStage.cacheReadback);
            viewportFrameCache.put(f, content);
            perfEnd(PerfStage.cacheReadback);
          }
        }
        lastPlaybackPutFrame = frame;
        // Adaptive Resolution for PLAYBACK: a heavy comp's first pass renders
        // at the floor instead of dropping frames, so the RAM preview fills at
        // something close to real time. See `reportPlaybackFrame`.
        //
        // PER-FRAME cost, not the loop total: the catch-up loop can render
        // several frames in one tick, and charging their sum against a single
        // frame's budget counted every catch-up as "slow" — three catch-ups in
        // a row degraded the viewport on comps that render well inside budget.
        //
        // Materialization frames (live set changed) are skipped outright —
        // their one-off raster/upload/decoder costs are not steady-state.
        if (!liveSetChangedThisRender) {
          const rendered = Math.max(1, frame - from + 1);
          useRenderQualityStore.getState().reportPlaybackFrame(
            (performance.now() - renderStart) / rendered, 1000 / fps,
          );
        }
      } else {
        const q = useRenderQualityStore.getState();
        if (interacting) {
          // Adaptive Resolution for DRAGS mirrors the playback path: measure
          // the real frame cost and let the store's hysteresis decide. A drag
          // on a light comp keeps full quality; a heavy one degrades within
          // two frames (see `reportInteractFrame`). 30ms ≈ a 30fps feel — the
          // point where a drag starts to read as laggy rather than live.
          // Materialization frames are skipped for the same reason as in the
          // playback branch: their one-off costs are not steady state.
          const renderStart = performance.now();
          liveSetChangedThisRender = false;
          renderAt(timeRef.current);
          if (!liveSetChangedThisRender) {
            q.reportInteractFrame(performance.now() - renderStart, 30);
          }
        } else {
          renderAt(timeRef.current);
          // And CACHE it, so a scrub leaves a green trail behind it. The idle
          // pump is otherwise the only paused writer, and it needs 1.5s of
          // quiet that an active scrub re-arms away on every move.
          if (!lastRenderFailed && mayFillFromPausedRender({ ...gateState, mediaExact: b.lastFrameMediaExact?.() !== false })) {
            perfBegin(PerfStage.cacheReadback);
            viewportFrameCache.put(frame, content);
            perfEnd(PerfStage.cacheReadback);
          }
        }
      }

      renderCache.mark(timeRef.current);
      presentChannelView();
      perfEnd(PerfStage.total);
      framePerf.endFrame();
      viewportHudStats.report(performance.now() - hudStart, false);
      paintChrome();
      // Idle pump: paused and settled → start extending the green bar; any
      // state where frames stream (playback) keeps it cancelled.
      if (playing) cancelIdleCache();
      else armIdleCache();
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
      // CSS viewport size, for the frame-cache invalidation key: a changed
      // CSS size changes FRAMING (cached frames would be wrong), while a
      // changed device-pixel density (adaptive resolution) only changes
      // QUALITY and must NOT wipe the cache.
      lastCssSize = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprRef.current = dpr;
      // Preview resolution (Full/Half/Third/Quarter) scales only the CONTENT
      // buffer — overlay chrome and interaction math stay at full dpr so
      // handles/rulers remain crisp and hit-testing is unaffected.
      // `effectiveResolution`, not `resolution`: Adaptive Resolution drops the
      // buffer during a drag and this is the one place the buffer is sized.
      const previewRes = useRenderQualityStore.getState().effectiveResolution() || 1;
      backend.resize(rect.width, rect.height, dpr / previewRes);
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

    // The GPU backend initializes asynchronously; frames requested before it's
    // ready coalesce to a single pending frame. Re-size + fit the instant it
    // comes up so a freshly opened project paints immediately instead of waiting
    // on the 600ms backstop — the cause of the scene appearing late on load.
    let readyCancelled = false;
    if (backend.readyPromise) {
      backend.readyPromise.then(() => {
        if (!readyCancelled && backendRef.current === backend) {
          // readyPromise resolving is NOT success — a failed GPU init also
          // resolves it (so awaiters never hang). Only flip to ready when the
          // backend can actually paint; otherwise surface the error instead
          // of dismissing the spinner into a silent blank canvas.
          if (backend.initFailed) {
            setRenderError(
              backend.initErrorMessage ??
                'GPU rendering could not be initialized (WebGL2/WebGPU unavailable).',
            );
            return;
          }
          setRenderError(null);
          sizeAll();
          setReady(true);
        }
      });
    } else {
      // Canvas2D / synchronous backends are ready immediately.
      setReady(true);
    }

    // Re-size the content buffer when the preview-resolution dropdown changes
    // (sizeAll re-reads the store), so Full/Half/Third/Quarter takes effect in
    // the main editor viewport — not just Presentation mode.
    // Keyed on the EFFECTIVE resolution so a drag's degrade and its release
    // both resize the buffer — the adaptive path has no other way in.
    let lastPreviewRes = useRenderQualityStore.getState().effectiveResolution();
    const qualitySub = useRenderQualityStore.subscribe((s) => {
      const eff = s.effectiveResolution();
      if (eff !== lastPreviewRes) {
        lastPreviewRes = eff;
        sizeAll();
      }
    });

    // Onion-skin settings are read off the store INSIDE render(), so changing
    // one has to ask for a repaint or nothing happens until something else
    // does — the toggle would flip, the ghosts would not appear, and the
    // feature would read as broken. (It did, before this subscription.)
    let lastOnion = useOnionSkinStore.getState();
    const onionSub = useOnionSkinStore.subscribe((s) => {
      if (
        s.enabled !== lastOnion.enabled || s.before !== lastOnion.before
        || s.after !== lastOnion.after || s.step !== lastOnion.step
        || s.opacity !== lastOnion.opacity || s.colorize !== lastOnion.colorize
      ) {
        lastOnion = s;
        controller.requestRender();
      }
    });

    /*
      Clip edits reach us as `DocumentChanged {source:'timeline'}` — the bus
      signal every composition's timeline already emits for exactly the events
      that move a bar (LayerMoved, LayerTrimmed, LayerSplit, LayerUpdated…).

      Subscribed on the BUS rather than on `controller.timeline.events`: the
      controller holds one timeline per composition and swaps them on a tab
      change, so a direct subscription would silently stop hearing about the
      comp the user switched to. The bus listener is bound once and hears all
      of them.
    */
    const clipSub = getEventBus().on('DocumentChanged', (payload) => {
      if (payload?.source !== 'timeline') return;
      clipRev++;
      controller.requestRender();
    });

    // Content also depends on the animation engine (keyframe edits, playback).
    const animSub = getEventBus().on('AnimationChanged', (payload) => {
      if (!isMediaDecodeRepaint(payload)) animRev++;
      // During playback the playhead pump already re-renders every frame;
      // decode-landing repaints on top of that were a render storm.
      const tabPlaying = useWorkspaceStore.getState().activeTabId
        ? useWorkspaceStore.getState().tabs[useWorkspaceStore.getState().activeTabId!]?.playing
        : false;
      if (!isMediaDecodeRepaint(payload) || !tabPlaying) {
        controller.requestRender();
      }
    });

    const nodeSub = getEventBus().on('NodeUpdated', () => {
      controller.requestRender();
    });

    // Leaving playback must reveal the live canvas even if no further render is
    // requested, or the last blitted frame would sit frozen over the viewport.
    let wasPlaying = false;
    const playSub = useWorkspaceStore.subscribe((s) => {
      const t = s.activeTabId ? s.tabs[s.activeTabId] : null;
      const playing = t?.playing === true;
      if (playing === wasPlaying) return;
      wasPlaying = playing;
      if (!playing) {
        lastPlaybackFrame = -1;
        lastPlaybackPutFrame = -1;
        cacheCanvasRef?.current?.classList.remove(cacheVisibleClass);
        controller.requestRender();
      }
    });
    // Reflect the engine cursor on the overlay (rich resize/rotate cursors).
    const cursorSub = controller.ws.cursor.events.on('changed', ({ css }) => {
      overlay.style.cursor = css;
    });
    overlay.style.cursor = controller.ws.cursor.css;

    return () => {
      readyCancelled = true;
      cancelIdleCache();
      cacheRequestSub();
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      window.removeEventListener('resize', sizeAll);
      ro.disconnect();
      qualitySub();
      onionSub();
      animSub.dispose();
      clipSub.dispose();
      nodeSub.dispose();
      playSub();
      // Don't leave a mount's worth of frames pinned in RAM.
      viewportFrameCache.clear();
      cursorSub.dispose();
      // Drop only OUR subscription. This used to install a no-op callback,
      // which — under the old single-slot onRender — silently unsubscribed
      // every other listener (both canvas overlays) as a side effect.
      disposeRender();
      backend.dispose();
      backendRef.current = null;
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
  useEffect(() => {
    // The view itself is a pixel pass on the blit layer (`presentChannelView`
    // in the render effect — see core/rendering/channelView.ts for why it is
    // not a CSS filter). This effect only handles the mode CHANGE: hide the
    // blit layer so the frame drawn under the previous mode is not on screen
    // until the render effect (which lists `channel` in its deps) draws the
    // current frame again. Alpha-view frames are keyed apart in the frame
    // cache (see `invalidationKey`), so nothing needs clearing here.
    cacheCanvasRef?.current?.classList.remove(workspaceStyles.cacheCanvasVisible ?? 'cacheCanvasVisible');
  }, [channel, cacheCanvasRef]);

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

  // Face-select chrome lives on the overlay, which only repaints when something
  // asks it to — without this the highlight would not appear until the next
  // unrelated interaction.
  useEffect(() => {
    const controller = getWorkspaceController();
    const unFace = useFaceSelectionStore.subscribe(() => controller.requestRender());
    // A face belongs to its layer: selecting a different layer must drop it,
    // or the inspector would keep pointing at a side of something else.
    const unSel = useSelectionStore.subscribe((s) => {
      const fs = useFaceSelectionStore.getState();
      if (fs.nodeId && !s.ids.includes(fs.nodeId)) fs.clear();
    });
    return () => {
      unFace();
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
      const target = findNavTarget();
      if (!target) {
        // Say WHY rather than doing nothing. Inertness here is correct — a
        // camera only moves 3D layers — but silent inertness is indistinguishable
        // from a broken tool, and was reported as one.
        const why = describeNavUnavailable();
        if (why) useUIStore.getState().notify({ level: 'info', message: why, durationMs: 6000 });
        return false;
      }
      // Orbit pivot (AE's Orbit Around Cursor / Scene): resolved ONCE, at drag
      // start, from the pointer's comp position — only for scene cameras;
      // views keep their promote-to-custom-view orbit (orbitNavBy ignores it).
      const pivot = mode === 'orbit' && target.kind === 'scene'
        ? resolveOrbitPivot(
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
      if (!findNavTarget()) return;
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
      /*
        Plugin on-canvas UI, before any host gesture that could swallow it.

        Two claims, both in `pluginDrawOverlay`: a contributed TOOL owns the
        whole viewport while it is active, and a press on a plugin's HANDLE
        owns that one drag. Anything else falls straight through, which is what
        lets a plugin's gizmo sit on screen while the user keeps using Select.
      */
      if (pluginPointerDown(controller, local(e), modifiersOf(e), timeRef.current)) {
        e.preventDefault();
        try {
          overlay.setPointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }
        useUIStore.getState().setDragging(true);
        controller.requestRender();
        return;
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
        const tryNode = (id: string | undefined): boolean => {
          const n = id ? defaultSceneGraph.getNode(id) : null;
          if (!n) return false;
          const face = pickFace(facesOfNode(n, playheadTime(), comp.w, comp.h), at);
          if (!face) return false;
          e.preventDefault();
          // Select the layer too: the inspector edits face materials on the
          // selected layer, so a face with no layer selected has nothing to
          // write to.
          useSelectionStore.getState().set([n.id]);
          useFaceSelectionStore.getState().select(n.id, face.kind, face.suffix);
          controller.requestRender();
          return true;
        };
        // The layer being styled wins over whatever the plain hit-test finds:
        // a flat layer drawn in front of it would otherwise swallow every click,
        // and it has no faces to offer in exchange.
        if (tryNode(useSelectionStore.getState().ids[0])) return;
        if (tryNode(controller.ws.hitTestScreen(local(e))?.id)) return;
        // Clicking empty canvas in face mode drops the face, keeping the layer.
        useFaceSelectionStore.getState().clear();
        controller.requestRender();
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
        const node = ids.length === 1 ? defaultSceneGraph.getNode(ids[0]!) : null;
        if (!node || !isPaintableKind(node)) {
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
        const space = paintSpaceAt(node.id, playheadTime(), { width: comp.w, height: comp.h });
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
            const srcSpace = srcId === node.id ? space : paintSpaceAt(srcId, playheadTime(), { width: comp.w, height: comp.h });
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
        const start = capturePositionTracks(hit.nodeId);
        const mp = {
          ...hit,
          gesture: new GestureSession(hit.part === 'point' ? 'Move keyframe' : 'Adjust path tangent'),
          start,
          ids: null as PositionKeyIds | null,
          latest: null as (() => Command[]) | null,
          continuous: isPathTangentContinuous(hit.nodeId, hit.t),
          broken: false,
          ready: Promise.resolve(),
        };
        mp.ready = resolvePositionKeyIds(hit.nodeId, start).then((ids) => {
          mp.ids = ids;
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
        const hitNode = hit ? defaultSceneGraph.getNode(hit.id) : null;
        if (hitNode && !hitNode.locked && hitNode.components.some((c) => c.type === 'Text')) {
          typeEditRef.current = hitNode.id as string;
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
      // A plugin gesture in flight claims the move; with none in flight this
      // still delivers HOVER to a plugin whose handle is under the pointer and
      // returns false, because hover is information rather than a claim.
      if (pluginPointerMove(controller, local(e), modifiersOf(e), timeRef.current)) {
        controller.requestRender();
        return;
      }
      // Region-of-Interest resize in progress.
      {
        const rd = roiDragRef.current;
        if (rd && rd.pointerId === e.pointerId) {
          const roi = useGuidesStore.getState().roi;
          if (roi) {
            const cp = controller.ws.screenToWorld(local(e));
            const comp = useCompositionStore.getState();
            useGuidesStore.getState().setRoi(
              clampRoi(resizeRoi(roi, rd.handle, cp), comp.width, comp.height),
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
        const mirror = drag.continuous && !drag.broken;
        const { nodeId, t, start } = drag;
        // One undo step for the whole drag: the engine gesture opened on press.
        // Every message is built from the PRESS state (`start`) + this pointer.
        drag.latest = part === 'point'
          // Move the point in 2D (both axis tracks get a key at this time;
          // spatial tangents are relative offsets, so they travel with it).
          // `t` is ALREADY the stored keyframe time.
          ? () => positionKeyPatchCommands(nodeId, start, drag.ids!, (scratch) => {
            scratch.setKeyframe(nodeId, 'x', t, lp.x);
            scratch.setKeyframe(nodeId, 'y', t, lp.y);
          })
          // Pull a spatial tangent handle — bends the path. Mirrored when the
          // point is still continuous (AE smooth).
          : () => positionKeyPatchCommands(nodeId, start, drag.ids!, (scratch) => {
            // B3-legacy: not a write — the tangent arithmetic runs on the scratch engine passed
            // in; the document edit is the `updateKeyframes` built from it (rule false positive).
            setPathTangent(nodeId, t, part, lp, mirror, scratch);
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
      // Closes the plugin gesture's single undo bracket — see
      // `beginPluginGesture`. Before every early return below, because a claim
      // left open suppresses history for the rest of the session.
      if (pluginPointerUp(controller, local(e), modifiersOf(e), timeRef.current)) {
        useUIStore.getState().setDragging(false);
        controller.requestRender();
        return;
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
        const node = defaultSceneGraph.getNode(pd.nodeId);
        if (node) {
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
            // B3-legacy: engine gap — paint strokes are not an API group (`addPropertyGroup` /
            // `removePropertyGroups` do not take `paint`), the eraser / continue-stroke / replace-
            // selected-path modes rewrite the stroke list, and a stroke's Path has no readable
            // static value to key (`paint/<id>/path` is a data track).
            const result = commitPaintDrag({
              nodeId: pd.nodeId,
              mode: pd.mode,
              points,
              times,
              pen,
              size: pd.space.brushSize(pd.comp[keptIdx[0] ?? 0]!, drawToolOptions.brushSize),
              compTime: pd.compTime,
              continueStroke: pd.shift,
              lastStrokeOnly: pd.lastStrokeOnly,
            });
            if (!result.ok && result.reason) {
              useUIStore.getState().notify({ level: 'info', message: result.reason, durationMs: 2600 });
            }
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
        const node = defaultSceneGraph.getNode(sel[0]!);
        if (node) {
          const textComp = node.components.find((c) => c.type === 'Text');
          if (textComp) {
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
            if (hit && (hit.id === node.id || isDescendantOf(hit.id, node.id)) && openLayerOnDoubleClick(node.id, { alt: e.altKey })) {
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
        if (findNavTarget()) {
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
    // A plugin changing what it wants drawn has to repaint the chrome. It has
    // no frame of its own to wait for: the viewport is otherwise idle between
    // the user's gestures, which is exactly when a plugin answers one.
    const pluginDrawSub = onPluginDrawChanged(() => { controller.requestRender(); });

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
      pluginDrawSub();
      cancelSmoothDolly();
      controller.ws.cancelTransientInput();
      // Unmounting mid-drag must not leak an open gesture transaction — the
      // plugin bracket included, which suppresses history while it is open.
      cancelPluginGesture();
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
    const n = defaultSceneGraph.getNode(ids[0]!);
    return !!n && is3DEnabled(n);
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
      const label = getNodeLabelColor(box.id);

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
    const handleAccent = (only ? getNodeLabelColor(only.id) : undefined) ?? ACCENT;
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
 * A motion-path point → COMPOSITION space.
 *
 * The samples come from the layer's own `x`/`y` tracks, and those are values in
 * its PARENT's space — not comp coordinates, which is what this module drew
 * them as. Parent a layer to a Null and its trajectory, its keyframe dots and
 * their grab targets all appeared at the raw local numbers: for a circle at
 * comp (960, 540) under a null at (300, 700) the path was drawn up at
 * (660, −160), nowhere near the artwork it belongs to, and dragging a dot wrote
 * the pointer's COMP position straight into a parent-space keyframe, teleporting
 * that keyframe by the parent's whole transform.
 *
 * Identity for an unparented layer, so the common case is unchanged.
 */
function pathToComp(nodeId: string, time: number, p: { x: number; y: number }): { x: number; y: number } {
  return Matrix.transformPoint(parentWorld2DAt(nodeId, time), p);
}

/**
 * COMPOSITION space → the layer's position-track space, for writing a dragged
 * point back. The 2D inverse of `pathToComp`.
 */
function compToPath(nodeId: string, time: number, p: { x: number; y: number }): { x: number; y: number } {
  return Matrix.transformPoint(Matrix.invert(parentWorld2DAt(nodeId, time)), p);
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
  // B3-legacy: display read — the drawn window is on the keyframe axis the path is sampled on
  // (B4's mirror replaces it); nothing is written.
  return motionPathTimeWindow(g.motionPathShow, g.motionPathWindowSeconds, compToKeyframeTime(nodeId, compTime, 'x'));
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
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasPositionAnimation(nodeId)) return null;
  const R = 8; // grab radius, screen px
  // Must use the SAME projection the painter does, or a 3D layer's dots are
  // drawn in one place and grabbable in another.
  const comp = compSize();
  const is3D = is3DEnabled(node);
  const project = is3D ? currentViewProjector(comp.w, comp.h, playheadTime()) : null;
  const baseZ = is3D ? readNode3D(node).z : 0;
  const time = playheadTime();
  // Only what is DRAWN is grabbable — the display window hides the rest.
  const win = motionPathWindowFor(nodeId, time);
  if (!win) return null;
  const near = (p: { x: number; y: number }, t?: number): boolean => {
    // Through the parent chain FIRST, exactly as the painter does — the dots
    // have to be grabbable where they are drawn.
    let world = pathToComp(nodeId, time, p);
    if (project) {
      const z = (t !== undefined ? defaultAnimation.sample(nodeId, 'z', t) : undefined) ?? baseZ;
      const q = project({ x: world.x, y: world.y, z });
      world = { x: q.x, y: q.y };
    }
    const s = controller.ws.worldToScreen(world);
    return Math.hypot(s.x - screen.x, s.y - screen.y) <= R;
  };
  const tangents = motionPathTangents(node).filter((k) => inMotionPathWindow(k.t, win));
  for (const k of tangents) {
    if (k.out && near(k.out, k.t)) return { nodeId, t: k.t, part: 'out' };
    if (k.in && near(k.in, k.t)) return { nodeId, t: k.t, part: 'in' };
  }
  for (const k of tangents) {
    if (near(k, k.t)) return { nodeId, t: k.t, part: 'point' };
  }
  return null;
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
/** The modifier flags of a pointer event, in the shape the plugin protocol carries. */
function modifiersOf(e: PointerEvent): PluginModifiers {
  return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

function paintFaceSelection(canvas: HTMLCanvasElement, controller: WorkspaceController, dpr: number): void {
  const fs = useFaceSelectionStore.getState();
  if (!fs.enabled) return;
  const nodeId = fs.nodeId ?? useSelectionStore.getState().ids[0];
  if (!nodeId) return;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const { w: cw, h: ch } = compSize();
  const faces = facesOfNode(node, playheadTime(), cw, ch);
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
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasPositionAnimation(nodeId)) return;
  // A camera's own path, seen through that camera, is a line across the frame.
  if (isLookedThrough(nodeId)) return;
  const win = motionPathWindowFor(nodeId, time);
  if (!win) return;
  const samples = motionPathSamples(node).filter((s) => inMotionPathWindow(s.t, win));
  if (samples.length < 2) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw ON TOP of the overlay (no clear)

  // For a 3D layer the trajectory must go through the SAME camera the renderer
  // uses. This used to map raw x/y with the 2D transform and drop z entirely, so
  // on any 3D layer the path and its keyframe dots were drawn nowhere near the
  // object they belong to — you could not tell which layer a dot was for.
  //
  // The projector is built at the PLAYHEAD, not per sample: the path shows where
  // the trajectory lies in the view you are looking at now, which is what AE
  // draws. `z` is still sampled per point, so a layer animating in depth curves
  // correctly.
  const comp = compSize();
  const is3D = is3DEnabled(node);
  const project = is3D ? currentViewProjector(comp.w, comp.h, time) : null;
  const baseZ = is3D ? readNode3D(node).z : 0;
  const toS = (p: { x: number; y: number; t?: number }): { x: number; y: number } => {
    const c = pathToComp(nodeId, time, p);
    if (!project) return controller.ws.worldToScreen(c);
    const z = (p.t !== undefined ? defaultAnimation.sample(nodeId, 'z', p.t) : undefined) ?? baseZ;
    const q = project({ x: c.x, y: c.y, z });
    return controller.ws.worldToScreen({ x: q.x, y: q.y });
  };

  // Trajectory curve.
  ctx.beginPath();
  const s0 = toS(samples[0]!);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < samples.length; i++) {
    const s = toS(samples[i]!);
    ctx.lineTo(s.x, s.y);
  }
  ctx.strokeStyle = 'rgba(120,170,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Spatial tangent handles — a thin stem from each keyframe to its in/out
  // control point, with a small square grab dot (AE-style). Drawn under the
  // keyframe dots so the points stay the primary target.
  for (const k of motionPathTangents(node)) {
    if (!inMotionPathWindow(k.t, win)) continue;
    const p = toS(k);
    for (const [part, h] of [['out', k.out], ['in', k.in]] as const) {
      if (!h) continue;
      const s = toS({ ...h, t: k.t });
      const hovered = mpHover !== null && mpHover.nodeId === nodeId
        && Math.abs(mpHover.t - k.t) < 1e-9 && mpHover.part === part;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(s.x, s.y);
      ctx.strokeStyle = hovered ? 'rgba(160,200,255,0.9)' : 'rgba(120,170,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = hovered ? '#fff' : 'rgba(120,170,255,1)';
      const r = hovered ? 3.5 : 2.5;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
      if (hovered) {
        ctx.strokeStyle = 'rgba(120,170,255,1)';
        ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
      }
    }
  }

  // Per-frame velocity tick dots (AE-style speed spacing) and keyframe markers.
  if (guides.motionPathDots !== 'off') {
    const fps = useCompositionStore.getState().fps || 30;
    const frameDotRadius =
      guides.motionPathDots === 'small' ? 1.25
      : guides.motionPathDots === 'large' ? 2.25
      : 1.75; // 'medium'

    const kfRadius =
      guides.motionPathDots === 'small' ? 3.5
      : guides.motionPathDots === 'large' ? 5.5
      : 4.5; // 'medium'

    // 1. Draw per-frame velocity tick dots along the trajectory
    const frameSamples = motionPathFrameSamples(node, fps);
    ctx.fillStyle = 'rgba(160, 205, 255, 0.9)';
    for (const f of frameSamples) {
      if (!inMotionPathWindow(f.t, win)) continue;
      const s = toS(f);
      ctx.beginPath();
      ctx.arc(s.x, s.y, frameDotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Draw keyframe markers (distinct larger dots with white center & blue border)
    for (const k of motionPathKeyframes(node)) {
      if (!inMotionPathWindow(k.t, win)) continue;
      const s = toS(k);
      const hovered = mpHover !== null && mpHover.nodeId === nodeId
        && Math.abs(mpHover.t - k.t) < 1e-9 && mpHover.part === 'point';
      if (hovered) {
        // Halo behind the dot — "grabbable", said before the press.
        ctx.beginPath();
        ctx.arc(s.x, s.y, kfRadius + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120,170,255,0.25)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, hovered ? kfRadius + 1 : kfRadius, 0, Math.PI * 2);
      ctx.fillStyle = hovered ? 'rgba(120,170,255,1)' : '#fff';
      ctx.fill();
      ctx.strokeStyle = hovered ? '#fff' : 'rgba(100, 160, 255, 1)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Current-position marker at the playhead.
  const cur = toS({ ...positionSamplerFor(node)(time), t: time });
  ctx.beginPath();
  ctx.arc(cur.x, cur.y, 5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,214,90,1)';
  ctx.lineWidth = 2;
  ctx.stroke();
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
    const comp = useCompositionStore.getState();
    if (!comp || comp.width <= 0 || comp.height <= 0) return;
    const p0 = controller.ws.worldToScreen({ x: 0, y: 0 });
    const p1 = controller.ws.worldToScreen({ x: comp.width, y: comp.height });
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

