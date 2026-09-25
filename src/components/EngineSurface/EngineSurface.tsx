/**
 * EngineSurface — the C++ engine's frames in the app (NATIVE_CORE_PLAN §5 C3 /
 * D5, docs/VIEWPORT_ROUTE.md route C).
 *
 * Two modes:
 *
 *   'beside'    (C3; the process backend is on, the TypeScript engine owns the
 *               document) a picture-in-picture panel next to today's viewport,
 *               the comp fitted into it. It replaces nothing.
 *   'viewport'  (D5; the engine owns the document, engineOwnership.ts) THE
 *               viewport: it fills the stage in place of the TypeScript canvas,
 *               under the page's overlays, and follows the page's camera —
 *               `setViewport{zoom = view.scale, pan = the comp point at the
 *               stage centre (viewToCamera), CSS size, DPR}` whenever the
 *               workspace's render tick sees the camera or the size change.
 *
 * Both
 *   - tell the engine the size on mount / resize (ResizeObserver) / a DPR change,
 *     and again after an engine restart; `closeViewport` on unmount;
 *   - receive each finished frame as a VideoFrame over the preload's
 *     sharedTexture receiver and draw it with WebGPU `importExternalTexture`
 *     (zero copy), newest frame wins, at most one draw per animation frame;
 *     every frame is released exactly once, after the GPU is done with it, so
 *     the engine's ring slot comes back.
 *
 * No React render per frame (CLAUDE.md): frames, stats, the camera and the HUD
 * text go through refs and subscriptions; React renders only when the client,
 * a notice or the "no frame yet" state changes.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChannelView, EngineFrameMeta, EventBatch, PreviewResolution as EnginePreviewResolution, ProcessEngineClient } from '@motion/engine-api';
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
import { useRenderQualityStore, type PreviewResolution } from '@stores/renderQualityStore';
import { viewportHudStats } from '@stores/viewportDisplayStore';
import styles from './EngineSurface.module.css';

/** The engine viewport id this surface owns. */
export const ENGINE_SURFACE_VIEWPORT = 1;

export type EngineSurfaceMode = 'beside' | 'viewport';

// ── the WebGPU members this file uses (typed locally; lib.dom has no WebGPU) ──

interface SurfGpu {
  requestAdapter(): Promise<SurfAdapter | null>;
  getPreferredCanvasFormat(): string;
}
interface SurfAdapter {
  requestDevice(): Promise<SurfDevice>;
}
interface SurfDevice {
  createShaderModule(d: { code: string }): unknown;
  createRenderPipeline(d: Record<string, unknown>): { getBindGroupLayout(i: number): unknown };
  createSampler(d: Record<string, unknown>): unknown;
  importExternalTexture(d: { source: VideoFrame }): unknown;
  createBindGroup(d: Record<string, unknown>): unknown;
  createCommandEncoder(): {
    beginRenderPass(d: Record<string, unknown>): {
      setPipeline(p: unknown): void;
      setBindGroup(i: number, g: unknown): void;
      draw(n: number): void;
      end(): void;
    };
    finish(): unknown;
  };
  queue: { submit(b: unknown[]): void; onSubmittedWorkDone(): Promise<void> };
  destroy(): void;
}
interface SurfContext {
  configure(d: Record<string, unknown>): void;
  getCurrentTexture(): { createView(): unknown };
}

