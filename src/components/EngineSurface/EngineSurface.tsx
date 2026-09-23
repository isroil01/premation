/**
 * EngineSurface — the C++ engine's frames in the app (NATIVE_CORE_PLAN §5 C3,
 * docs/VIEWPORT_ROUTE.md route C).
 *
 * Mounted beside today's viewport, and renders nothing unless the process
 * backend exists (`processEngine()`: PREMATION_ENGINE=process). It
 *   - tells the engine its size: `setViewport` with CSS size × devicePixelRatio
 *     on mount, on resize (ResizeObserver) and on a DPR change (moving the
 *     window to another display, zoom), and again after an engine restart;
 *     `closeViewport` on unmount;
 *   - receives each finished frame as a VideoFrame over the preload's
 *     sharedTexture receiver and draws it with WebGPU
 *     `importExternalTexture` (zero copy), newest frame wins, at most one draw
 *     per animation frame; every frame is released exactly once, after the
 *     GPU is done with it, so the engine's ring slot comes back.
 *
 * No React render per frame (CLAUDE.md): frames, stats and the HUD text go
 * through refs; React renders only when the client or a notice changes.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { EngineFrameMeta, ProcessEngineClient } from '@motion/engine-api';
import {
  createAppProcessEngine,
  lastProcessEngineNotice,
  processEngine,
  processEngineBridge,
  processEngineEnabled,
  subscribeProcessEngine,
} from '@core/engine/process/processEngine';
import styles from './EngineSurface.module.css';

/** The engine viewport id this surface owns. */
export const ENGINE_SURFACE_VIEWPORT = 1;

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

/** What the real-app harness reads (dev): `window.__premationEngineSurface`. */
export interface EngineSurfaceStats {
  received: number;
  drawn: number;
  superseded: number;
  fps: number;
  lastRevision: number;
  lastFrame: number;
  /** Engine render done → drawn in this page, ms (measurement only). */
  lastLatencyMs: number;
  viewportsSent: number;
  lastViewport: { width: number; height: number; dpr: number } | null;
  errors: string[];
}

type Pending = { frame: VideoFrame; meta: EngineFrameMeta; release: () => void };

export function EngineSurface(): JSX.Element | null {
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
  return <EngineSurfaceInner client={client} notice={notice ? noticeText(notice) : null} />;
}

function noticeText(n: NonNullable<ReturnType<typeof lastProcessEngineNotice>>): string {
  if (n.kind === 'fallback') return `Engine unavailable — using the TypeScript engine (${n.reason})`;
  return `Engine restarted (${n.cause}) · ${n.replayed} requests replayed in ${n.ms} ms`;
}

function EngineSurfaceInner({ client, notice }: { client: ProcessEngineClient; notice: string | null }): JSX.Element {
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const box = frameBoxRef.current;
    const canvas = canvasRef.current;
    const bridge = processEngineBridge();
    if (!box || !canvas || !bridge?.onFrame) return undefined;

    const stats: EngineSurfaceStats = {
      received: 0, drawn: 0, superseded: 0, fps: 0, lastRevision: 0, lastFrame: 0, lastLatencyMs: 0,
      viewportsSent: 0, lastViewport: null, errors: [],
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
        stats.drawn += 1;
        stats.lastRevision = p.meta.revision;
        stats.lastFrame = p.meta.frame;
        stats.lastLatencyMs = Date.now() - p.meta.renderDoneUs / 1000;
        fpsCount += 1;
        const now = performance.now();
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

    // ── viewport size ──
    let sizeRaf = 0;
    const sendViewport = (): void => {
      sizeRaf = 0;
      if (disposed) return;
      const r = box.getBoundingClientRect();
      const width = Math.max(1, Math.round(r.width));
      const height = Math.max(1, Math.round(r.height));
      const dpr = window.devicePixelRatio || 1;
      const last = stats.lastViewport;
      if (last && last.width === width && last.height === height && last.dpr === dpr) return;
      stats.lastViewport = { width, height, dpr };
      stats.viewportsSent += 1;
      void client.execute({
        type: 'setViewport',
        viewport: ENGINE_SURFACE_VIEWPORT,
        width,
        height,
        devicePixelRatio: dpr,
        zoom: 1,
        pan: { x: 0, y: 0 },
        channel: 'rgb',
        exposure: 0,
        transparencyGrid: false,
        displayTransform: '',
        layerRenderEffects: true,
      }).then((res) => {
        if (!res.ok) fail(`setViewport: ${res.error.code} ${res.error.message}`);
      });
    };
    const requestViewport = (): void => {
      if (!sizeRaf && !disposed) sizeRaf = requestAnimationFrame(sendViewport);
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
    // A restarted engine has no viewport until it is told again (the replay
    // restores it too; resending is cheap and makes the surface self-healing).
    const unsub = client.subscribe((batch) => {
      if (batch.events.some((e) => e.type === 'documentReset' && e.reason === 'engineRestarted')) {
        stats.lastViewport = null;
        requestViewport();
      }
    });

    return () => {
      disposed = true;
      unsub();
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
  }, [client]);

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
