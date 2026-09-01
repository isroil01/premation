/**
 * Pixel Motion's full-resolution warp on the GPU — the float twin of
 * `warpBlend` in `pixelMotionFlow.ts`.
 *
 * ── Why this gate is DIFFERENT from the estimation's ────────────────────────
 *
 * The flow search could go to the GPU under a bit-equality gate because it is
 * integer end to end. The warp cannot: it is float bilinear sampling, and
 * float arithmetic is where GPU and CPU legitimately part ways (fma
 * contraction, float32 vs float64 intermediates, UNORM rounding ties). No
 * self-check can promise bit-equal warps, so this module makes the weaker —
 * but still sufficient — promise the determinism contract actually needs:
 *
 *   THE WARP BACKEND IS A SESSION-LEVEL DECISION. `getGpuWarper` probes once
 *   (like `getGpuFlowEstimator`): WebGL2 present, shader compiles, and a
 *   self-check passes — the GPU warp of a synthetic pair must land within a
 *   few counts of the CPU warp (proving the coordinate mapping, edge clamps
 *   and blend are the same math) and two GPU runs must be BIT-IDENTICAL
 *   (proving the GPU itself is deterministic; it is — same commands, same
 *   data, same output — but we do not take that on faith). Pass, and every
 *   Pixel Motion frame this session — preview and export alike — warps on
 *   the GPU. Fail, and every frame warps on the CPU. Either way preview
 *   pixels == export pixels on the same machine, which is the contract; the
 *   two backends' outputs differ from each other by ≤ the self-check
 *   tolerance, but no user ever sees both.
 *
 *   The one seam: a mid-session context loss drops the REMAINING frames to
 *   the CPU warp (visually indistinguishable, not bit-identical — the same
 *   bilinear to within rounding). The alternative — failing Pixel Motion
 *   outright for the rest of the session — is strictly worse than a
 *   sub-count divergence on a crashed GPU.
 *
 * ── Shape of the work ───────────────────────────────────────────────────────
 *
 * One fragment per OUTPUT pixel, mirroring `warpBlend` expression for
 * expression: sample the flow grid bilinearly (RG32F texture, manual bilinear
 * via texelFetch — no float-linear-filtering extension needed), walk A back
 * `t` and B forward `1−t` along it, bilinear-fetch both (bytes snapped with
 * round() so UNORM upload wobble cannot compound), cross-fade. The result
 * stays on the GPU: the caller drawImages the returned canvas — no
 * getImageData of the two full-res sources, no putImageData of the result,
 * which were a real slice of the CPU path's per-frame cost by themselves.
 *
 * Frame textures are cached per `pairKey` (the flow cache already trusts it
 * to identify the pair's content), so scrubbing inside one bracket re-uploads
 * nothing and a warp is just uniforms + one draw.
 */

import type { FlowField } from './pixelMotionFlow';
import { warpBlend } from './pixelMotionFlow';

/** Max per-channel difference (0..255) the self-check tolerates between the
 *  GPU and CPU warp of the synthetic pair. Real mapping bugs (flipped Y,
 *  off-by-one coords, premultiply) miss by tens of counts; honest float
 *  divergence (fma, UNORM tie rounding, upload wobble) stays within 2. */
const SELF_CHECK_TOLERANCE = 3;

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** The warp kernel — `warpBlend`'s per-pixel body. gl_FragCoord's y points
 *  up while image rows point down, hence the flip; texture row i is image
 *  row i (FLIP_Y off), so all fetches use image coordinates throughout. */
const WARP_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFlow;
uniform ivec2 uSize;
uniform ivec2 uGrid;
uniform float uStep;
uniform vec2 uInvScale;
uniform vec2 uScale;
uniform float uT;
out vec4 oColor;

// Byte-snap: UNORM8 -> float -> ×255 recovers the byte to within float
// rounding; round() lands it exactly, so the arithmetic below runs on the
// same 0..255 values the CPU path reads out of getImageData.
vec4 fetchByte(sampler2D s, ivec2 p) {
  return round(texelFetch(s, p, 0) * 255.0);
}

// bilinearRgba: edge-clamped bilinear fetch at an image-space position.
vec4 bilinearRgba(sampler2D s, vec2 pos) {
  vec2 c = clamp(pos, vec2(0.0), vec2(uSize) - 1.0);
  vec2 f0 = floor(c);
  vec2 f = c - f0;
  ivec2 i0 = ivec2(f0);
  ivec2 i1 = min(i0 + 1, uSize - 1);
  vec4 p00 = fetchByte(s, i0);
  vec4 p10 = fetchByte(s, ivec2(i1.x, i0.y));
  vec4 p01 = fetchByte(s, ivec2(i0.x, i1.y));
  vec4 p11 = fetchByte(s, i1);
  return mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y);
}

