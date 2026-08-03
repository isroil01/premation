import { mergeSelectedPaths, liveMergeSelectedPaths } from '@core/scene/mergePaths';
import { getRemappedTime } from '@core/timeline/TimelineController';
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
import { useWorkspaceStore } from '@stores/projectStore';
import workspaceStyles from './Workspace.module.css';
import { useProjectStore } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore } from '@stores/guidesStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { roiHandleAt, resizeRoi, clampRoi, roiHandleCursor, type RoiHandle } from '@core/rendering/roiGeometry';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore, type Tool } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { is3DEnabled, set3DEnabled, canBe3D, readNode3D } from '@core/scene/threeD';
import { currentViewProjector } from '@core/workspace/viewProjection';


import { getWorkspaceController, type WorkspaceController } from '@core/workspace/WorkspaceController';
import {
  hasPositionAnimation,
  motionPathSamples,
  motionPathKeyframes,
  motionPathTangents,
  setPathTangent,
  positionSamplerFor,
} from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useTextEditStore } from '@stores/textEditStore';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { svgContextMenuItems } from '@layout/Inspector/svgLayerActions';
import { bumpScene } from '@stores/sceneStore';
import { readNodeKind } from '@core/scene/sceneDerive';
import { addPaintStroke } from '@core/paint/paintStrokes';
import { compToLayerLocal, isPaintableKind, localBrushSize } from '@core/paint/paintCoords';
import { usePaintStore } from '@stores/paintStore';
import { useInfoStore } from '@stores/infoStore';
import { samplePixelRgba } from '@core/workspace/pixelSample';
import {
  cancelSmoothDolly,
  dollyNavBy,
  describeNavUnavailable,
  findNavTarget,
  orbitNavBy,
  resolveViewCameraInput,
  smoothDollyNavBy,
  trackNavBy,
  type CameraNavMode,
  type NavTarget,
} from '@core/workspace/cameraNav';
import {
  duplicateSelectedLayers,
  deleteSelectedLayers,
  toggleSelectedLocked,
  toggleSelectedSolo,
  groupSelectedLayers,
  ungroupSelected,
  precomposeSelected,
} from '@core/scene/sceneInsert';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { moveNodeInStack } from '@core/scene/parenting';
import { LABEL_COLORS, readNodeLabelColor, setNodeLabelColor } from '@core/scene/labelColor';
import { useFaceSelectionStore } from '@stores/faceSelectionStore';
import { facesOfNode, pickFace } from '@core/scene/facePicking';
import { compSizeOf } from '@core/composition/compSizes';
import { customPrompt } from '@components/Modal/Dialogs';


// ── Ruler guides (drag-out) ──────────────────────────────────────────
/** Ruler strip thickness in DEVICE px — must match Canvas2DBackend.drawOverlays. */
const RULER_DEVICE_PX = 16;
/** Screen-px tolerance for grabbing an existing guide line. */
const GUIDE_GRAB_PX = 4;
/** Guide line color (cyan — distinct from the magenta snap lines). */
const GUIDE_COLOR = 'rgba(45, 212, 235, 0.9)';

/** An in-flight ruler-guide drag. `guideId` is null while dragging out a new guide. */
interface GuideDrag {
  /** 'x' = vertical guide (from the left ruler), 'y' = horizontal (top ruler). */
  axis: GuideAxis;
  guideId: string | null;
  screen: { x: number; y: number };
  /** True while the pointer is back over the source ruler (release = cancel/delete). */
  overRuler: boolean;
}

interface StripRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const inStrip = (r: StripRect, p: { x: number; y: number }): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * The ruler strips in overlay (CSS px) space. The backend paints them just
 * outside the composition frame, RULER_DEVICE_PX device-px thick.
 */
function rulerStrips(controller: WorkspaceController, dpr: number): { top: StripRect; left: StripRect } {
  const comp = useCompositionStore.getState();
  const o = controller.ws.worldToScreen({ x: 0, y: 0 });
  const e = controller.ws.worldToScreen({ x: comp.width, y: comp.height });
  const t = RULER_DEVICE_PX / dpr;
  return {
    top: { x: o.x, y: o.y - t, width: e.x - o.x, height: t },
    left: { x: o.x - t, y: o.y, width: t, height: e.y - o.y },
  };
}

