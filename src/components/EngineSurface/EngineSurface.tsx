/**
 * EngineSurface — the C++ engine's frames in the app (NATIVE_CORE_PLAN §5 C3 /
 * D5, docs/VIEWPORT_ROUTE.md route C).
 *
 * THE viewport (D5; the engine owns the document, engineOwnership.ts): it
 * fills the stage under the page's overlays and follows the page's camera —
 * `setViewport{zoom = view.scale, pan = the comp point at the stage centre
 * (viewToCamera), CSS size, DPR}` whenever the workspace's render tick sees
 * the camera or the size change. It also:
 *   - tell the engine the size on mount / resize (ResizeObserver) / a DPR change,
 *     and again after an engine restart; `closeViewport` on unmount;
 *   - receive each finished frame as a VideoFrame over the preload's
 *     sharedTexture receiver and draw it with WebGPU `importExternalTexture`
 *     (zero copy), newest frame wins, at most one draw per animation frame;
 *     every frame is released exactly once, after the GPU is done with it, so
 *     the engine's ring slot comes back.
 *   - on route A (meta.route 'copy': Linux, or macOS without the host bridge —
 *     docs/VIEWPORT_ROUTE.md) the VideoFrame wraps copied pixels; the surface
 *     then asks for at most COPY_PIXEL_BUDGET physical pixels (a lower DPR),
 *     because every copied megabyte costs ~2.3 ms between processes.
 *
 * No React render per frame (CLAUDE.md): frames, stats, the camera and the HUD
 * text go through refs and subscriptions; React renders only when the client,
 * a notice or the "no frame yet" state changes.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flicksToSeconds, type ChannelView, type EngineFrameMeta, type EventBatch, type PreviewResolution as EnginePreviewResolution, type ProcessEngineClient, type VideoFrameLike } from '@motion/engine-api';
import {
  createAppProcessEngine,
  lastProcessEngineNotice,
  processEngine,
  processEngineBridge,
  processEngineEnabled,
  subscribeProcessEngine,
} from '@core/engine/process/processEngine';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { useGuidesStore } from '@stores/guidesStore';
import { isCustomViewId, type CustomViewParams } from '@core/workspace/customViews';
import { useRenderQualityStore, type PreviewResolution } from '@stores/renderQualityStore';
import { useViewportDisplayStore, viewportHudStats } from '@stores/viewportDisplayStore';
import { useOnionSkinStore } from '@stores/onionSkinStore';
import { publishFrameGeometry, setEngineDrivenViewport } from '@stores/overlayGeometry';
import { captureLiveFrame, needsLiveFrame, useCompareStore } from '@stores/compareStore';
import { publishFrame } from '@core/engine/frameTap';
import { notePresented } from '@core/engine/presentedFrames';
import { captureViewportPicture, setViewportPictureRefresh, viewportPictureWanted } from '@core/engine/viewportPicture';
import { useActiveMirrorComp } from '@hooks/useMirror';
import { compUvRect, parseCssRgb } from './pasteboard';
import { BOARD_FLOATS, createFrameBlitter } from './frameBlit';
import { subscribeEngineFrames } from './engineFrameHub';
import styles from './EngineSurface.module.css';

/**
 * The engine viewport id this surface owns, relative to its window's base
 * (C: multiple viewports — the editor window's base is 0, so its surface is
 * viewport 1; a pop-out's surface is `base + 1` in the pop-out's own block, so
 * it is a second engine surface with its own ring, not a copy of the editor's).
 */
export const ENGINE_SURFACE_VIEWPORT = 1;

/** This window's surface viewport id (main: 1; a pop-out: its block + 1). */
export async function surfaceViewportId(bridge: { viewportBase?(): Promise<number> } | null): Promise<number> {
  try {
    return ((await bridge?.viewportBase?.()) ?? 0) + ENGINE_SURFACE_VIEWPORT;
  } catch {
    return ENGINE_SURFACE_VIEWPORT;
  }
}

/**
 * Route A's frame size cap, physical pixels: 1280×720 is ~3.7 MB a frame, which
 * C1 measured holding the display rate; 1080p copies fell to ~36–43 fps.
 */
export const COPY_PIXEL_BUDGET = 1280 * 720;

