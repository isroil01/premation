/**
 * useViewportRenderer — the React⇄Renderer seam (TAD §6.4.3), content-only.
 *
 * React owns only a canvas element + a `RenderBackend` handle; it never touches
 * rendering internals. On scene/animation/time change it builds an immutable
 * snapshot and hands it to the backend, which fit-contains the composition.
 *
 * The main editor viewport uses {@link useWorkspace} instead (camera-driven +
 * interaction overlay). This lighter hook remains for read-only surfaces like
 * Presentation Mode, where there is no camera or interaction.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend, RenderView } from '@core/rendering/RenderBackend';
import { buildSnapshot, type SnapshotFocus } from '@core/rendering/buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { resolveViewCameraInput } from '@core/workspace/cameraNav';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useProjectStore } from '@stores/projectStore';
import { compSizeOf } from '@core/composition/compSizes';



export interface ViewportRendererState {
  /** Why this surface is blank, or null when the renderer is healthy. */
  initError: string | null;
}

export function useViewportRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  sceneRev: number,
  time: number,
  /** Focus Mode ghosting predicate (undefined = nothing ghosted). */
  focus?: SnapshotFocus,
  /** Signal that changes whenever `focus` changes, to force a re-render. */
  focusKey?: string,
  /**
   * Render through THIS view instead of the store's camera3dMode — the 2-up
   * secondary pane shows a different view of the same scene. Undefined =
   * follow the store (Presentation Mode, unchanged behavior).
   */
  viewOverride?: Camera3dMode,
  /**
   * Comp → canvas transform to render at. Omitted (the default) keeps the
   * renderer's centred "contain" fit, which is what a pane with no framing of
   * its own wants.
   *
   * A GETTER, not a value: it is read inside the render closure, so a pane that
   * pans or zooms between frames does not have to rebuild this hook — and can
   * never render one frame behind its own camera.
   */
  getRenderView?: () => RenderView | undefined,
): ViewportRendererState {
  const backendRef = useRef<RenderBackend | null>(null);
  /**
   * Why this surface is not painting, when it is not painting.
   *
   * A failed GPU init used to be a `console.warn` and nothing else, so the host
   * showed a permanently black stage with no explanation — indistinguishable
   * from "the composition is empty". These panes are the LAST GPU contexts a
   * page creates, so they are the first to fail when the browser's live-context
   * cap is reached, which makes this the likeliest thing to go wrong here.
   */
  const [initError, setInitError] = useState<string | null>(null);
  const getRenderViewRef = useRef(getRenderView);
  getRenderViewRef.current = getRenderView;
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
  const camera3dMode = useGuidesStore((s) => viewOverride ?? s.camera3dMode);
  // Custom-view params re-render this surface while a custom view is orbited.
  const customViews = useGuidesStore((s) => s.customViews);
  const gridOverlays = {
    rulers, grid, gridSpacing, gridSubdivisions, gridStyle, gridColor,
    proportionalGrid, proportionalColumns, proportionalRows, safeArea,
  };
  const overlaysRef = useRef(gridOverlays);
  overlaysRef.current = gridOverlays;
  // Threaded via ref (like the overlays) so the stable render callback always
  // sees the CURRENT view mode — a raw closure froze it at mount, deadening
  // the Active/Front (3D/2D) toggle.
  const camera3dModeRef = useRef(camera3dMode);
  camera3dModeRef.current = camera3dMode;
  const channel = useGuidesStore((s) => s.channel);
  const channelRef = useRef(channel);
  channelRef.current = channel;

  const compKey = useCompositionStore((s) => s.key());
  const compRef = useRef(useCompositionStore.getState().comp());
  compRef.current = useCompositionStore.getState().comp();

  // Preview resolution: the content canvas renders at dpr/N (fewer pixels,
  // browser-upscaled) so heavy comps preview faster. Threaded via ref so the
  // stable render callback / resize path always read the current value.
  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const resolutionRef = useRef(previewResolution);
  resolutionRef.current = previewResolution;



  const mbEnabled = useMotionBlurStore((s) => s.enabled);
  const mbShutter = useMotionBlurStore((s) => s.shutterAngle);
  const mbPhase = useMotionBlurStore((s) => s.shutterPhase);
  const mbSamples = useMotionBlurStore((s) => s.samples);
  const mbLimit = useMotionBlurStore((s) => s.adaptiveSampleLimit);
  const activeFps = compRef.current.fps || 60;
  const motionBlurRef = useRef({ enabled: mbEnabled, shutterAngle: mbShutter, shutterPhase: mbPhase, samples: mbSamples, adaptiveSampleLimit: mbLimit, fps: activeFps });
  motionBlurRef.current = { enabled: mbEnabled, shutterAngle: mbShutter, shutterPhase: mbPhase, samples: mbSamples, adaptiveSampleLimit: mbLimit, fps: activeFps };

  const rafIdRef = useRef<number | null>(null);

  // Threaded via ref so the stable render callbacks read the live value without
  // being re-created (and without re-running the mount effect) on play/pause.
  // Scalar selector — `playing` lives on the active TAB, and selecting the tab
  // object would re-render this hook on every setTime (60×/s).
  const playing = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.playing ?? false : false));
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // Draft 3D was passed by the main viewport but never by the panes, so with the
  // speed lever ON the three reference cells still rendered full lighting,
  // shadows and depth of field — slower than the main view, and visibly different
  // from it.
  const draft3d = useGuidesStore((s) => s.draft3d);
  const draft3dRef = useRef(draft3d);
  draft3dRef.current = draft3d;

  // Proxies are a VIEWPORT concession. This is one of only two places that opt
  // in; export and the offline renderer never do. See `@core/assets/proxy`.
  const useProxies = usePreferenceStore((s) => s.useProxies);
  const useProxiesRef = useRef(useProxies);
  useProxiesRef.current = useProxies;

  // Wrap in try/finally so a buildSnapshot/renderFrame exception never
  // permanently wedges rafIdRef.current at a non-null handle — if it got
  // stuck, the RAF deduplication guard would silently halt all future renders.
  const renderImmediate = useCallback(() => {
    const b = backendRef.current;
    if (!b) {
      // Clearing the guard here is load-bearing, not tidiness. `render()` refuses
      // to schedule while `rafIdRef.current` is non-null, so returning without
      // clearing it wedges this surface's render loop PERMANENTLY.
      //
      // Presentation Mode hits this every time: while it is closed its hook is
      // mounted with no canvas and no backend, the re-render effect still calls
      // render(), and that one no-backend pass left the guard armed forever. When
      // the user finally opened the preview the backend attached and sized the
      // canvas correctly — and then every render request was dropped, so the
      // stage stayed blank. The try/finally below already protected the
      // throw path; this is the same wedge one line earlier.
      rafIdRef.current = null;
      return;
    }
    try {
      b.renderFrame({
        ...buildSnapshot(
          defaultSceneGraph, defaultAnimation, timeRef.current, focusRef.current,
          overlaysRef.current, getRenderViewRef.current?.(), motionBlurRef.current,
          // rootId scopes the render to THIS composition's subtree. Custom views
          // resolve to a pre-built override camera (scene camera ignored).
          {
            ...compRef.current,
            rootId: compRef.current.id,
            compSizeOf,
            draft3d: draft3dRef.current,
            useProxies: useProxiesRef.current,
            ...resolveViewCameraInput(compRef.current.width, compRef.current.height, camera3dModeRef.current),
          },
        ),
        // View-only: the channel never reaches export, which always writes colour.
        channel: channelRef.current,
      });
    } catch (err) {

      console.error('[useViewportRenderer] renderImmediate failed:', err);
    } finally {
      // Always clear the guard so future render calls can schedule a new RAF.
      rafIdRef.current = null;
    }
  }, []);

  // Coalesce render requests into requestAnimationFrame so complex 2D/3D frames
  // yield execution to the browser event loop between renders. Without RAF
  // coalescing, synchronous rendering at 60 FPS on heavy 3D scenes locks up
  // the main thread and prevents user interactions (clicks, keyboard, Esc) from
  // processing.
  const render = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      // rafIdRef.current is reset inside renderImmediate's finally block,
      // which covers both the success and exception paths.
      renderImmediate();
    });
  }, [renderImmediate]);

  /**
   * Inspection panes render at a fraction of the main viewport's rate while the
   * comp is PLAYING.
   *
   * Every pane owns its own backend, its own rAF loop and its own
   * `buildSnapshot` — nothing is shared, because the camera is baked into the
   * snapshot at build time. So a 2×2 layout cost 4 full scene walks (puppet
   * deform, skinning, IK, particles, content hashing) and 4 GPU frames every
   * single playback frame, at full device resolution, with no throttle anywhere.
   * The main viewport is what you watch during playback; the Top/Front/custom
   * cells are reference views, and 15fps is plenty for them. Scrubbing and
   * editing stay immediate — this only bites during continuous playback.
   */
  const PANE_PLAYBACK_FPS = 15;
  const lastPaneRenderRef = useRef(0);
  const renderThrottled = useCallback(() => {
    if (!playingRef.current) { render(); return; }
    const now = performance.now();
    if (now - lastPaneRenderRef.current < 1000 / PANE_PLAYBACK_FPS) return;
    lastPaneRenderRef.current = now;
    render();
  }, [render]);

  // Attach the backend + observe size.
  //
  // NOTE: The dep array is intentionally [] (not [canvasRef.current,...]).
  // Ref `.current` values are NOT reactive, so listing them as deps does nothing.
  // The effect instead depends on `canvasEl` — the ref's value promoted to state
  // below — and stays idempotent via the `attachedRef.current === canvas` guard.
  //
  // It used to depend on `[]` plus an assumption that every host re-mounts when it
  // opens. Presentation Mode does not (it returns null and stays mounted), so its
  // canvas arrived after the only run of this effect and was never attached.
  const attachedRef = useRef<HTMLCanvasElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  /**
   * The canvas element, as REACTIVE state.
   *
   * Refs are not reactive, and a host may render its canvas on a later pass than
   * the one this hook first ran on. Presentation Mode is the case that broke:
   * `if (!active) return null` sits after its hooks, so on mount `canvasRef.current`
   * is null, the attach effect below took its early return, and — with `[]` deps —
   * never ran again once the portal finally rendered a canvas. The result was a
   * never-attached, never-resized canvas sitting at its default 300×150 with no
   * backend behind it: a small dark rectangle in the middle of the stage that
   * never painted, while playback happily advanced the timecode.
   *
   * Comparing the ref each render (cheap) and storing the element gives the attach
   * effect something it can legitimately depend on. The effect is idempotent — it
   * early-outs when the same canvas is already attached — so re-running is free.
   */
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (canvasRef.current !== canvasEl) setCanvasEl(canvasRef.current);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      // The canvas left the DOM (portal closed) — release the old backend.
      if (teardownRef.current && attachedRef.current && !attachedRef.current.isConnected) {
        teardownRef.current();
      }
      return;
    }
    // Rebuild when the canvas swapped OR the renderer choice changed — a GPU
    // backend can't re-bind a canvas that already handed out a 2D context, so
    // a choice change must attach a fresh backend (and, via the canvas key in
    // the host, a fresh element).
    if (attachedRef.current === canvas && backendRef.current) return;
    teardownRef.current?.(); // canvas swapped — release the previous backend
    attachedRef.current = canvas;

    // 'auxiliary', not the default 'viewport': this hook drives the 2-up/4-up
    // secondary panes, Presentation Mode and the popout window. Those are the 5th
    // through 17th GPU contexts on the page — exactly the ones that fail when the
    // browser's live-context cap is reached — and registering them as 'viewport'
    // meant one failing pane flipped the global "GPU unavailable" badge while the
    // real viewport was fine.
    const backend = createRenderBackend('auto', 'auxiliary');
    backend.attach(canvas);
    backend.setPreviewChrome?.(true);
    backendRef.current = backend;

    const doResize = (): void => {
      const r = container.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      // Re-read dpr each time. Capturing it once in this mount-scoped effect left
      // a pane rendering at the old scale forever after the window moved to a
      // monitor with different DPI (blurry, or needlessly oversampled).
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      backend.resize(r.width, r.height, dpr / resolutionRef.current);
      // Go through the rAF coalescer, not renderImmediate: three panes each with
      // their own ResizeObserver otherwise ran three synchronous full
      // buildSnapshot + renderFrame passes per notification while dragging a
      // splitter or the window edge.
      render();
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    doResize();

    // The GPU backend initializes asynchronously; its first renderFrame before
    // that coalesces to a pending frame. Re-render once it's ready so the
    // preview isn't left blank when the comp is small or the container settled
    // before the device came up.
    let cancelled = false;
    backend.readyPromise?.then(() => {
      if (cancelled || backendRef.current !== backend) return;
      // readyPromise resolving is NOT success — it also settles when every tier
      // failed. Without this check a dead backend silently painted nothing, which
      // is the same bug useWorkspace already guards against.
      if (backend.initFailed) {

        console.warn('[useViewportRenderer] GPU init failed for this pane:', backend.initErrorMessage);
        setInitError(
          backend.initErrorMessage ??
            'This preview could not get a GPU context. Closing other previews, windows or GPU-heavy tabs usually frees one.',
        );
        return;
      }
      setInitError(null);
      doResize();
    });

    // Re-render when animation changes (e.g. keyframe edits) or node props change.
    const subAnim = getEventBus().on('AnimationChanged', () => render());
    const subNode = getEventBus().on('NodeUpdated', () => render());

    teardownRef.current = () => {
      cancelled = true;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      ro.disconnect();
      subAnim.dispose();
      subNode.dispose();
      backend.dispose();
      backendRef.current = null;
      attachedRef.current = null;
      teardownRef.current = null;
    };
  // Re-runs when the host swaps (or first supplies) its canvas — see `canvasEl`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasEl]);

  // Final unmount teardown.
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      teardownRef.current?.();
    };
  }, []);

  // Re-render on scene change, playhead move, focus change, guide toggle, or
  // camera view-mode flip (camera3dMode was previously missing — the 3D/2D
  // toggle never repainted this surface).
  useEffect(() => {
    renderThrottled();
  }, [sceneRev, time, focusKey, rulers, grid, gridSpacing, gridSubdivisions, gridStyle, proportionalGrid, proportionalColumns, proportionalRows, gridColor, safeArea, camera3dMode, customViews, draft3d, mbEnabled, mbShutter, mbSamples, compKey, renderThrottled]);

  // Preview-quality change: re-size the content buffer (dpr/N) and repaint.
  useEffect(() => {
    const backend = backendRef.current;
    const container = containerRef.current;
    if (!backend || !container) return;
    const r = container.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    backend.resize(r.width, r.height, dpr / previewResolution);
    render();
  }, [previewResolution, containerRef, render]);

  return { initError };
}