/** Topmost unlocked guide whose line passes within GUIDE_GRAB_PX of `p` (screen px). */
function hitGuideAt(controller: WorkspaceController, p: { x: number; y: number }): Guide | null {
  for (const g of controller.ws.guides.list()) {
    if (g.locked) continue;
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
  stageRef: React.RefObject<HTMLElement | null>;
  sceneRev: number;
  time: number;
  focus?: SnapshotFocus;
  focusKey?: string;
}

export function useWorkspace(args: UseWorkspaceArgs): { ready: boolean; renderError: string | null } {
  const { contentCanvasRef, overlayCanvasRef, cacheCanvasRef, stageRef, sceneRev, time, focus, focusKey } = args;

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
  const mpDragRef = useRef<{ nodeId: string; t: number; part: 'point' | 'in' | 'out' } | null>(null);
  // Active Brush-tool paint pass: comp[] commits to the layer on release,
  // screen[] previews the wet stroke on the overlay while dragging.
  const paintDragRef = useRef<{ nodeId: string; comp: Array<{ x: number; y: number }>; screen: Array<{ x: number; y: number }> } | null>(null);
  const creationDragRef = useRef<{ start: { x: number; y: number }; current: { x: number; y: number }; tool: Tool } | null>(null);
  // Active ruler-guide drag (drag-out / move / delete), or null.
  const guideDragRef = useRef<GuideDrag | null>(null);
  /** Active Region-of-Interest grip drag (comp space). */
  const roiDragRef = useRef<{ handle: RoiHandle; pointerId: number } | null>(null);
  // True while we override the engine cursor with a guide resize cursor.
  const guideCursorRef = useRef(false);
  const timeRef = useRef(time);
  timeRef.current = time;
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
      if (attachTick >= 30) return;
      const retry = requestAnimationFrame(() => setAttachTick((t) => t + 1));
      return () => cancelAnimationFrame(retry);
    }

    const backend = createRenderBackend();
    backend.attach(content);
    backend.setPreviewChrome?.(true);
    backendRef.current = backend;

    // AnimationChanged revision — part of the cache key so a keyframe edit
    // during a playing loop invalidates every cached frame.
    let animRev = 0;
    const cacheVisibleClass = workspaceStyles.cacheCanvasVisible ?? 'cacheCanvasVisible';

    const paintChrome = (): void => {
      paintOverlay(overlay, controller.ws.overlay(), dprRef.current, guideDragRef.current, controller, paintDragRef.current?.screen ?? null, timeRef.current, creationDragRef.current);
      paintMotionPath(overlay, controller, timeRef.current, dprRef.current);
      paintRoi(overlay, controller, dprRef.current);
      paintFaceSelection(overlay, controller, dprRef.current);
    };

    const render = (): void => {
      const b = backendRef.current;
      if (!b) return;

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
      const fps = compRef.current.fps || 60;
      const frame = Math.round(timeRef.current * fps);
      if (playing) {
        // Everything that changes pixels goes in the key; a change clears all.
        // Built from scalars rather than JSON.stringify — this runs every frame
        // while playing, including on the cache-hit path below.
        const view = controller.getView();
        const ov = overlaysRef.current;
        const mb = motionBlurRef.current;
        const roiK = useGuidesStore.getState().roi;
        viewportFrameCache.setKey(
          [
            sceneRevRef.current, animRev, focusKeyRef.current,
            compRef.current.id, compRef.current.width, compRef.current.height, fps,
            camera3dModeRef.current, draft3dRef.current ? 1 : 0,
            useRenderQualityStore.getState().resolution,
            view.scale, view.offsetX, view.offsetY,
            ov.rulers ? 1 : 0, ov.grid ? 1 : 0, ov.gridSpacing, ov.gridSubdivisions, ov.gridStyle, ov.gridColor, ov.proportionalGrid ? 1 : 0, ov.proportionalColumns, ov.proportionalRows, ov.safeArea ? 1 : 0,
            mb.enabled ? 1 : 0, mb.shutterAngle, mb.shutterPhase, mb.samples, mb.adaptiveSampleLimit,
            roiK ? `${roiK.x},${roiK.y},${roiK.width},${roiK.height}` : '-',
          ].join(':'),
          content.width,
          content.height,
        );
        const hit = viewportFrameCache.get(frame);
        const cacheCanvas = cacheCanvasRef?.current;
        if (hit && cacheCanvas) {
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
            cacheCanvas.classList.add(cacheVisibleClass);
            renderCache.mark(timeRef.current);
            paintChrome();
            return;
          }
        }
      }
      // Anything that renders for real must reveal the live canvas again.
      cacheCanvasRef?.current?.classList.remove(cacheVisibleClass);

      b.renderFrame({
        ...buildSnapshot(
          defaultSceneGraph,
          defaultAnimation,
          timeRef.current,
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
          },
        ),
        // The only producer of `snapshot.roi`. Read live from the store so the
        // region takes effect on the very next frame after the menu toggles it.
        roi: useGuidesStore.getState().roi ?? undefined,
        // Ortho / custom views must not be cropped to the comp rect.
        viewIsActiveCamera: camera3dModeRef.current === 'active',
      });

      // Offer the freshly rendered frame to the RAM preview. Copying FROM a
      // WebGL canvas into a 2D one is allowed (the reverse is not), and it must
      // happen in this same task, before the drawing buffer is composited away.
      if (playing) viewportFrameCache.put(frame, content);

      renderCache.mark(timeRef.current);
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
      // Preview resolution (Full/Half/Third/Quarter) scales only the CONTENT
      // buffer — overlay chrome and interaction math stay at full dpr so
      // handles/rulers remain crisp and hit-testing is unaffected.
      const previewRes = useRenderQualityStore.getState().resolution || 1;
      backend.resize(rect.width, rect.height, dpr / previewRes);
      overlay.width = Math.max(1, Math.round(rect.width * dpr));
      overlay.height = Math.max(1, Math.round(rect.height * dpr));
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
    let lastPreviewRes = useRenderQualityStore.getState().resolution;
    const qualitySub = useRenderQualityStore.subscribe((s) => {
      if (s.resolution !== lastPreviewRes) {
        lastPreviewRes = s.resolution;
        sizeAll();
      }
    });

    // Content also depends on the animation engine (keyframe edits, playback).
    const animSub = getEventBus().on('AnimationChanged', () => {
      animRev++; // invalidates the frame cache key
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
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      window.removeEventListener('resize', sizeAll);
      ro.disconnect();
      qualitySub();
      animSub.dispose();
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

  // ── Channel Filter Effect ──────────────────────────────────────────
  const channel = useGuidesStore((s) => s.channel);
  useEffect(() => {
    const canvas = contentCanvasRef.current;
    if (!canvas) return;
    ensureSvgChannelFilters();
    if (channel === 'red') canvas.style.filter = 'url(#filter-channel-red)';
    else if (channel === 'green') canvas.style.filter = 'url(#filter-channel-green)';
    else if (channel === 'blue') canvas.style.filter = 'url(#filter-channel-blue)';
    else if (channel === 'alpha') canvas.style.filter = 'url(#filter-channel-alpha)';
    else canvas.style.filter = 'none';
  }, [channel, contentCanvasRef]);

  // ── Re-render on scene / playhead / guide changes ──────────────────
  //
  // Throttle snapshots during a property drag. `sceneRev` fires on every
  // property-edit tick (a single slider drag = 30-60 revs/second), and each
  // one rebuilds the whole snapshot — a 3D project with per-character
  // extrusion makes that expensive. Coalesce mid-drag ticks into ONE
  // trailing snapshot after the drag settles (rAF + a 50ms grace). Outside
  // a drag, render eagerly so the next paint reflects the latest edit.
  //
  // `time` is intentionally exempt: it's the playhead (60×/s during
  // playback) and rAF coalescing already gives a single snapshot per
  // frame, which is exactly the cadence we want.
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
  useEffect(() => {
    getWorkspaceController().requestRender();
  }, [time, focusKey, rulers, grid, gridSpacing, gridSubdivisions, gridStyle, gridColor, proportionalGrid, proportionalColumns, proportionalRows, safeArea, camera3dMode, customViews, draft3d, channel, draft, roi, mbEnabled, mbShutter, mbSamples, compKey]);

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
    let camNav: { target: NavTarget; mode: CameraNavMode; last: { x: number; y: number }; pointerId: number } | null = null;
    let altHintCursor = false;

    const cameraToolCursor = (mode: CameraNavMode): string =>
      mode === 'pan' ? 'grab' : mode === 'dolly' ? 'ns-resize' : 'move';

    const startCameraNav = (e: PointerEvent, mode: CameraNavMode): boolean => {
      const target = findNavTarget();
      if (!target) {
        // Say WHY rather than doing nothing. Inertness here is correct — a
        // camera only moves 3D layers — but silent inertness is indistinguishable
        // from a broken tool, and was reported as one.
        const why = describeNavUnavailable();
        if (why) useUIStore.getState().notify({ level: 'info', message: why, durationMs: 6000 });
        return false;
      }
      camNav = { target, mode, last: local(e), pointerId: e.pointerId };
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
        orbitNavBy(nav.target, dx, dy);
      } else if (nav.mode === 'dolly') {
        // Drag up (dy < 0) = dolly IN, matching Alt+wheel-up. Direct (unsmoothed)
        // writes: a drag is already continuous, easing would add lag.
        dollyNavBy(nav.target, dy, compRef.current.width, compRef.current.height);
      } else {
        trackNavBy(nav.target, dx, dy, controller.getView().scale || 1, compRef.current.width, compRef.current.height);
      }
    };

    const endCameraNav = (): void => {
      camNav = null;
      useUIStore.getState().setDragging(false);
      const tool = useGuidesStore.getState().cameraTool;
      overlay.style.cursor = tool !== 'none' ? cameraToolCursor(tool) : controller.ws.cursor.css;
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
    const onAltUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Alt' || !altHintCursor) return;
      altHintCursor = false;
      if (!camNav) overlay.style.cursor = controller.ws.cursor.css;
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
      // Any press in the main viewport takes the active viewer back from a
      // secondary pane, so the focus ring always names the viewport that will
      // receive the next keyboard action.
      if (useGuidesStore.getState().activeViewPane !== null) {
        useGuidesStore.getState().setActiveViewPane(null);
      }
      // Alt+middle-drag = camera Track XY — claim before the left-button guard.
      if (e.button === 1 && e.altKey && startCameraNav(e, 'pan')) return;
      if (e.button !== 0) return; // left-button interactions only
      // C-key camera tool: plain left-drag runs the active orbit/pan/dolly
      // mode (no Alt needed). Claims the press before any canvas interaction.
      {
        const camTool = useGuidesStore.getState().cameraTool;
        if (camTool !== 'none' && startCameraNav(e, camTool)) return;
      }
      // Ruler guides: pointer-down inside a ruler strip drags out a NEW guide
      // (top strip → horizontal 'y' guide, left strip → vertical 'x' guide).
      // Checked before anything is forwarded to the engine.
      if (overlaysRef.current.rulers) {
        const p = local(e);
        const strips = rulerStrips(controller, dprRef.current);
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
      // Brush tool over a selected paintable layer = paint a stroke onto that
      // layer (AE Paint), not draw a freehand shape via the engine. Gated on a
      // single paintable selection so the freehand brush still works with none
      // selected. Points collect in comp space; committed layer-local on release.
      if (controller.ws.getTool() === 'brush') {
        const ids = useSelectionStore.getState().ids;
        if (ids.length === 1) {
          const node = defaultSceneGraph.getNode(ids[0]!);
          if (node && isPaintableKind(node)) {
            const hitNode = controller.ws.hitTestScreen(local(e));
            if (hitNode && hitNode.id === node.id) {
              e.preventDefault();
              const cp = controller.ws.screenToWorld(local(e));
              paintDragRef.current = { nodeId: node.id, comp: [cp], screen: [local(e)] };
              try {
                overlay.setPointerCapture(e.pointerId);
              } catch {
                /* best-effort */
              }
              useUIStore.getState().setDragging(true);
              controller.requestRender();
              return;
            }
            if (!hitNode) {
              useSelectionStore.getState().clear();
            }
          }
        }
      }
      // E4: grabbing a motion-path keyframe dot starts a local drag that edits
      // the keyframe directly (the engine never sees it, so it can't also
      // move/marquee the layer).
      const hit = hitMotionPathKeyframe(controller, local(e));
      if (hit) {
        mpDragRef.current = hit;
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
      const isCreationTool = ['shape', 'ellipse', 'polygon', 'star', 'line', 'mask-rect', 'mask-ellipse'].includes(activeTool);
      if (isCreationTool) {
        const p = local(e);
        creationDragRef.current = { start: p, current: p, tool: activeTool };
      }
      useUIStore.getState().setDragging(true);
      controller.ws.setFocused(true);
      controller.ws.feedPointerDown(toPointer(e));
    };
    const onMove = (e: PointerEvent): void => {
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
            const comp = useCompositionStore.getState();
            useGuidesStore.getState().setRoi(
              clampRoi(resizeRoi(roi, rd.handle, cp), comp.width, comp.height),
            );
          }
          return;
        }
      }
      // Info readout (AE Info panel): comp-space position + sampled pixel under
      // the cursor. Runs for every move regardless of the active tool/drag.
      {
        const p = local(e);
        const world = controller.ws.screenToWorld(p);
        const content = contentCanvasRef.current;
        useInfoStore.getState().set({
          x: Math.round(world.x),
          y: Math.round(world.y),
          rgba: content ? samplePixelRgba(content, p) : null,
          present: true,
        });
      }
      // Active Brush paint: append the sample and repaint the wet-stroke preview.
      if (paintDragRef.current) {
        paintDragRef.current.comp.push(controller.ws.screenToWorld(local(e)));
        paintDragRef.current.screen.push(local(e));
        controller.requestRender();
        return;
      }
      // Active ruler-guide drag: track the pointer, live-move existing guides,
      // and flag when the pointer is back over the source ruler (= cancel/delete).
      const gd = guideDragRef.current;
      if (gd) {
        const p = local(e);
        gd.screen = p;
        const strips = rulerStrips(controller, dprRef.current);
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
        const strips = rulerStrips(controller, dprRef.current);
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
      const drag = mpDragRef.current;
      if (drag) {
        const w = controller.ws.screenToWorld(local(e));
        const part = drag.part;
        // One coalesced undo step for the whole drag (stable merge key).
        if (part === 'point') {
          // Move the point in 2D (both axis tracks get a key at this time;
          // spatial tangents are relative offsets, so they travel with it).
          // `drag.t` is ALREADY the stored keyframe time — converting it again
          // (the old toLayerTime call) shifted the write off the keyframe being
          // dragged on any clip that doesn't start at 0. The tangent branch
          // below always passed it raw; now both do.
          runAnimEdit(
            'Move keyframe',
            () => {
              defaultAnimation.setKeyframe(drag.nodeId, 'x', drag.t, w.x);
              defaultAnimation.setKeyframe(drag.nodeId, 'y', drag.t, w.y);
            },
            `mpdrag:${drag.nodeId}:${drag.t}`,
          );
        } else {
          // Pull a spatial tangent handle — bends the path. Mirrored (smooth
          // point) by default; hold Alt to break the pair.
          runAnimEdit(
            'Adjust path tangent',
            () => setPathTangent(drag.nodeId, drag.t, part, w, !e.altKey),
            `mptan:${drag.nodeId}:${drag.t}:${part}`,
          );
        }
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
      try {
        if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (roiDragRef.current && roiDragRef.current.pointerId === e.pointerId) {
        roiDragRef.current = null;
        useUIStore.getState().setDragging(false);
        overlay.style.cursor = 'default';
        controller.requestRender();
        return;
      }
      // Finish a viewport-camera navigation drag (props already written live).
      if (camNav && camNav.pointerId === e.pointerId) {
        endCameraNav();
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
          const s = usePaintStore.getState();
          const points = pd.comp.map((cp) => compToLayerLocal(node, cp));
          addPaintStroke(pd.nodeId, {
            points,
            // Size + colour are shared with the freehand brush (Tool Options bar).
            // Size is a comp-pixel diameter → convert to the layer's local units
            // so a scaled-up layer doesn't turn one stroke into a giant blob.
            color: drawToolOptions.brushColor,
            size: localBrushSize(node, drawToolOptions.brushSize),
            opacity: s.opacity,
            hardness: s.hardness,
            mode: s.mode,
          });
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
        const strips = rulerStrips(controller, dprRef.current);
        const overRuler = inStrip(gd.axis === 'y' ? strips.top : strips.left, p);
        const w = controller.ws.screenToWorld(p);
        const pos = gd.axis === 'x' ? w.x : w.y;
        if (gd.guideId) {
          if (overRuler) controller.ws.removeGuide(gd.guideId);
          else controller.ws.guides.move(gd.guideId, pos);
        } else if (!overRuler) {
          controller.ws.addGuide(gd.axis, pos);
        }
        overlay.style.cursor = controller.ws.cursor.css;
        guideCursorRef.current = false;
        controller.requestRender();
        return;
      }
      if (mpDragRef.current) {
        mpDragRef.current = null;
        useUIStore.getState().setDragging(false);
        return;
      }
      if (creationDragRef.current) {
        creationDragRef.current = null;
        controller.requestRender();
      }
      useUIStore.getState().setDragging(false);
      controller.ws.feedPointerUp(toPointer(e));
    };
    const onDoubleClick = (e: MouseEvent): void => {
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
      if (e.altKey || useGuidesStore.getState().cameraTool === 'dolly') {
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
    const onLeave = (): void => useInfoStore.getState().clear();

    overlay.addEventListener('pointerdown', onDown);
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', onUp);
    overlay.addEventListener('pointerleave', onLeave);
    overlay.addEventListener('dblclick', onDoubleClick);
    overlay.addEventListener('contextmenu', onContextMenu);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onAltDown);
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
      window.removeEventListener('keyup', onAltUp);
      guidesSub();
      toolSub();
      cancelSmoothDolly();
    };
  }, [overlayCanvasRef, stageRef]);

  return { ready, renderError };
}