/** The DPR to ask for on route A: the page's, lowered until the viewport fits the budget. */
export function copyRouteDpr(cssWidth: number, cssHeight: number, dpr: number): number {
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  const fit = Math.sqrt(COPY_PIXEL_BUDGET / area);
  return Math.max(0.25, Math.min(dpr, fit));
}

export type EngineSurfaceMode = 'viewport';

/** What the real-app harness reads: `window.__premationEngineSurface`. */
export interface EngineSurfaceStats {
  mode: EngineSurfaceMode;
  /** How frames arrive: shared textures (route C) or pixel copies (route A); null before the first. */
  route: 'shared' | 'copy' | null;
  received: number;
  drawn: number;
  superseded: number;
  fps: number;
  lastRevision: number;
  lastFrame: number;
  /** Engine render done → drawn in this page, ms (measurement only). */
  lastLatencyMs: number;
  /** The engine's render of the last drawn frame (render thread, GPU complete), ms. */
  lastRenderMs: number;
  /** The engine's frame build (document → FrameScene), moving average, ms (renderStatsUpdated). */
  engineBuildMs: number;
  /** performance.now() when the last frame was drawn (edit → frame latency, harness). */
  lastDrawnAt: number;
  viewportsSent: number;
  lastViewport: {
    width: number; height: number; dpr: number; zoom: number; panX: number; panY: number;
    /** setViewport `view`: the 3D view this surface renders ('active', an axis view, `camera:<id>`, 'custom'). */
    view: string;
    /** The custom view's orbit when `view` is 'custom' (customViews.ts), else null. */
    customView: CustomViewParams | null;
    /** setViewport `onion`, or null when onion skins are off. */
    onion: { before: number; after: number; step: number; opacity: number; colorize: boolean } | null;
  } | null;
  errors: string[];
}

type Pending = { frame: VideoFrame; meta: EngineFrameMeta; release: () => void };

const CHANNEL: Record<string, ChannelView> = { rgb: 'rgb', red: 'red', green: 'green', blue: 'blue', alpha: 'alpha' };
const RESOLUTION: Record<PreviewResolution, EnginePreviewResolution> = { 1: 'full', 2: 'half', 3: 'third', 4: 'quarter' };

export function EngineSurface({ mode = 'viewport' }: { mode?: EngineSurfaceMode }): JSX.Element | null {
  const client = useSyncExternalStore(subscribeProcessEngine, processEngine, () => null);
  const notice = useSyncExternalStore(subscribeProcessEngine, lastProcessEngineNotice, () => null);
  useEffect(() => {
    // The client is normally created at boot (engineInstance); creating it here
    // where there is an engine bridge is idempotent and keeps the surface self-sufficient.
    // A window.open() child never drives a viewport; pop-out WINDOWS (opened by
    // main, no opener) do — each on its own engine viewport (surfaceViewportId).
    if (processEngine() || window.opener) return;
    let live = true;
    void processEngineEnabled().then((on) => {
      if (live && on) createAppProcessEngine();
    });
    return () => {
      live = false;
    };
  }, []);
  if (!client) return null;
  return <EngineSurfaceInner key={mode} client={client} mode={mode} notice={notice ? noticeText(notice) : null} />;
}

function noticeText(n: NonNullable<ReturnType<typeof lastProcessEngineNotice>>): string {
  if (n.kind === 'unavailable') return `Engine unavailable (${n.reason})`;
  return `Engine restarted (${n.cause}) · ${n.replayed} requests replayed in ${n.ms} ms`;
}

