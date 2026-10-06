/**
 * The WebGPU blit an engine surface draws its frames with: the engine's
 * VideoFrame as an external texture over one full-screen triangle, with the
 * pasteboard uniform (pasteboard.ts) the main viewport paints around the comp.
 * Shared by EngineSurface (the main viewport) and EnginePaneSurface (a 2-up /
 * 4-up pane). lib.dom has no WebGPU, so the members used are typed here.
 */

export interface SurfGpu {
  requestAdapter(): Promise<SurfAdapter | null>;
  getPreferredCanvasFormat(): string;
}
export interface SurfAdapter {
  requestDevice(): Promise<SurfDevice>;
}
export interface SurfDevice {
  createShaderModule(d: { code: string }): unknown;
  createRenderPipeline(d: Record<string, unknown>): { getBindGroupLayout(i: number): unknown };
  createSampler(d: Record<string, unknown>): unknown;
  createBuffer(d: { size: number; usage: number }): unknown;
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
  queue: { submit(b: unknown[]): void; onSubmittedWorkDone(): Promise<void>; writeBuffer(b: unknown, offset: number, data: Float32Array): void };
  destroy(): void;
}
export interface SurfContext {
  configure(d: Record<string, unknown>): void;
  getCurrentTexture(): { createView(): unknown };
}

// `board`: the comp rect in UV (x0, y0, x1, y1) and the pasteboard colour
// (rgb; a = 1 paints it outside the rect, 0 shows the frame as it is) — pasteboard.ts.
// (The engine's frames arrive OPAQUE — measured: alpha is 1 everywhere, a
// transparent layer view included — so a transparency grid cannot be composited
// here; the engine draws it, setViewport `transparencyGrid`.)
export const WGSL = /* wgsl */ `
struct Board { rect: vec4f, color: vec4f };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var<uniform> board: Board;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let c = textureSampleBaseClampToEdge(tex, samp, v.uv);
  let inside = v.uv.x >= board.rect.x && v.uv.x <= board.rect.z && v.uv.y >= board.rect.y && v.uv.y <= board.rect.w;
  if (board.color.a > 0.5 && !inside) { return vec4f(board.color.rgb, 1.0); }
  return c;
}`;

/** GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST (lib.dom has no WebGPU constants). */
const UNIFORM_COPY_DST = 0x0040 | 0x0008;

/** The pasteboard uniform's layout: rect x0, y0, x1, y1, colour r, g, b, on. */
export const BOARD_FLOATS = 8;

export interface FrameBlitter {
  /** True once the device, the pipeline and the canvas context are up. */
  ready(): boolean;
  /**
   * Draw `frame` into the canvas (resized to the frame's pixels) with `board`
   * as the pasteboard uniform; `release` runs once the GPU no longer reads the
   * frame. False — nothing drawn, the frame NOT released — while the GPU is
   * not up yet, so the caller keeps the frame for the `onReady` call.
   */
  draw(frame: VideoFrame, board: Float32Array, release: () => void): boolean;
  dispose(): void;
}

/**
 * Bring up WebGPU on `canvas` (asynchronously; `onReady` once drawing can
 * start, `onError` with the reason when it cannot) and return the blitter.
 */
export function createFrameBlitter(canvas: HTMLCanvasElement, onReady: () => void, onError: (e: unknown) => void): FrameBlitter {
  let disposed = false;
  let device: SurfDevice | null = null;
  let ctx: SurfContext | null = null;
  let pipeline: { getBindGroupLayout(i: number): unknown } | null = null;
  let sampler: unknown = null;
  let boardBuf: unknown = null;

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
      boardBuf = dev.createBuffer({ size: BOARD_FLOATS * 4, usage: UNIFORM_COPY_DST });
      device = dev;
      ctx = c;
      onReady();
    } catch (e) {
      onError(e);
    }
  })();

  return {
    ready: () => device !== null && ctx !== null && pipeline !== null,
    draw(frame, board, release) {
      if (!device || !ctx || !pipeline) return false;
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      device.queue.writeBuffer(boardBuf, 0, board);
      const ext = device.importExternalTexture({ source: frame });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: ext }, { binding: 2, resource: { buffer: boardBuf } }],
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
      device.queue.onSubmittedWorkDone().then(release, release);
      return true;
    },
    dispose() {
      disposed = true;
      device?.destroy();
      device = null;
      ctx = null;
      pipeline = null;
    },
  };
}