// ── Canvas context menus ─────────────────────────────────────────────

/**
 * Right-click menu for a canvas node — the same actions as the scene-tree menu
 * (DemoPanels.openNodeMenu), minus Rename: the tree's inline rename is local
 * ScenePanel state and window.prompt is unavailable in Electron.
 */
/** The playhead, in raw comp time. */
function playheadTime(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

/** The active composition's pixel size — the space projections resolve in. */
function compSize(): { w: number; h: number } {
  const s = useProjectStore.getState();
  const comp = s.comps[s.tabs[s.activeTabId ?? '']?.compositionId ?? 'comp_root'];
  return { w: comp?.width ?? 1920, h: comp?.height ?? 1080 };
}

/**
 * The value a property has right now (sampled keyframes → component prop →
 * type default) — what an added keyframe must capture so nothing jumps.
 */
function currentPropValue(id: string, prop: string): number {
  const t = (() => {
    const s = useProjectStore.getState();
    return s.tabs[s.activeTabId ?? '']?.time ?? 0;
  })();
  const layerT = getRemappedTime(id, t);
  const sampled = defaultAnimation.sample(id, prop, layerT);
  if (sampled !== undefined) return sampled;
  const node = defaultSceneGraph.getNode(id);
  if (node) {
    for (const c of node.components) {
      const v = (c.props as Record<string, unknown>)[prop];
      if (typeof v === 'number') return v;
    }
    if (prop === 'x') return node.transform.position.x;
    if (prop === 'y') return node.transform.position.y;
  }
  const DEFAULTS: Record<string, number> = { scaleX: 1, scaleY: 1, opacity: 100 };
  return DEFAULTS[prop] ?? 0;
}

/** Keyframe `props` at the playhead, capturing their current values. */
function addKeyframesAtPlayhead(id: string, label: string, props: readonly string[]): void {
  const s = useProjectStore.getState();
  const t = s.tabs[s.activeTabId ?? '']?.time ?? 0;
  const layerT = getRemappedTime(id, t);
  runAnimEdit(`Add ${label} keyframe`, () => {
    for (const p of props) {
      defaultAnimation.setKeyframe(id, p, layerT, currentPropValue(id, p));
    }
  });
}

function labelColorCanvasMenuItems(targetId: string): ContextMenuItem[] {
  const sel = useSelectionStore.getState().ids;
  const ids: string[] = sel.includes(targetId) ? [...sel] : [targetId];
  const node = defaultSceneGraph.getNode(targetId);
  const current = node ? readNodeLabelColor(node) : undefined;
  return [
    {
      id: 'label-none',
      label: 'None (Default)',
      icon: current === undefined ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(ids, undefined),
    },
    { id: 'label-sep', separator: true },
    ...LABEL_COLORS.map((c): ContextMenuItem => ({
      id: `label-${c.id}`,
      label: c.label,
      icon: current === c.color ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(ids, c.color),
    })),
  ];
}

function nodeContextMenuItems(id: string): ContextMenuItem[] {
  const node = defaultSceneGraph.getNode(id);
  const hidden = node?.visible === false;
  const locked = (node as { locked?: boolean } | undefined)?.locked === true;
  const solo = (node as { solo?: boolean } | undefined)?.solo === true;
  const isGroup = node ? readNodeKind(node) === 'group' : false;
  const toggleVisible = (): void => {
    const n = defaultSceneGraph.getNode(id);
    if (!n) return;
    n.visible = n.visible === false;
    bumpScene();
  };
  const renameNode = (): void => {
    const n = defaultSceneGraph.getNode(id);
    if (!n) return;
    void (async () => {
      const newName = await customPrompt('Rename Layer', 'Give this layer a new name.', n.name, {
        confirmLabel: 'Rename',
      });
      if (!newName?.trim()) return;
      // Re-read: the dialog is async now, so the node could have been deleted
      // while it was open. The old synchronous prompt could not have this gap.
      const live = defaultSceneGraph.getNode(id);
      if (!live) return;
      live.name = newName.trim();
      bumpScene();
    })();
  };
  return [
    { id: 'rename', label: 'Rename…', onSelect: renameNode },
    { id: 'duplicate', label: 'Duplicate', onSelect: () => duplicateSelectedLayers() },
    { id: 'arrange', label: 'Arrange', children: [
      { id: 'arr-front', label: 'Bring to Front', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'front'); } },
      { id: 'arr-forward', label: 'Bring Forward', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'forward'); } },
      { id: 'arr-backward', label: 'Send Backward', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'backward'); } },
      { id: 'arr-back', label: 'Send to Back', onSelect: () => { for (const nid of useSelectionStore.getState().ids) moveNodeInStack(nid, 'back'); } },
    ] },
    { id: 'sep0', separator: true },
    { id: 'kf', label: 'Add Keyframe', children: [
      { id: 'kf-pos', label: 'Position', onSelect: () => addKeyframesAtPlayhead(id, 'Position', ['x', 'y']) },
      { id: 'kf-scale', label: 'Scale', onSelect: () => addKeyframesAtPlayhead(id, 'Scale', ['scaleX', 'scaleY']) },
      { id: 'kf-rot', label: 'Rotation', onSelect: () => addKeyframesAtPlayhead(id, 'Rotation', ['rotation']) },
      { id: 'kf-op', label: 'Opacity', onSelect: () => addKeyframesAtPlayhead(id, 'Opacity', ['opacity']) },
      { id: 'kf-all', label: 'All Transform', onSelect: () => addKeyframesAtPlayhead(id, 'Transform', ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']) },
    ] },
    { id: 'sep1', separator: true },
    { id: 'toggle', label: hidden ? 'Show' : 'Hide', onSelect: toggleVisible },
    { id: 'lock', label: locked ? 'Unlock' : 'Lock', onSelect: () => toggleSelectedLocked() },
    { id: 'solo', label: solo ? 'Unsolo' : 'Solo', onSelect: () => toggleSelectedSolo() },
    {
      id: 'toggle-3d',
      label: node && is3DEnabled(node) ? 'Disable 3D Layer' : 'Enable 3D Layer',
      onSelect: () => {
        const ids = useSelectionStore.getState().ids;
        for (const nid of (ids.includes(id) ? ids : [id])) {
          const n = defaultSceneGraph.getNode(nid);
          if (n && canBe3D(n)) set3DEnabled(nid, !is3DEnabled(n));
        }
        bumpScene();
      },
    },
    { id: 'labelColor', label: 'Label Color', children: labelColorCanvasMenuItems(id) },
    { id: 'sep2', separator: true },
    { id: 'group', label: 'Group Selection', onSelect: () => groupSelectedLayers() },
    ...(isGroup ? [{ id: 'ungroup', label: 'Ungroup', onSelect: () => ungroupSelected() }] : []),
    { id: 'precompose', label: 'Pre-compose…', onSelect: () => precomposeSelected() },
    { id: 'rig-logo', label: 'Rig Logo for Animation', onSelect: () => { void rigLogoForAnimation(); } },
    ...svgContextMenuItems(id),
    ...(useSelectionStore.getState().ids.length >= 2
      ? [
          { id: 'sep_merge', separator: true },
          {
            id: 'merge-paths',
            label: 'Merge Paths',
            children: [
              { id: 'merge-live-union', label: 'Live Union (Add)', onSelect: () => liveMergeSelectedPaths('union') },
              { id: 'merge-live-subtract', label: 'Live Subtract', onSelect: () => liveMergeSelectedPaths('subtract') },
              { id: 'merge-live-intersect', label: 'Live Intersect', onSelect: () => liveMergeSelectedPaths('intersect') },
              { id: 'merge-live-exclude', label: 'Live Exclude (XOR)', onSelect: () => liveMergeSelectedPaths('exclude') },
              { id: 'merge-sep', label: '—', disabled: true },
              { id: 'merge-union', label: 'Bake Union', onSelect: () => mergeSelectedPaths('union') },
              { id: 'merge-subtract', label: 'Bake Subtract', onSelect: () => mergeSelectedPaths('subtract') },
              { id: 'merge-intersect', label: 'Bake Intersect', onSelect: () => mergeSelectedPaths('intersect') },
              { id: 'merge-exclude', label: 'Bake Exclude', onSelect: () => mergeSelectedPaths('exclude') },
            ],
          },
        ]
      : []),
    { id: 'sep3', separator: true },
    { id: 'delete', label: 'Delete', danger: true, onSelect: () => deleteSelectedLayers() },
  ];
}

