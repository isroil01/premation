/**
 * EnginePaneSurface — a secondary view pane's pixels, drawn by the C++ engine.
 *
 * A 2-up / 4-up pane shows the composition through its own 3D view (Top, a
 * camera, a custom orbit…) with its own framing. Each pane is its own engine
 * viewport (engineFrameHub.ts allocates the id): `setViewport` carries the
 * pane's CSS size, DPR, zoom / pan (its camera, `getView`) and `view` /
 * `customView` (the mode), and the engine renders that view — the
 * SecondaryViewPane's chrome (selection outline, gizmo, focus plane) draws over
 * this canvas through the same `getView`, so it lines up with the pixels.
 *
 * Only what a pane needs: no pasteboard, no HUD, no preview-resolution or
 * overlay-geometry plumbing (those are the main viewport's, EngineSurface).
 * Renders nothing where there is no engine bridge (jest, a browser build).
 */

import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { secondsToFlicks, type EngineFrameMeta, type EventBatch, type ProcessEngineClient } from '@motion/engine-api';
import { processEngine, subscribeProcessEngine } from '@core/engine/process/processEngine';
import { isCustomViewId, type CustomViewParams } from '@core/workspace/customViews';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { copyRouteDpr } from './EngineSurface';
import { BOARD_FLOATS, createFrameBlitter } from './frameBlit';
import { allocatePaneViewport, releasePaneViewport, subscribeEngineFrames } from './engineFrameHub';
import { compUvRect, fitUvRect } from './pasteboard';

/** A colour painted around the composition (the engine clears it to opaque black): 0..1 rgb and the comp's size. */
export interface PaneSurround {
  color: readonly [number, number, number];
  compWidth: number;
  compHeight: number;
}

/** The pane's comp → canvas transform: CSS px per comp px and the comp origin on screen (RenderView). */
export interface PaneView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** The Layer panel (setViewport `layer`): one layer alone at its source size, contain-fitted. */
export interface PaneLayerView {
  id: string;
  /** The panel's Render switch: false shows the untouched source. */
  renderEffects: boolean;
  /** How the layer's alpha is shown (setViewport `layerAlphaView`); absent = the layer as it is. */
  alphaView?: 'alpha' | 'boundary' | 'overlay';
  /** A held comp time, seconds (the panel's own ruler); absent = the session clock. */
  time?: number;
  /** With `time`: the layer's source time at it, seconds. */
  sourceTime?: number;
}

interface Desired {
  width: number;
  height: number;
  dpr: number;
  zoom: number;
  panX: number;
  panY: number;
  view: string;
  customView: CustomViewParams | null;
  layer: PaneLayerView | null;
}

interface Pending {
  frame: VideoFrame;
  meta: EngineFrameMeta;
  release: () => void;
}

function sameCustomView(a: CustomViewParams | null, b: CustomViewParams | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.yaw !== b.yaw || a.pitch !== b.pitch || a.distance !== b.distance) return false;
  if (a.poi === b.poi) return true;
  return a.poi !== null && b.poi !== null && a.poi.x === b.poi.x && a.poi.y === b.poi.y && a.poi.z === b.poi.z;
}

function sameLayerView(a: PaneLayerView | null, b: PaneLayerView | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.id === b.id && a.renderEffects === b.renderEffects && a.alphaView === b.alphaView && a.time === b.time && a.sourceTime === b.sourceTime;
}

function sameDesired(a: Desired, b: Desired): boolean {
  return a.width === b.width && a.height === b.height && a.dpr === b.dpr && a.zoom === b.zoom && a.panX === b.panX
    && a.panY === b.panY && a.view === b.view && sameCustomView(a.customView, b.customView) && sameLayerView(a.layer, b.layer);
}