// sampleFlow: edge-clamped bilinear over the flow grid, flow-resolution px in.
vec2 sampleFlowAt(vec2 p) {
  vec2 g = clamp(p / uStep - 0.5, vec2(0.0), vec2(uGrid) - 1.0);
  vec2 g0f = floor(g);
  vec2 f = g - g0f;
  ivec2 g0 = ivec2(g0f);
  ivec2 g1 = min(g0 + 1, uGrid - 1);
  vec2 v00 = texelFetch(uFlow, g0, 0).rg;
  vec2 v10 = texelFetch(uFlow, ivec2(g1.x, g0.y), 0).rg;
  vec2 v01 = texelFetch(uFlow, ivec2(g0.x, g1.y), 0).rg;
  vec2 v11 = texelFetch(uFlow, g1, 0).rg;
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

void main() {
  vec2 xy = vec2(gl_FragCoord.x - 0.5, float(uSize.y) - gl_FragCoord.y - 0.5);
  vec2 d = sampleFlowAt(xy * uInvScale) * uScale;
  vec4 pa = bilinearRgba(uA, xy - d * uT);
  vec4 pb = bilinearRgba(uB, xy + d * (1.0 - uT));
  oColor = (pa * (1.0 - uT) + pb * uT) / 255.0;
}`;

function compileProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.shaderSource(vs, vertSrc);
  gl.compileShader(vs);
  gl.shaderSource(fs, fragSrc);
  gl.compileShader(fs);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function nearestTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** One WebGL2 warper. Construct via `getGpuWarper` — the factory owns the
 *  self-check and the process-wide singleton. */
export class GpuWarper {
  private gl: WebGL2RenderingContext;
  private glCanvas: HTMLCanvasElement;
  private prog: WebGLProgram;
  private uA: WebGLUniformLocation | null;
  private uB: WebGLUniformLocation | null;
  private uFlow: WebGLUniformLocation | null;
  private uSize: WebGLUniformLocation | null;
  private uGrid: WebGLUniformLocation | null;
  private uStep: WebGLUniformLocation | null;
  private uInvScale: WebGLUniformLocation | null;
  private uScale: WebGLUniformLocation | null;
  private uT: WebGLUniformLocation | null;
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private flowTex: WebGLTexture;
  /** Frame textures currently uploaded: pair identity + dimensions. */
  private framePairKey = '';
  private frameW = 0;
  private frameH = 0;
  /** Flow texture currently uploaded, by object identity (the flow LRU hands
   *  the same FlowField back for every weight inside a bracket). */
  private flowRef: FlowField | null = null;
  private flowScratch = new Float32Array(0);
  private dead = false;

  private constructor(
    gl: WebGL2RenderingContext,
    glCanvas: HTMLCanvasElement,
    prog: WebGLProgram,
    texA: WebGLTexture,
    texB: WebGLTexture,
    flowTex: WebGLTexture,
  ) {
    this.gl = gl;
    this.glCanvas = glCanvas;
    this.prog = prog;
    this.uA = gl.getUniformLocation(prog, 'uA');
    this.uB = gl.getUniformLocation(prog, 'uB');
    this.uFlow = gl.getUniformLocation(prog, 'uFlow');
    this.uSize = gl.getUniformLocation(prog, 'uSize');
    this.uGrid = gl.getUniformLocation(prog, 'uGrid');
    this.uStep = gl.getUniformLocation(prog, 'uStep');
    this.uInvScale = gl.getUniformLocation(prog, 'uInvScale');
    this.uScale = gl.getUniformLocation(prog, 'uScale');
    this.uT = gl.getUniformLocation(prog, 'uT');
    this.texA = texA;
    this.texB = texB;
    this.flowTex = flowTex;
    // Context loss makes every call a silent no-op and the canvas stale —
    // mark dead so callers drop to the CPU warp (see the header: the one
    // event that changes warp pixels mid-session, deliberately).
    glCanvas.addEventListener('webglcontextlost', () => {
      this.dead = true;
    });
  }

  static tryCreate(): GpuWarper | null {
    if (typeof document === 'undefined') return null;
    const glCanvas = document.createElement('canvas');
    glCanvas.width = 1;
    glCanvas.height = 1;
    const gl = glCanvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: true,
      // The shader writes NON-premultiplied RGBA — same convention as the
      // CPU path's ImageData — so the drawImage into the 2d output canvas
      // premultiplies exactly once, the same as putImageData does.
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    } as WebGLContextAttributes) as WebGL2RenderingContext | null;
    if (!gl || typeof gl.createTexture !== 'function') return null;
    // Exact byte parity with the CPU path's getImageData: no premultiply, no
    // flip, no colour-space conversion on upload (the estimator's rules).
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    // Dither is allowed by default and would make UNORM output content- and
    // driver-flavoured; the CPU path has no analogue.
    gl.disable(gl.DITHER);
    const prog = compileProgram(gl, VERT, WARP_FRAG);
    const texA = nearestTexture(gl);
    const texB = nearestTexture(gl);
    const flowTex = nearestTexture(gl);
    if (!prog || !texA || !texB || !flowTex) return null;
    return new GpuWarper(gl, glCanvas, prog, texA, texB, flowTex);
  }

  /**
   * Warp-and-blend `a`/`b` at weight `t` into this warper's canvas and return
   * it, or null on any GPU trouble (the caller's CPU warp is the fallback).
   *
   * The returned canvas is the live drawing buffer: drawImage it into the
   * destination BEFORE yielding to the event loop (no preserveDrawingBuffer),
   * and before the next `warp` call overwrites it.
   */
  warp(
    pairKey: string,
    a: HTMLCanvasElement,
    b: HTMLCanvasElement,
    w: number,
    h: number,
    flow: FlowField,
    flowScaleX: number,
    flowScaleY: number,
    t: number,
  ): HTMLCanvasElement | null {
    if (this.dead) return null;
    const gl = this.gl;
    if (gl.isContextLost()) {
      this.dead = true;
      return null;
    }
    try {
      if (this.glCanvas.width !== w || this.glCanvas.height !== h) {
        this.glCanvas.width = w;
        this.glCanvas.height = h;
        // The driver may cap the drawing buffer below what we asked for; a
        // warp rendered at the wrong size is worse than the CPU fallback.
        if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) return null;
      }
      if (this.framePairKey !== pairKey || this.frameW !== w || this.frameH !== h) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texA);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texB);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b);
        this.framePairKey = pairKey;
        this.frameW = w;
        this.frameH = h;
      }
      if (this.flowRef !== flow) {
        const n = flow.cols * flow.rows;
        if (this.flowScratch.length < n * 2) this.flowScratch = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          this.flowScratch[i * 2] = flow.dx[i]!;
          this.flowScratch[i * 2 + 1] = flow.dy[i]!;
        }
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RG32F, flow.cols, flow.rows, 0, gl.RG, gl.FLOAT,
          this.flowScratch.subarray(0, n * 2),
        );
        this.flowRef = flow;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texA);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texB);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
      gl.uniform1i(this.uA, 0);
      gl.uniform1i(this.uB, 1);
      gl.uniform1i(this.uFlow, 2);
      gl.uniform2i(this.uSize, w, h);
      gl.uniform2i(this.uGrid, flow.cols, flow.rows);
      gl.uniform1f(this.uStep, flow.step);
      gl.uniform2f(this.uInvScale, 1 / flowScaleX, 1 / flowScaleY);
      gl.uniform2f(this.uScale, flowScaleX, flowScaleY);
      gl.uniform1f(this.uT, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (gl.getError() !== gl.NO_ERROR) return null;
      return this.glCanvas;
    } catch {
      return null;
    }
  }

  /** The drawing buffer as top-down non-premultiplied RGBA — the self-check's
   *  comparison surface (and the benchmark's). Valid right after `warp`. */
  readBack(w: number, h: number): Uint8ClampedArray | null {
    const gl = this.gl;
    try {
      const bottomUp = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
      if (gl.getError() !== gl.NO_ERROR) return null;
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        out.set(bottomUp.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      }
      return out;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.dead = true;
    const gl = this.gl;
    try {
      for (const tex of [this.texA, this.texB, this.flowTex]) gl.deleteTexture(tex);
      gl.deleteProgram(this.prog);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* releasing a lost context is fine */
    }
  }
}

/** Deterministic band-limited RGBA pattern — the estimator self-check's
 *  shape. Opaque on purpose: decoded video is opaque, and semi-transparent
 *  bytes round-trip a 2d canvas's premultiplied storage differently than a
 *  texture upload does, which would smear the tolerance without testing
 *  anything the real path exercises. */
function checkPattern(w: number, h: number, shiftX: number, shiftY: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - shiftX;
      const sy = y - shiftY;
      const o = (y * w + x) * 4;
      data[o] = 128 + 60 * Math.sin(sx * 0.31) * Math.cos(sy * 0.23) + 40 * Math.sin((sx + sy) * 0.11);
      data[o + 1] = 128 + 70 * Math.cos(sx * 0.17) * Math.sin(sy * 0.29) + 30 * Math.cos((sx - sy) * 0.13);
      data[o + 2] = 128 + 50 * Math.sin(sx * 0.23 + sy * 0.19);
      data[o + 3] = 255;
    }
  }
  return data;
}

/** A synthetic FlowField with smooth non-zero vectors everywhere — built
 *  directly rather than estimated, so the check exercises the warp's grid
 *  mapping (including a non-unit flow scale) independent of the estimator. */
function checkFlow(cols: number, rows: number, step: number): FlowField {
  const dx = new Float32Array(cols * rows);
  const dy = new Float32Array(cols * rows);
  const valid = new Uint8Array(cols * rows).fill(1);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      dx[gy * cols + gx] = 3 * Math.sin(gx * 0.7) * Math.cos(gy * 0.5);
      dy[gy * cols + gx] = 2.5 * Math.cos(gx * 0.4 + gy * 0.6);
    }
  }
  return { cols, rows, step, dx, dy, valid };
}

/**
 * The session gate: warp a synthetic pair on both backends and require the
 * GPU within `SELF_CHECK_TOLERANCE` of the CPU (mapping, clamps and blend are
 * the same math) AND two GPU runs bit-identical (the GPU run is itself
 * deterministic). The flow is synthetic and everywhere non-zero, at a
 * non-unit flow scale — a flipped axis or misplaced grid lookup misses by
 * tens of counts and cannot sneak through.
 */
function selfCheck(warper: GpuWarper): boolean {
  const W = 96;
  const H = 96;
  const FLOW_SCALE = 2; // flow raster "48×48": exercises uScale/uInvScale
  const flow = checkFlow(12, 12, 4);
  const mk = (px: Uint8ClampedArray): HTMLCanvasElement | null => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(W, H);
    img.data.set(px);
    ctx.putImageData(img, 0, 0);
    return canvas;
  };
  const a = mk(checkPattern(W, H, 0, 0));
  const b = mk(checkPattern(W, H, 3, -2));
  if (!a || !b) return false;
  const da = a.getContext('2d')?.getImageData(0, 0, W, H);
  const db = b.getContext('2d')?.getImageData(0, 0, W, H);
  if (!da || !db) return false;
  for (const t of [0.25, 0.5]) {
    const cpu = new Uint8ClampedArray(W * H * 4);
    warpBlend(da.data, db.data, W, H, flow, FLOW_SCALE, FLOW_SCALE, t, cpu);
    let first: Uint8ClampedArray | null = null;
    for (let run = 0; run < 2; run++) {
      // Distinct pairKeys so BOTH runs take the full upload path — the
      // determinism claim covers upload + draw, not just a cached redraw.
      if (!warper.warp(`warp-check-${t}-${run}`, a, b, W, H, flow, FLOW_SCALE, FLOW_SCALE, t)) return false;
      const gpu = warper.readBack(W, H);
      if (!gpu) return false;
      if (first) {
        for (let i = 0; i < gpu.length; i++) if (gpu[i] !== first[i]) return false;
      } else {
        first = gpu;
        for (let i = 0; i < gpu.length; i++) {
          if (Math.abs(gpu[i]! - cpu[i]!) > SELF_CHECK_TOLERANCE) return false;
        }
      }
    }
  }
  return true;
}

/** undefined = not yet probed; null = probed and unavailable for the session. */
let singleton: GpuWarper | null | undefined;

/**
 * The process-wide warper, or null where the GPU warp is unavailable or
 * failed its self-check. Decided ONCE per session — the whole point: every
 * frame the session renders (preview and export) warps on the same backend,
 * so the two backends' small float differences can never appear as a
 * preview/export mismatch.
 */
export function getGpuWarper(): GpuWarper | null {
  if (singleton !== undefined) return singleton;
  singleton = null;
  try {
    const warper = GpuWarper.tryCreate();
    if (warper) {
      if (selfCheck(warper)) singleton = warper;
      else warper.dispose();
    }
  } catch {
    singleton = null;
  }
  return singleton;
}

/** Test seam: forget the probed warper so the next call re-probes. */
export function resetGpuWarperForTests(): void {
  try {
    singleton?.dispose();
  } catch {
    /* already lost */
  }
  singleton = undefined;
}