/** Right-click menu for empty canvas — view/selection basics. */
function canvasContextMenuItems(controller: WorkspaceController): ContextMenuItem[] {
  const guides = useGuidesStore.getState();
  const hasSelection = useSelectionStore.getState().ids.length > 0;
  return [
    { id: 'select-all', label: 'Select All', onSelect: () => controller.ws.selectAll() },
    { id: 'deselect', label: 'Deselect', disabled: !hasSelection, onSelect: () => controller.ws.clearSelection() },
    { id: 'sep1', separator: true },
    { id: 'fit', label: 'Fit Comp in View', onSelect: () => controller.fitComposition() },
    { id: 'sep2', separator: true },
    { id: 'grid', label: guides.grid ? 'Hide Grid' : 'Show Grid', onSelect: () => guides.toggleGrid() },
    { id: 'rulers', label: guides.rulers ? 'Hide Rulers' : 'Show Rulers', onSelect: () => guides.toggleRulers() },
  ];
}

// ── Overlay painter ──────────────────────────────────────────────────
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

  // Wet-stroke preview: the Brush's in-flight samples (screen space), drawn as
  // round-capped ink at brush width so what you drag IS what commits on release.
  if (paintStroke && paintStroke.length > 0) {
    const s = usePaintStore.getState();
    const zoom = controller?.getView().scale ?? 1;
    const w = Math.max(1, drawToolOptions.brushSize * zoom);
    ctx.save();
    ctx.globalAlpha = s.mode === 'erase' ? 0.5 : s.opacity;
    ctx.strokeStyle = s.mode === 'erase' ? '#ffffff' : drawToolOptions.brushColor;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.mode === 'erase') ctx.setLineDash([Math.max(4, w / 2), Math.max(4, w / 2)]);
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

  // Persistent ruler guides (screen-space, from the engine's overlay).
  if (overlay.guides.length) {
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth = 1;
    for (const g of overlay.guides) {
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
  }

  // Live preview while dragging a NEW guide out of a ruler (hidden while the
  // pointer is back over the ruler — releasing there cancels).
  if (guideDrag && !guideDrag.guideId && !guideDrag.overRuler) {
    ctx.strokeStyle = GUIDE_COLOR;
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
    ctx.setLineDash([]);
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
    ctx.strokeStyle = ACCENT;
    // Hairline. A 2px selection stroke is the single loudest tell of an
    // unpolished editor — it reads as chrome competing with the artwork
    // rather than a thin annotation over it.
    ctx.lineWidth = 1;
    if (sel3D) ctx.setLineDash([4, 3]);
    for (const box of overlay.selectionBoxes) strokeCorners(ctx, box);
    if (sel3D) ctx.setLineDash([]);
  }

  // Handles (hidden while actively drawing or painting a stroke, and in 3D).
  if (!isActivelyDrawing && !sel3D) {
    for (const h of overlay.handles) {
      if (h.kind === 'anchor') {
        // The pivot, as a crosshair/target — deliberately unlike every square
        // resize grip, because it does something completely different and may
        // sit outside the box entirely. Previously it fell through to the
        // default branch and drew as a plain square, indistinguishable from a
        // handle that scales the layer.
        drawAnchorWidget(ctx, h.position.x, h.position.y, ACCENT);
      } else if (h.kind === 'rotate') {
        // No rotate handle is produced any more (rotation is a tool mode), but
        // a stale overlay from another tool could still carry one.
        ctx.beginPath();
        ctx.arc(h.position.x, h.position.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (h.kind === 'point') {
        // Vertex anchor: filled square
        ctx.fillStyle = ACCENT;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.fillRect(h.position.x - 4, h.position.y - 4, 8, 8);
        ctx.strokeRect(h.position.x - 4, h.position.y - 4, 8, 8);
      } else if (h.kind === 'tangent-in' || h.kind === 'tangent-out') {
        // Tangent handle: circle
        ctx.beginPath();
        ctx.arc(h.position.x, h.position.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        // 8px filled square with a 1px contrasting outline: squares read as
        // precise where circles read as a design tool, and the fill/outline
        // contrast is what keeps them visible over both light and dark artwork.
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1;
        ctx.fillRect(h.position.x - 4, h.position.y - 4, 8, 8);
        ctx.strokeRect(h.position.x - 4, h.position.y - 4, 8, 8);
      }
    }
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
}

/**
 * Hit-test the selected layer's motion-path keyframe dots and tangent handles
 * at a screen point (within a small radius). Returns the grabbed part — the
 * keyframe 'point' itself or its 'in'/'out' spatial tangent handle — or null.
 * Handles are tested first: they can sit close to the point and are the finer
 * target. Used to start an on-canvas motion-path drag.
 */
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
  const near = (p: { x: number; y: number }, t?: number): boolean => {
    let world = p;
    if (project) {
      const z = (t !== undefined ? defaultAnimation.sample(nodeId, 'z', t) : undefined) ?? baseZ;
      const q = project({ x: p.x, y: p.y, z });
      world = { x: q.x, y: q.y };
    }
    const s = controller.ws.worldToScreen(world);
    return Math.hypot(s.x - screen.x, s.y - screen.y) <= R;
  };
  const tangents = motionPathTangents(node);
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
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const { w: cw, h: ch } = compSize();
  const faces = facesOfNode(node, playheadTime(), cw, ch);
  if (faces.length === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const trace = (quad: ReadonlyArray<{ x: number; y: number }>): void => {
    ctx.beginPath();
    quad.forEach((p, i) => {
      const s = controller.ws.worldToScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  };

  // Far faces first so the near ones outline on top.
  // Edge-on faces are skipped for the same reason the picker skips them: an
  // invisible sliver drawn as a line reads as a stray scratch on the object.
  const sorted = faces.filter((f) => f.area >= 4).sort((a, b) => b.depth - a.depth);
  ctx.lineWidth = 1;
  for (const f of sorted) {
    const active = fs.nodeId === nodeId && f.suffix === fs.suffix;
    trace(f.quad);
    if (active) {
      ctx.fillStyle = 'rgba(120,170,255,0.28)';
      ctx.fill();
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
  const samples = motionPathSamples(node);
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
    if (!project) return controller.ws.worldToScreen({ x: p.x, y: p.y });
    const z = (p.t !== undefined ? defaultAnimation.sample(nodeId, 'z', p.t) : undefined) ?? baseZ;
    const q = project({ x: p.x, y: p.y, z });
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
    const p = toS(k);
    for (const h of [k.out, k.in]) {
      if (!h) continue;
      const s = toS({ ...h, t: k.t });
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(s.x, s.y);
      ctx.strokeStyle = 'rgba(120,170,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(120,170,255,1)';
      ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
    }
  }

  // Keyframe dots, at the size the user chose. `motionPathDots` also had no
  // reader: the radius was hardcoded to 3.5 and 'off' still drew them, so all
  // four menu entries were inert.
  const dotRadius =
    guides.motionPathDots === 'small' ? 2.5
    : guides.motionPathDots === 'large' ? 5.5
    : 3.5; // 'medium'
  if (guides.motionPathDots !== 'off') {
    for (const k of motionPathKeyframes(node)) {
      const s = toS(k);
      ctx.beginPath();
      ctx.arc(s.x, s.y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,170,255,1)';
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

function ensureSvgChannelFilters(): void {
  if (typeof document === 'undefined' || document.getElementById('motion-editor-channel-filters')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'motion-editor-channel-filters';
  svg.style.position = 'absolute';
  svg.style.width = '0';
  svg.style.height = '0';
  svg.style.overflow = 'hidden';
  svg.innerHTML = `
    <defs>
      <filter id="filter-channel-red">
        <feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 1 0" />
      </filter>
      <filter id="filter-channel-green">
        <feColorMatrix type="matrix" values="0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0" />
      </filter>
      <filter id="filter-channel-blue">
        <feColorMatrix type="matrix" values="0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0" />
      </filter>
      <filter id="filter-channel-alpha">
        <feColorMatrix type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 1 0" />
      </filter>
    </defs>
  `;
  document.body.appendChild(svg);
}

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

    ctx.save();
    ctx.lineWidth = 1;

    // Action Safe Box (90%)
    const asX = p0.x + w * 0.05;
    const asY = p0.y + h * 0.05;
    const asW = w * 0.9;
    const asH = h * 0.9;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(asX + 0.5, asY + 0.5, asW, asH);

    // Title Safe Box (80%)
    const tsX = p0.x + w * 0.1;
    const tsY = p0.y + h * 0.1;
    const tsW = w * 0.8;
    const tsH = h * 0.8;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(tsX + 0.5, tsY + 0.5, tsW, tsH);

    // Center crosshair
    const cx = p0.x + w / 2;
    const cy = p0.y + h / 2;
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy + 0.5); ctx.lineTo(cx + 10, cy + 0.5);
    ctx.moveTo(cx + 0.5, cy - 10); ctx.lineTo(cx + 0.5, cy + 10);
    ctx.stroke();

    // Clean labels
    ctx.fillStyle = 'rgba(56, 189, 248, 0.75)';
    ctx.font = '9px system-ui, sans-serif';
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
    const rulerHeight = 22; // Crisp 22px ruler bar

    ctx.save();

    // Top & Left ruler background strip
    ctx.fillStyle = '#12131a';
    ctx.fillRect(0, 0, cssW, rulerHeight);
    ctx.fillRect(0, 0, rulerHeight, cssH);

    // Border lines
    ctx.strokeStyle = '#2e3440';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerHeight + 0.5);
    ctx.lineTo(cssW, rulerHeight + 0.5);
    ctx.moveTo(rulerHeight + 0.5, 0);
    ctx.lineTo(rulerHeight + 0.5, cssH);
    ctx.stroke();

    // Corner (0,0) square
    ctx.fillStyle = '#1a1b26';
    ctx.fillRect(0, 0, rulerHeight, rulerHeight);
    ctx.strokeStyle = '#3b4252';
    ctx.strokeRect(0.5, 0.5, rulerHeight, rulerHeight);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 9px monospace';
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
        ctx.strokeStyle = isZero ? '#38bdf8' : 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = isZero ? 1.5 : 1;
        ctx.stroke();

        ctx.font = isZero ? 'bold 10px monospace' : '10px monospace';
        ctx.fillStyle = isZero ? '#38bdf8' : '#e2e8f0';
        ctx.fillText(String(x), Math.floor(sx), 2);

        const minorStep = stepWorld / 5;
        for (let m = 1; m < 5; m++) {
          const msx = controller.ws.worldToScreen({ x: x + m * minorStep, y: 0 }).x;
          if (Number.isFinite(msx) && msx >= rulerHeight && msx <= cssW) {
            ctx.beginPath();
            ctx.moveTo(Math.floor(msx) + 0.5, rulerHeight - 4);
            ctx.lineTo(Math.floor(msx) + 0.5, rulerHeight);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
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
        ctx.strokeStyle = isZero ? '#38bdf8' : 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = isZero ? 1.5 : 1;
        ctx.stroke();

        ctx.save();
        ctx.translate(2, Math.floor(sy) - 2);
        ctx.font = isZero ? 'bold 9px monospace' : '9px monospace';
        ctx.fillStyle = isZero ? '#38bdf8' : '#e2e8f0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(y), 0, 0);
        ctx.restore();

        const minorStep = stepWorld / 5;
        for (let m = 1; m < 5; m++) {
          const msy = controller.ws.worldToScreen({ x: 0, y: y + m * minorStep }).y;
          if (Number.isFinite(msy) && msy >= rulerHeight && msy <= cssH) {
            ctx.beginPath();
            ctx.moveTo(rulerHeight - 4, Math.floor(msy) + 0.5);
            ctx.lineTo(rulerHeight, Math.floor(msy) + 0.5);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
    }

    ctx.restore();
  } catch (e) {
    console.error('[paintRulers] Error rendering rulers:', e);
  }
}