export function EnginePaneSurface({ mode, getView, framingRev, layer, surround, className, style }: {
  mode: Camera3dMode;
  /** The pane's live camera (usePaneWorkspace getRenderView, with the contain fit as the fallback); absent = the engine contain-fits the frame. */
  getView?: () => PaneView;
  /** Bumps whenever the pane's camera moves: the viewport is re-sent then. */
  framingRev: number;
  /** The Layer panel: this layer alone instead of the composition. */
  layer?: PaneLayerView;
  /** Paint this around the composition (the Preview page's surround); absent = the frame as it is. */
  surround?: PaneSurround | null;
  className?: string;
  style?: CSSProperties;
}): JSX.Element | null {
  const client = useSyncExternalStore(subscribeProcessEngine, processEngine, () => null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const surroundRef = useRef(surround ?? null);
  surroundRef.current = surround ?? null;
  const getViewRef = useRef(getView);
  getViewRef.current = getView;
  const layerRef = useRef(layer);
  layerRef.current = layer;
  // The effect below installs the sender; a view / framing / layer change asks it to compare and send.
  const requestRef = useRef<() => void>(() => {});
  useEffect(() => {
    requestRef.current();
  }, [mode, framingRev, layer?.id, layer?.renderEffects, layer?.alphaView, layer?.time, layer?.sourceTime]);
  // A new surround needs a frame to be painted around: ask the engine for one (paused, none would come).
  const refreshRef = useRef<() => void>(() => {});
  const surroundKey = surround ? `${surround.color.join(',')}|${surround.compWidth}x${surround.compHeight}` : '';
  useEffect(() => {
    refreshRef.current();
  }, [surroundKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!client || !canvas) return undefined;
    const c: ProcessEngineClient = client;
    let disposed = false;
    let vp: number | null = null;
    let pending: Pending | null = null;
    let raf = 0;
    let route: 'shared' | 'copy' = 'shared';
    const board = new Float32Array(BOARD_FLOATS);  // all zero: the frame as it is, no pasteboard
    const blitter = createFrameBlitter(canvas, () => { if (pending) schedule(); }, () => {});

    const draw = (): void => {
      raf = 0;
      const p = pending;
      pending = null;
      if (!p) return;
      fillBoard();
      try {
        if (!blitter.draw(p.frame, board, p.release)) pending = p;  // GPU not up yet: keep the newest frame
      } catch {
        p.release();
      }
    };
    function schedule(): void {
      if (!raf && !disposed) raf = requestAnimationFrame(draw);
    }

    // ── viewport: size, camera, view (one request in flight, latest wins) ──
    let inFlight = false;
    let again = false;
    let last: Desired | null = null;

    // The surround's rectangle follows the camera the frames are asked with; worked out
    // again only when that camera or the surround changes, never per frame.
    let boardCam: Desired | null = null;
    let boardSurround: PaneSurround | null = null;
    function fillBoard(): void {
      const s = surroundRef.current;
      if (last === boardCam && s === boardSurround) return;
      boardCam = last;
      boardSurround = s;
      const d = last;
      const rect = !s || !d ? null
        : d.zoom > 0 ? compUvRect({ width: d.width, height: d.height, zoom: d.zoom, panX: d.panX, panY: d.panY }, s.compWidth, s.compHeight)
          : fitUvRect(d.width, d.height, s.compWidth, s.compHeight);
      if (!s || !rect) {
        board.fill(0);
        return;
      }
      board.set([rect.x0, rect.y0, rect.x1, rect.y1, s.color[0], s.color[1], s.color[2], 1]);
    }
    const desired = (): Desired => {
      const r = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(r.width));
      const height = Math.max(1, Math.round(r.height));
      const pageDpr = window.devicePixelRatio || 1;
      const dpr = route === 'copy' ? copyRouteDpr(width, height, pageDpr) : pageDpr;
      const v = getViewRef.current?.();
      const zoom = v && v.scale > 0 && Number.isFinite(v.scale) ? v.scale : 0;  // 0 = the engine's contain fit
      const g = useGuidesStore.getState();
      const m = modeRef.current;
      return {
        width, height, dpr, zoom,
        panX: v && zoom > 0 ? (r.width / 2 - v.offsetX) / zoom : 0,
        panY: v && zoom > 0 ? (r.height / 2 - v.offsetY) / zoom : 0,
        view: isCustomViewId(m) ? 'custom' : m,
        customView: isCustomViewId(m) ? g.customViews[m] : null,
        layer: layerRef.current ?? null,
      };
    };
    const send = (): void => {
      if (disposed || vp === null) return;
      const d = desired();
      if (last && sameDesired(last, d)) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      last = d;
      void c.execute({
        type: 'setViewport',
        viewport: vp,
        width: d.width,
        height: d.height,
        devicePixelRatio: d.dpr,
        zoom: d.zoom,
        pan: { x: d.panX, y: d.panY },
        channel: 'rgb',
        exposure: 0,
        // The Layer panel: the engine draws a checkerboard behind the layer's bounds
        // (frames arrive opaque, so the page cannot composite one under them).
        transparencyGrid: d.layer !== null,
        displayTransform: '',
        ...(d.layer ? {
          layer: d.layer.id,
          layerRenderEffects: d.layer.renderEffects,
          ...(d.layer.alphaView ? { layerAlphaView: d.layer.alphaView } : {}),
          ...(d.layer.time !== undefined ? { time: secondsToFlicks(d.layer.time) } : {}),
          ...(d.layer.time !== undefined && d.layer.sourceTime !== undefined ? { layerSourceTime: secondsToFlicks(d.layer.sourceTime) } : {}),
        } : { layerRenderEffects: true }),
        view: d.view,
        ...(d.customView ? {
          customView: {
            yaw: d.customView.yaw,
            pitch: d.customView.pitch,
            ...(d.customView.distance !== null ? { distance: d.customView.distance } : {}),
            ...(d.customView.poi !== null ? { poi: d.customView.poi } : {}),
          },
        } : {}),
      }).finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          send();
        }
      });
    };
    let sizeRaf = 0;
    const request = (): void => {
      if (!sizeRaf && !disposed) sizeRaf = requestAnimationFrame(() => {
        sizeRaf = 0;
        send();
      });
    };
    requestRef.current = request;
    refreshRef.current = () => {
      last = null;  // the same viewport sent again still renders a frame (session.cpp SetViewport)
      request();
    };
    const ro = new ResizeObserver(request);
    ro.observe(canvas);
    // A custom view's orbit lives in the guides store; the mode itself arrives through props.
    const unGuides = useGuidesStore.subscribe((s, prev) => {
      if (s.customViews !== prev.customViews) request();
    });

    let unFrames: (() => void) | null = null;
    void allocatePaneViewport().then((id) => {
      if (disposed) {
        releasePaneViewport(id);
        return;
      }
      vp = id;
      unFrames = subscribeEngineFrames(id, (frame, meta, release) => {
        if (disposed) {
          release();
          return;
        }
        const r = meta.route ?? 'shared';
        if (r !== route) {
          route = r;
          request();  // route A caps the size it asks for (copyRouteDpr)
        }
        if (pending) pending.release();  // newest wins
        pending = { frame: frame as VideoFrame, meta, release };
        schedule();
      });
      request();
    }, () => {});

    // A restarted engine has no viewport until it is told again.
    const unsub = c.subscribe((batch: EventBatch) => {
      for (const e of batch.events) {
        if (e.type === 'documentReset' && e.reason === 'engineRestarted') {
          last = null;
          request();
        }
      }
    });

    return () => {
      disposed = true;
      requestRef.current = () => {};
      refreshRef.current = () => {};
      unsub();
      unGuides();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (sizeRaf) cancelAnimationFrame(sizeRaf);
      unFrames?.();
      pending?.release();
      pending = null;
      if (vp !== null) {
        void c.execute({ type: 'closeViewport', viewport: vp });
        releasePaneViewport(vp);
      }
      blitter.dispose();
    };
  }, [client]);

  if (!client) return null;
  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" data-engine-pane="" />;
}