const WGSL = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(tex, samp, v.uv);
}`;

/** What the real-app harness reads: `window.__premationEngineSurface`. */
export interface EngineSurfaceStats {
  mode: EngineSurfaceMode;
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
  lastViewport: { width: number; height: number; dpr: number; zoom: number; panX: number; panY: number } | null;
  errors: string[];
}

type Pending = { frame: VideoFrame; meta: EngineFrameMeta; release: () => void };

const CHANNEL: Record<string, ChannelView> = { rgb: 'rgb', red: 'red', green: 'green', blue: 'blue', alpha: 'alpha' };
const RESOLUTION: Record<PreviewResolution, EnginePreviewResolution> = { 1: 'full', 2: 'half', 3: 'third', 4: 'quarter' };

export function EngineSurface({ mode = 'beside' }: { mode?: EngineSurfaceMode }): JSX.Element | null {
  const client = useSyncExternalStore(subscribeProcessEngine, processEngine, () => null);
  const notice = useSyncExternalStore(subscribeProcessEngine, lastProcessEngineNotice, () => null);
  useEffect(() => {
    // The client is normally created at boot (engineInstance); creating it here
    // when the flag is on is idempotent and keeps the surface self-sufficient.
    // Only the main editor window drives the engine's viewport (a pop-out has an opener).
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
  if (n.kind === 'fallback') return `Engine unavailable — using the TypeScript engine (${n.reason})`;
  return `Engine restarted (${n.cause}) · ${n.replayed} requests replayed in ${n.ms} ms`;
}

function EngineSurfaceInner({ client, mode, notice }: { client: ProcessEngineClient; mode: EngineSurfaceMode; notice: string | null }): JSX.Element {
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLSpanElement>(null);
  // Viewport mode: a status line until the first frame lands (never a blank
  // stage with no explanation). One React render when it changes.
  const [firstFrame, setFirstFrame] = useState(false);
  const [waitingLong, setWaitingLong] = useState(false);

  useEffect(() => {
    const box = frameBoxRef.current;
    const canvas = canvasRef.current;
    const bridge = processEngineBridge();
    if (!box || !canvas || !bridge?.onFrame) return undefined;
    const isViewport = mode === 'viewport';

    const stats: EngineSurfaceStats = {
      mode, received: 0, drawn: 0, superseded: 0, fps: 0, lastRevision: 0, lastFrame: 0, lastLatencyMs: 0,
      lastRenderMs: 0, engineBuildMs: 0, lastDrawnAt: 0, viewportsSent: 0, lastViewport: null, errors: [],
    };
    (window as unknown as { __premationEngineSurface?: EngineSurfaceStats }).__premationEngineSurface = stats;
    const fail = (e: unknown): void => {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      if (stats.errors.length > 20) stats.errors.shift();
    };

    let disposed = false;
    let device: SurfDevice | null = null;
    let ctx: SurfContext | null = null;
    let pipeline: { getBindGroupLayout(i: number): unknown } | null = null;
    let sampler: unknown = null;
    let pending: Pending | null = null;
    let raf = 0;
    let fpsCount = 0;
    let fpsSince = performance.now();
    let hudAt = 0;
    let sawFirst = false;
    const slowTimer = isViewport ? setTimeout(() => { if (!sawFirst && !disposed) setWaitingLong(true); }, 3000) : null;

    // ── GPU ──
    void (async () => {
      try {
        const gpu = (navigator as unknown as { gpu?: SurfGpu }).gpu;
        if (!gpu) throw new Error('WebGPU unavailable');
        const adapter = await gpu.requestAdapter();
        if (!adapter) throw new Error('no WebGPU adapter');
        const dev = await adapter.requestDevice();
        if (disposed) {
          dev.destroy();
          return;
        }
        const c = canvas.getContext('webgpu') as unknown as SurfContext | null;
        if (!c) throw new Error('no webgpu canvas context');
        const format = gpu.getPreferredCanvasFormat();
        c.configure({ device: dev, format, alphaMode: 'opaque' });
        const module = dev.createShaderModule({ code: WGSL });
        pipeline = dev.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        });
        sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        device = dev;
        ctx = c;
        if (pending) schedule();
      } catch (e) {
        fail(e);
      }
    })();

    const draw = (): void => {
      raf = 0;
      const p = pending;
      pending = null;
      if (!p) return;
      if (!device || !ctx || !pipeline) {
        pending = p;  // GPU not up yet: keep the newest frame
        return;
      }
      try {
        const w = p.frame.displayWidth;
        const h = p.frame.displayHeight;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ext = device.importExternalTexture({ source: p.frame });
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: ext }],
        });
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([enc.finish()]);
        // The slot goes back to the engine once the GPU no longer reads it.
        device.queue.onSubmittedWorkDone().then(p.release, p.release);
        const now = performance.now();
        stats.drawn += 1;
        stats.lastRevision = p.meta.revision;
        stats.lastFrame = p.meta.frame;
        stats.lastLatencyMs = Date.now() - p.meta.renderDoneUs / 1000;
        stats.lastRenderMs = (p.meta.renderDoneUs - p.meta.renderStartUs) / 1000;
        stats.lastDrawnAt = now;
        // The viewport HUD's frame time is the engine's cost of this frame:
        // its build (document → FrameScene) + its render (to GPU completion).
        if (isViewport) viewportHudStats.report(stats.lastRenderMs + stats.engineBuildMs, false, now);
        if (!sawFirst) {
          sawFirst = true;
          if (isViewport) {
            setFirstFrame(true);
            setWaitingLong(false);
          }
        }
        fpsCount += 1;
        if (now - fpsSince >= 500) {
          stats.fps = (fpsCount * 1000) / (now - fpsSince);
          fpsCount = 0;
          fpsSince = now;
        }
        // The readout at most 4× a second (a text write, not a React render).
        if (hudRef.current && now - hudAt >= 250) {
          hudAt = now;
          hudRef.current.textContent = `${stats.fps.toFixed(1)} fps · rev ${stats.lastRevision} · f ${stats.lastFrame} · ${w}×${h}`;
        }
      } catch (e) {
        fail(e);
        p.release();
      }
    };
    function schedule(): void {
      if (!raf && !disposed) raf = requestAnimationFrame(draw);
    }

    bridge.onFrame((frame, meta, release) => {
      stats.received += 1;
      if (disposed) {
        release();
        return;
      }
      if (pending) {
        stats.superseded += 1;
        pending.release();  // newest wins; the older slot goes straight back
      }
      pending = { frame: frame as VideoFrame, meta: meta as EngineFrameMeta, release };
      schedule();
    });

    // ── viewport: size, camera, channel (one request in flight, latest wins) ──
    let inFlight = false;
    let again = false;
    const desired = (): NonNullable<EngineSurfaceStats['lastViewport']> => {
      const r = box.getBoundingClientRect();
      const width = Math.max(1, Math.round(r.width));
      const height = Math.max(1, Math.round(r.height));
      const dpr = window.devicePixelRatio || 1;
      if (!isViewport) return { width, height, dpr, zoom: 0, panX: 0, panY: 0 };  // fit
      // The page's camera (WorkspaceController.getView: CSS px per comp px and
      // the comp origin on screen) → the comp point at the viewport centre.
      const v = getWorkspaceController().getView();
      const zoom = v.scale > 0 && Number.isFinite(v.scale) ? v.scale : 0;
      return {
        width, height, dpr, zoom,
        panX: zoom > 0 ? (r.width / 2 - v.offsetX) / zoom : 0,
        panY: zoom > 0 ? (r.height / 2 - v.offsetY) / zoom : 0,
      };
    };
    let lastChannel = useGuidesStore.getState().channel;
    const sendViewport = (force = false): void => {
      if (disposed) return;
      const d = desired();
      const last = stats.lastViewport;
      const channel = useGuidesStore.getState().channel;
      if (!force && last && channel === lastChannel && last.width === d.width && last.height === d.height && last.dpr === d.dpr
        && last.zoom === d.zoom && last.panX === d.panX && last.panY === d.panY) return;
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
        viewport: ENGINE_SURFACE_VIEWPORT,
        width: d.width,
        height: d.height,
        devicePixelRatio: d.dpr,
        zoom: d.zoom,
        pan: { x: d.panX, y: d.panY },
        channel: isViewport ? CHANNEL[channel] ?? 'rgb' : 'rgb',
        exposure: 0,
        transparencyGrid: false,
        displayTransform: '',
        layerRenderEffects: true,
      }).then((res) => {
        if (!res.ok) fail(`setViewport: ${res.error.code} ${res.error.message}`);
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
    const ro = new ResizeObserver(requestViewport);
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
    requestViewport();
    // Viewport mode: the workspace's render tick runs whenever the camera may
    // have moved (pan, zoom, fit, resize) — compare and send, in that frame.
    const unRender = isViewport ? getWorkspaceController().onRender(() => sendViewport()) : null;
    const unGuides = isViewport ? useGuidesStore.subscribe((s) => { if (s.channel !== lastChannel) sendViewport(); }) : null;
    // Preview resolution (Full / Half / Third / Quarter) → the engine's.
    let lastRes: PreviewResolution | null = null;
    const sendResolution = (): void => {
      const r = useRenderQualityStore.getState().resolution;
      if (r === lastRes) return;
      lastRes = r;
      void client.execute({ type: 'setPreviewQuality', resolution: RESOLUTION[r] ?? 'full', fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'half' });
    };
    const unQuality = isViewport ? useRenderQualityStore.subscribe(sendResolution) : null;
    if (isViewport) sendResolution();

    // A restarted engine has no viewport until it is told again (the replay
    // restores it too; resending is cheap and makes the surface self-healing).
    const unsub = client.subscribe((batch: EventBatch) => {
      for (const e of batch.events) {
        if (e.type === 'documentReset' && e.reason === 'engineRestarted') {
          stats.lastViewport = null;
          lastRes = null;
          requestViewport();
          if (isViewport) sendResolution();
        } else if (e.type === 'renderStatsUpdated') {
          stats.engineBuildMs = e.stats.cpuFrameMs;
        }
      }
    });

    return () => {
      disposed = true;
      if (slowTimer) clearTimeout(slowTimer);
      unsub();
      unRender?.();
      unGuides?.();
      unQuality?.();
      ro.disconnect();
      dprQuery?.removeEventListener('change', onDpr);
      if (raf) cancelAnimationFrame(raf);
      if (sizeRaf) cancelAnimationFrame(sizeRaf);
      bridge.onFrame?.(null);
      pending?.release();
      pending = null;
      void client.execute({ type: 'closeViewport', viewport: ENGINE_SURFACE_VIEWPORT });
      device?.destroy();
    };
  }, [client, mode]);

  if (mode === 'viewport') {
    return (
      <div ref={frameBoxRef} className={styles.viewport} data-engine-surface="viewport" aria-hidden="true">
        <canvas ref={canvasRef} className={styles.viewportCanvas} />
        {!firstFrame && (
          <div className={styles.waiting} role="status">
            {notice ?? (waitingLong ? 'Waiting for the C++ engine’s first frame…' : '')}
          </div>
        )}
        {firstFrame && notice && <div className={styles.viewportNotice} role="status">{notice}</div>}
      </div>
    );
  }
  return (
    <div className={styles.surface} data-engine-surface="" aria-hidden="true">
      <div className={styles.title}>
        <span className={styles.label}>C++ engine</span>
        <span ref={hudRef}>waiting for frames</span>
      </div>
      <div ref={frameBoxRef} className={styles.frame}>
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>
      {notice && <div className={styles.notice} role="status">{notice}</div>}
    </div>
  );
}