function EngineSurfaceInner({ client, mode, notice }: { client: ProcessEngineClient; mode: EngineSurfaceMode; notice: string | null }): JSX.Element {
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const displayMode = useViewportDisplayStore((s) => s.displayMode);
  // Viewport mode: a status line until the first frame lands (never a blank
  // stage with no explanation). One React render when it changes.
  const [firstFrame, setFirstFrame] = useState(false);
  const [waitingLong, setWaitingLong] = useState(false);
  // The active comp's size, for the pasteboard around it (read by the draw, never a render per frame).
  const compSettings = useActiveMirrorComp()?.settings;
  const compSizeRef = useRef({ width: 0, height: 0 });
  compSizeRef.current.width = compSettings?.width ?? 0;
  compSizeRef.current.height = compSettings?.height ?? 0;

  useEffect(() => {
    const box = frameBoxRef.current;
    const canvas = canvasRef.current;
    const bridge = processEngineBridge();
    if (!box || !canvas || !bridge?.onFrame) return undefined;

    const stats: EngineSurfaceStats = {
      mode, route: null, received: 0, drawn: 0, superseded: 0, fps: 0, lastRevision: 0, lastFrame: 0, lastLatencyMs: 0,
      lastRenderMs: 0, engineBuildMs: 0, lastDrawnAt: 0, viewportsSent: 0, lastViewport: null, errors: [],
    };
    (window as unknown as { __premationEngineSurface?: EngineSurfaceStats }).__premationEngineSurface = stats;
    const fail = (e: unknown): void => {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      if (stats.errors.length > 20) stats.errors.shift();
    };

    let disposed = false;
    // B4 round 2: while the engine draws THE viewport, the overlays' geometry is the frames' (overlayGeometry.ts).
    // Known once main answered viewportBase; nothing is sent before (sendViewport waits).
    let vp: number | null = null;
    // The pasteboard (pasteboard.ts): the uniform, its CPU copy (reused every
    // draw — no per-frame allocation), the camera the engine last applied, and
    // the theme colour (re-read at most once a second: theme / Settings changes).
    const boardData = new Float32Array(BOARD_FLOATS);
    let applied: NonNullable<EngineSurfaceStats['lastViewport']> | null = null;
    let boardRgb: [number, number, number] | null = null;
    let boardColorAt = Number.NEGATIVE_INFINITY;
    let pending: Pending | null = null;
    let raf = 0;
    let fpsCount = 0;
    let fpsSince = performance.now();
    let sawFirst = false;
    const slowTimer = setTimeout(() => { if (!sawFirst && !disposed) setWaitingLong(true); }, 3000);
    // The WebGPU blit (frameBlit.ts): up asynchronously; the newest frame waits for it.
    const blitter = createFrameBlitter(canvas, () => { if (pending) schedule(); }, fail);

    /**
     * The pasteboard uniform for a w×h frame: the comp rect under the camera the
     * engine last applied, when that camera is the one this frame was drawn with
     * (same aspect — a frame from before a resize shows as it is), the view is
     * the 2D Active Camera (a custom 3D view is not a rectangle) and the theme
     * colour parsed. Otherwise off: the frame shows unchanged.
     */
    const writeBoard = (w: number, h: number): void => {
      const now = performance.now();
      if (now - boardColorAt > 1000) {
        boardColorAt = now;
        boardRgb = parseCssRgb(getComputedStyle(canvas).color);
      }
      const cam = applied;
      const size = compSizeRef.current;
      const rect = cam && boardRgb && useGuidesStore.getState().camera3dMode === 'active'
        && Math.abs(w / Math.max(1, h) - cam.width / Math.max(1, cam.height)) < 0.02
        ? compUvRect(cam, size.width, size.height)
        : null;
      boardData[0] = rect ? rect.x0 : 0;
      boardData[1] = rect ? rect.y0 : 0;
      boardData[2] = rect ? rect.x1 : 1;
      boardData[3] = rect ? rect.y1 : 1;
      boardData[4] = boardRgb ? boardRgb[0] : 0;
      boardData[5] = boardRgb ? boardRgb[1] : 0;
      boardData[6] = boardRgb ? boardRgb[2] : 0;
      boardData[7] = rect ? 1 : 0;
    };

    const draw = (): void => {
      raf = 0;
      const p = pending;
      pending = null;
      if (!p) return;
      if (!blitter.ready()) {
        pending = p;  // GPU not up yet: keep the newest frame
        return;
      }
      try {
        const w = p.frame.displayWidth;
        const h = p.frame.displayHeight;
        writeBoard(w, h);
        // The scopes (frameTap) and a snapshot compare read THIS frame — the
        // engine's VideoFrame, drawn into a 2D copy now, before `release`
        // closes it. The tap returns on a size / clock check when nobody listens.
        const seconds = flicksToSeconds(p.meta.time);
        publishFrame(p.frame, seconds);
        // The loupe / clone lens copy: a full-size 2D blit, only while one of them is open.
        if (viewportPictureWanted()) captureViewportPicture(p.frame);
        if (useCompareStore.getState().pending) useCompareStore.getState().captureFrom(p.frame, seconds, getWorkspaceController().getView());
        // Compare ▸ Difference subtracts the snapshot from THIS frame (copied only while it is on screen).
        if (needsLiveFrame()) captureLiveFrame(p.frame);
        // The blit releases the slot to the engine once the GPU no longer reads it.
        if (!blitter.draw(p.frame, boardData, p.release)) {
          pending = p;
          return;
        }
        const now = performance.now();
        // B4 round 2: the overlays read THIS frame's geometry (the records it carried) from now on.
        if (p.meta.geometry || p.meta.geometryViews) {
          // Filed under the window's LOCAL id: the overlays read viewport 1 in every window (windowViewport.ts).
          publishFrameGeometry(ENGINE_SURFACE_VIEWPORT, p.meta.time, p.meta.revision, p.meta.geometry ?? [], p.meta.geometryViews);
        }
        stats.drawn += 1;
        stats.lastRevision = p.meta.revision;
        // The overlays hold a committed edit's preview until this frame shows it.
        notePresented(ENGINE_SURFACE_VIEWPORT, p.meta.revision);
        stats.lastFrame = p.meta.frame;
        stats.lastLatencyMs = Date.now() - p.meta.renderDoneUs / 1000;
        stats.lastRenderMs = (p.meta.renderDoneUs - p.meta.renderStartUs) / 1000;
        stats.lastDrawnAt = now;
        // The viewport HUD's frame time is the engine's cost of this frame:
        // its build (document → FrameScene) + its render (to GPU completion).
        viewportHudStats.report(stats.lastRenderMs + stats.engineBuildMs, false, now);
        if (!sawFirst) {
          sawFirst = true;
          setFirstFrame(true);
          setWaitingLong(false);
        }
        fpsCount += 1;
        if (now - fpsSince >= 500) {
          stats.fps = (fpsCount * 1000) / (now - fpsSince);
          fpsCount = 0;
          fpsSince = now;
        }
      } catch (e) {
        fail(e);
        p.release();
      }
    };
    function schedule(): void {
      if (!raf && !disposed) raf = requestAnimationFrame(draw);
    }

    // This surface's frames only: the hub routes the window's frames by viewport
    // (a 2-up / 4-up pane is another viewport of this window), subscribed once
    // the id is known below.
    let unFrames: (() => void) | null = null;
    const onFrame = (frame: VideoFrameLike, meta: EngineFrameMeta, release: () => void): void => {
      stats.received += 1;
      const route = (meta as EngineFrameMeta).route ?? 'shared';
      if (route !== stats.route) {
        stats.route = route;
        requestViewport();  // route A caps the size it asks for (copyRouteDpr)
      }
      if (disposed) {
        release();
        return;
      }
      if (pending) {
        stats.superseded += 1;
        pending.release();  // newest wins; the older slot goes straight back
      }
      pending = { frame: frame as VideoFrame, meta, release };
      schedule();
    };

    // ── viewport: size, camera, channel (one request in flight, latest wins) ──
    let inFlight = false;
    let again = false;
    /**
     * The box's size, kept by the ResizeObserver below. `desired` runs on every
     * workspace render — every played frame — and measuring the box there
     * forced a synchronous layout per frame (168 ms of a 3 s playback on a
     * light comp). Null: measure once on the next ask.
     */
    let boxSize: { width: number; height: number } | null = null;
    const desired = (): NonNullable<EngineSurfaceStats['lastViewport']> => {
      if (!boxSize) {
        const m = box.getBoundingClientRect();
        boxSize = { width: m.width, height: m.height };
      }
      const r = boxSize;
      const width = Math.max(1, Math.round(r.width));
      const height = Math.max(1, Math.round(r.height));
      const pageDpr = window.devicePixelRatio || 1;
      const dpr = stats.route === 'copy' ? copyRouteDpr(width, height, pageDpr) : pageDpr;
      // The viewport's 3D view (View ▸ 3D View): the engine renders the axis
      // and camera views itself; a custom view sends its orbit, resolved to the
      // same camera customViewCamera builds for the page's chrome.
      const g = useGuidesStore.getState();
      const view = isCustomViewId(g.camera3dMode) ? 'custom' : g.camera3dMode;
      const customView = isCustomViewId(g.camera3dMode) ? g.customViews[g.camera3dMode] : null;
      const onionState = useOnionSkinStore.getState();
      const onion = onionState.enabled && onionState.opacity > 0 && (onionState.before > 0 || onionState.after > 0)
        ? { before: onionState.before, after: onionState.after, step: onionState.step, opacity: onionState.opacity, colorize: onionState.colorize }
        : null;
      // The page's camera (WorkspaceController.getView: CSS px per comp px and
      // the comp origin on screen) → the comp point at the viewport centre.
      const v = getWorkspaceController().getView();
      const zoom = v.scale > 0 && Number.isFinite(v.scale) ? v.scale : 0;
      return {
        width, height, dpr, zoom,
        panX: zoom > 0 ? (r.width / 2 - v.offsetX) / zoom : 0,
        panY: zoom > 0 ? (r.height / 2 - v.offsetY) / zoom : 0,
        view, customView, onion,
      };
    };
    const sameOnion = (a: NonNullable<EngineSurfaceStats['lastViewport']>['onion'], b: NonNullable<EngineSurfaceStats['lastViewport']>['onion']): boolean =>
      a === b || (a !== null && b !== null && a.before === b.before && a.after === b.after && a.step === b.step
        && a.opacity === b.opacity && a.colorize === b.colorize);
    const sameCustomView = (a: CustomViewParams | null, b: CustomViewParams | null): boolean =>
      a === b || (a !== null && b !== null && a.yaw === b.yaw && a.pitch === b.pitch && a.distance === b.distance
        && (a.poi === b.poi || (a.poi !== null && b.poi !== null && a.poi.x === b.poi.x && a.poi.y === b.poi.y && a.poi.z === b.poi.z)));
    let lastChannel = useGuidesStore.getState().channel;
    const sendViewport = (force = false): void => {
      if (disposed || vp === null) return;
      const d = desired();
      const last = stats.lastViewport;
      const channel = useGuidesStore.getState().channel;
      if (!force && last && channel === lastChannel && last.width === d.width && last.height === d.height && last.dpr === d.dpr
        && last.zoom === d.zoom && last.panX === d.panX && last.panY === d.panY
        && last.view === d.view && sameCustomView(last.customView, d.customView) && sameOnion(last.onion, d.onion)) return;
      if (inFlight) {
        again = true;
        return;
      }
      stats.lastViewport = d;
      lastChannel = channel;
      stats.viewportsSent += 1;
      inFlight = true;
      void client.execute({
        type: 'setViewport',
        viewport: vp,
        width: d.width,
        height: d.height,
        devicePixelRatio: d.dpr,
        zoom: d.zoom,
        pan: { x: d.panX, y: d.panY },
        channel: CHANNEL[channel] ?? 'rgb',
        exposure: 0,
        transparencyGrid: false,
        displayTransform: '',
        layerRenderEffects: true,
        view: d.view,
        ...(d.customView ? {
          customView: {
            yaw: d.customView.yaw,
            pitch: d.customView.pitch,
            ...(d.customView.distance !== null ? { distance: d.customView.distance } : {}),
            ...(d.customView.poi !== null ? { poi: d.customView.poi } : {}),
          },
        } : {}),
        ...(d.onion ? { onion: d.onion } : {}),
      }).then((res) => {
        if (!res.ok) fail(`setViewport: ${res.error.code} ${res.error.message}`);
        else applied = d;  // frames from here on are drawn with this camera (the pasteboard rect)
      }).finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          sendViewport();
        }
      });
    };
    let sizeRaf = 0;
    const requestViewport = (): void => {
      if (!sizeRaf && !disposed) sizeRaf = requestAnimationFrame(() => {
        sizeRaf = 0;
        sendViewport();
      });
    };
    const ro = new ResizeObserver((entries) => {
      // The border box the observer already measured (no layout of our own); else measure on the next ask.
      const bb = entries[entries.length - 1]?.borderBoxSize?.[0];
      boxSize = bb ? { width: bb.inlineSize, height: bb.blockSize } : null;
      requestViewport();
    });
    ro.observe(box);
    let dprQuery: MediaQueryList | null = null;
    const watchDpr = (): void => {
      dprQuery?.removeEventListener('change', onDpr);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener('change', onDpr);
    };
    function onDpr(): void {
      watchDpr();
      requestViewport();
    }
    watchDpr();
    void surfaceViewportId(bridge).then((id) => {
      if (disposed) return;
      vp = id;
      unFrames = subscribeEngineFrames(id, onFrame);
      // B4 round 2: while the engine draws THE viewport, the overlays' geometry is the frames'.
      setEngineDrivenViewport(ENGINE_SURFACE_VIEWPORT, true);
      requestViewport();
    });
    // The workspace's render tick runs whenever the camera may
    // have moved (pan, zoom, fit, resize) — compare and send, in that frame.
    const unRender = getWorkspaceController().onRender(() => sendViewport());
    // The channel and the 3D view both ride on setViewport; `sendViewport` drops a request that changes nothing.
    const unGuides = useGuidesStore.subscribe((s, prev) => {
      if (s.channel !== lastChannel || s.camera3dMode !== prev.camera3dMode || s.customViews !== prev.customViews) sendViewport();
    });
    const unOnion = useOnionSkinStore.subscribe(() => sendViewport());
    // Difference turned on over a still viewport: it needs a live frame, so the engine delivers this one again.
    let hadLive = needsLiveFrame();
    const unCompare = useCompareStore.subscribe(() => {
      const live = needsLiveFrame();
      if (live && !hadLive) sendViewport(true);
      hadLive = live;
    });
    // Preview resolution (Full / Half / Third / Quarter) → the engine's.
    let lastRes: PreviewResolution | null = null;
    const sendResolution = (): void => {
      const r = useRenderQualityStore.getState().resolution;
      if (r === lastRes) return;
      lastRes = r;
      void client.execute({ type: 'setPreviewQuality', resolution: RESOLUTION[r] ?? 'full', fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'half' });
    };
    const unQuality = useRenderQualityStore.subscribe(sendResolution);
    sendResolution();

    // A restarted engine has no viewport until it is told again (the replay
    // restores it too; resending is cheap and makes the surface self-healing).
    const unsub = client.subscribe((batch: EventBatch) => {
      for (const e of batch.events) {
        if (e.type === 'documentReset' && e.reason === 'engineRestarted') {
          stats.lastViewport = null;
          lastRes = null;
          requestViewport();
          sendResolution();
        } else if (e.type === 'renderStatsUpdated') {
          stats.engineBuildMs = e.stats.cpuFrameMs;
        }
      }
    });

    // A lens opening over a still viewport needs the frame again: the same
    // setViewport makes the engine draw it (a cache hit).
    setViewportPictureRefresh(() => sendViewport(true));

    return () => {
      disposed = true;
      setViewportPictureRefresh(null);
      clearTimeout(slowTimer);
      unsub();
      unRender();
      unGuides();
      unOnion();
      unCompare();
      unQuality();
      ro.disconnect();
      dprQuery?.removeEventListener('change', onDpr);
      if (raf) cancelAnimationFrame(raf);
      if (sizeRaf) cancelAnimationFrame(sizeRaf);
      unFrames?.();
      pending?.release();
      pending = null;
      if (vp !== null) {
        void client.execute({ type: 'closeViewport', viewport: vp });
        setEngineDrivenViewport(ENGINE_SURFACE_VIEWPORT, false);
      }
      blitter.dispose();
    };
  }, [client, mode]);

  return (
    <div ref={frameBoxRef} className={styles.viewport} data-engine-surface="viewport" aria-hidden="true">
      {/* Display mode Wireframe / Bounding Box: the outlines alone (the page draws them), not over the shaded picture. */}
      <canvas ref={canvasRef} className={styles.viewportCanvas} style={displayMode !== 'shaded' ? { visibility: 'hidden' } : undefined} />
      {!firstFrame && (
        <div className={styles.waiting} role="status">
          {notice ?? (waitingLong ? 'Waiting for the C++ engine’s first frame…' : '')}
        </div>
      )}
      {firstFrame && notice && <div className={styles.viewportNotice} role="status">{notice}</div>}
    </div>
  );
}
