/**
 * Pixel Motion's flow search on the GPU — the integer twin of
 * `searchAllCells` in `pixelMotionFlow.ts`.
 *
 * ── Why this is allowed under the determinism constraint ────────────────────
 *
 * The header of `pixelMotionFlow.ts` bans nondeterministic GPU rasterization
 * from the estimation, not the GPU. This pass qualifies because nothing in it
 * rounds: luma is `77·R + 150·G + 29·B` in `int` (same formula as
 * `lumaIntOf`), SAD accumulates in `int`, the scan order is the same fixed
 * loop as the CPU search with the same strict less-than tie-breaking, and the
 * results leave the GPU as raw uint32s through RGBA32UI attachments — core
 * WebGL2, no float readback, no float-readback extension to be missing. The
 * float half (sub-pixel parabola, validity, 3×3 smoothing) runs on the CPU in
 * `finalizeFlow`, shared with the CPU path, on the exact integers read back.
 *
 * So on any conforming driver the two backends produce BIT-IDENTICAL
 * FlowFields — and we do not take the driver's word for it: `selfCheck` runs
 * both backends on a synthetic textured pair at init and requires exact
 * equality before the estimator is allowed to serve a real frame. A machine
 * that fails the check (or has no WebGL2 at all — jsdom, headless CI) uses
 * the CPU path for the whole session; because the fields are bit-equal
 * everywhere the check passes, preview and export can never disagree even if
 * a mid-session context loss drops one frame pair back to the CPU.
 *
 * ── Shape of the work ───────────────────────────────────────────────────────
 *
 * Pass 1 renders each scaled frame's integer luma into an R16UI texture (max
 * 255·256 = 65280 < 2¹⁶). Pass 2 draws ONE FRAGMENT PER GRID CELL (~48×27 at
 * the 384px operating point) and performs the full two-stage search for that
 * cell — ~130 SADs × 49 taps, embarrassingly parallel. The readback is two
 * grid-resolution RGBA32UI reads (~40 KB), not a full-res image: zero/best
 * SAD, biased winner, and the four parabola SADs per cell.
 */

import {
  finalizeFlow,
  lumaIntOf,
  computeFlow,
  resolveFlowOptions,
  SEARCH_STRIDE,
  type FlowField,
  type FlowOptions,
} from './pixelMotionFlow';

/** Winner displacements are small signed ints; RGBA32UI is unsigned. */
export const DISPLACEMENT_BIAS = 32768;

/**
 * Decode the two search attachments (4 uint32s per cell each) into a
 * FlowField via the shared `finalizeFlow`. Pure — unit-tested in jsdom by
 * feeding it a CPU-packed readback and requiring equality with `computeFlow`.
 */
export function flowFromSearchTexels(
  att0: Uint32Array,
  att1: Uint32Array,
  cols: number,
  rows: number,
  step: number,
  minImp: number,
): FlowField {
  const cells = cols * rows;
  const raw = new Float64Array(cells * SEARCH_STRIDE);
  for (let i = 0; i < cells; i++) {
    const o = i * SEARCH_STRIDE;
    const p = i * 4;
    raw[o] = att0[p]!; // zero SAD
    raw[o + 1] = att0[p + 1]!; // best SAD
    raw[o + 2] = att0[p + 2]! - DISPLACEMENT_BIAS; // bx
    raw[o + 3] = att0[p + 3]! - DISPLACEMENT_BIAS; // by
    raw[o + 4] = att1[p]!; // cxm
    raw[o + 5] = att1[p + 1]!; // cxp
    raw[o + 6] = att1[p + 2]!; // cym
    raw[o + 7] = att1[p + 3]!; // cyp
  }
  return finalizeFlow(raw, cols, rows, step, minImp);
}

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** RGBA8 frame → R16UI integer luma, the exact `lumaIntOf` formula. round()
 *  first: UNORM8→float→×255 recovers the byte exactly under round-to-nearest. */
const LUMA_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
out uvec4 oLum;
void main() {
  ivec3 c = ivec3(round(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb * 255.0));
  oLum = uvec4(uint(c.r * 77 + c.g * 150 + c.b * 29), 0u, 0u, 0u);
}`;

/**
 * The search kernel — a statement-for-statement mirror of `searchAllCells`
 * (same anchor rounding, same scan order, same strict `<`). Loop bounds are
 * uniforms, not #defines, so one program serves any FlowOptions and the
 * compiler cannot unroll the coarse scan into something enormous.
 */
const SEARCH_FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uLumA;
uniform usampler2D uLumB;
uniform ivec2 uSize;
uniform int uStep;
uniform int uBlockR;
uniform int uSearchR;
layout(location = 0) out uvec4 oMain;
layout(location = 1) out uvec4 oCurve;

int blockSad(ivec2 anchor, ivec2 d) {
  int sad = 0;
  for (int oy = -uBlockR; oy <= uBlockR; oy++) {
    int ya = clamp(anchor.y + oy, 0, uSize.y - 1);
    int yb = clamp(anchor.y + oy + d.y, 0, uSize.y - 1);
    for (int ox = -uBlockR; ox <= uBlockR; ox++) {
      int xa = clamp(anchor.x + ox, 0, uSize.x - 1);
      int xb = clamp(anchor.x + ox + d.x, 0, uSize.x - 1);
      sad += abs(int(texelFetch(uLumA, ivec2(xa, ya), 0).r) - int(texelFetch(uLumB, ivec2(xb, yb), 0).r));
    }
  }
  return sad;
}

void main() {
  ivec2 g = ivec2(gl_FragCoord.xy);
  // Math.round((g + 0.5) * step) in exact integers: (2g+1)·step is ≥ 0, so
  // +1 then truncating-divide by 2 is round-half-up, which is what JS
  // Math.round does for positive halves.
  ivec2 anchor = min(uSize - 1, ((2 * g + 1) * uStep + 1) / 2);
  int zero = blockSad(anchor, ivec2(0));
  int best = zero;
  ivec2 bd = ivec2(0);
  for (int oy = -uSearchR; oy <= uSearchR; oy += 2) {
    for (int ox = -uSearchR; ox <= uSearchR; ox += 2) {
      if (ox == 0 && oy == 0) continue;
      int sad = blockSad(anchor, ivec2(ox, oy));
      if (sad < best) { best = sad; bd = ivec2(ox, oy); }
    }
  }
  ivec2 c = bd;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      if (ox == 0 && oy == 0) continue;
      int sad = blockSad(anchor, c + ivec2(ox, oy));
      if (sad < best) { best = sad; bd = c + ivec2(ox, oy); }
    }
  }
  // Parabola SADs are computed unconditionally (a fragment cannot cheaply
  // abstain); finalizeFlow only reads them for cells that pass the
  // improvement test, so this cannot diverge from the CPU search.
  int cxm = blockSad(anchor, bd + ivec2(-1, 0));
  int cxp = blockSad(anchor, bd + ivec2(1, 0));
  int cym = blockSad(anchor, bd + ivec2(0, -1));
  int cyp = blockSad(anchor, bd + ivec2(0, 1));
  oMain = uvec4(uint(zero), uint(best), uint(bd.x + ${DISPLACEMENT_BIAS}), uint(bd.y + ${DISPLACEMENT_BIAS}));
  oCurve = uvec4(uint(cxm), uint(cxp), uint(cym), uint(cyp));
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

function intTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** One WebGL2 flow estimator. Construct via `getGpuFlowEstimator` — the
 *  factory owns the self-check and the process-wide singleton. */
export class GpuFlowEstimator {
  private gl: WebGL2RenderingContext;
  private scaleCanvas: HTMLCanvasElement;
  private scaleCtx: CanvasRenderingContext2D;
  private lumaProg: WebGLProgram;
  private searchProg: WebGLProgram;
  private uLumaSrc: WebGLUniformLocation | null;
  private uLumA: WebGLUniformLocation | null;
  private uLumB: WebGLUniformLocation | null;
  private uSize: WebGLUniformLocation | null;
  private uStep: WebGLUniformLocation | null;
  private uBlockR: WebGLUniformLocation | null;
  private uSearchR: WebGLUniformLocation | null;
  private srcTex: WebGLTexture;
  private lumATex: WebGLTexture;
  private lumBTex: WebGLTexture;
  private att0Tex: WebGLTexture;
  private att1Tex: WebGLTexture;
  private lumaFbo: WebGLFramebuffer;
  private searchFbo: WebGLFramebuffer;
  private texW = 0;
  private texH = 0;
  private gridW = 0;
  private gridH = 0;
  private dead = false;

  private constructor(
    gl: WebGL2RenderingContext,
    glCanvas: HTMLCanvasElement,
    scaleCanvas: HTMLCanvasElement,
    scaleCtx: CanvasRenderingContext2D,
    lumaProg: WebGLProgram,
    searchProg: WebGLProgram,
    srcTex: WebGLTexture,
    lumATex: WebGLTexture,
    lumBTex: WebGLTexture,
    att0Tex: WebGLTexture,
    att1Tex: WebGLTexture,
    lumaFbo: WebGLFramebuffer,
    searchFbo: WebGLFramebuffer,
  ) {
    this.gl = gl;
    this.scaleCanvas = scaleCanvas;
    this.scaleCtx = scaleCtx;
    this.lumaProg = lumaProg;
    this.searchProg = searchProg;
    this.uLumaSrc = gl.getUniformLocation(lumaProg, 'uSrc');
    this.uLumA = gl.getUniformLocation(searchProg, 'uLumA');
    this.uLumB = gl.getUniformLocation(searchProg, 'uLumB');
    this.uSize = gl.getUniformLocation(searchProg, 'uSize');
    this.uStep = gl.getUniformLocation(searchProg, 'uStep');
    this.uBlockR = gl.getUniformLocation(searchProg, 'uBlockR');
    this.uSearchR = gl.getUniformLocation(searchProg, 'uSearchR');
    this.srcTex = srcTex;
    this.lumATex = lumATex;
    this.lumBTex = lumBTex;
    this.att0Tex = att0Tex;
    this.att1Tex = att1Tex;
    this.lumaFbo = lumaFbo;
    this.searchFbo = searchFbo;
    // Context loss makes every subsequent call a silent no-op and the
    // readback all-zeros — mark dead instead so callers fall to the CPU
    // (bit-equal, so nothing visible changes).
    glCanvas.addEventListener('webglcontextlost', () => {
      this.dead = true;
    });
  }

  static tryCreate(): GpuFlowEstimator | null {
    if (typeof document === 'undefined') return null;
    const glCanvas = document.createElement('canvas');
    glCanvas.width = 1;
    glCanvas.height = 1;
    const gl = glCanvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl || typeof gl.createTexture !== 'function') return null;
    const scaleCanvas = document.createElement('canvas');
    const scaleCtx = scaleCanvas.getContext('2d');
    if (!scaleCtx) return null;
    // Exact byte parity with the CPU path's getImageData: no premultiply, no
    // flip, and above all no colour-space conversion on upload.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const lumaProg = compileProgram(gl, VERT, LUMA_FRAG);
    const searchProg = compileProgram(gl, VERT, SEARCH_FRAG);
    const srcTex = intTexture(gl);
    const lumATex = intTexture(gl);
    const lumBTex = intTexture(gl);
    const att0Tex = intTexture(gl);
    const att1Tex = intTexture(gl);
    const lumaFbo = gl.createFramebuffer();
    const searchFbo = gl.createFramebuffer();
    if (!lumaProg || !searchProg || !srcTex || !lumATex || !lumBTex || !att0Tex || !att1Tex || !lumaFbo || !searchFbo) {
      return null;
    }
    return new GpuFlowEstimator(
      gl, glCanvas, scaleCanvas, scaleCtx,
      lumaProg, searchProg, srcTex, lumATex, lumBTex, att0Tex, att1Tex, lumaFbo, searchFbo,
    );
  }

  /** Allocate (or reallocate) the size-dependent textures. */
  private ensureSizes(fw: number, fh: number, cols: number, rows: number): void {
    const gl = this.gl;
    if (fw !== this.texW || fh !== this.texH) {
      for (const tex of [this.lumATex, this.lumBTex]) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, fw, fh, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
      }
      this.texW = fw;
      this.texH = fh;
    }
    if (cols !== this.gridW || rows !== this.gridH) {
      for (const tex of [this.att0Tex, this.att1Tex]) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, cols, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.searchFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.att0Tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.att1Tex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      this.gridW = cols;
      this.gridH = rows;
    }
  }

  /** Scale one source frame into the estimation raster and render its
   *  integer luma into `target`. Same drawImage the CPU path scales with. */
  private lumaPass(src: HTMLCanvasElement, target: WebGLTexture, fw: number, fh: number): void {
    const gl = this.gl;
    this.scaleCtx.clearRect(0, 0, fw, fh);
    this.scaleCtx.drawImage(src, 0, 0, fw, fh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scaleCanvas);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lumaFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, fw, fh);
    gl.useProgram(this.lumaProg);
    gl.uniform1i(this.uLumaSrc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Flow a→b at the given estimation size, or null on any GPU trouble (the
   * caller's CPU path is bit-equal, so null is safe at any moment). `a` and
   * `b` are the FULL-RES bracket canvases; scaling to (fw,fh) happens here,
   * with the same drawImage the CPU fallback uses.
   */
  compute(
    a: HTMLCanvasElement,
    b: HTMLCanvasElement,
    fw: number,
    fh: number,
    opts: FlowOptions = {},
  ): FlowField | null {
    if (this.dead) return null;
    const gl = this.gl;
    if (gl.isContextLost()) {
      this.dead = true;
      return null;
    }
    const { step, r, s, minImp } = resolveFlowOptions(opts);
    const cols = Math.max(1, Math.floor(fw / step));
    const rows = Math.max(1, Math.floor(fh / step));
    try {
      if (this.scaleCanvas.width !== fw || this.scaleCanvas.height !== fh) {
        this.scaleCanvas.width = fw;
        this.scaleCanvas.height = fh;
      }
      this.ensureSizes(fw, fh, cols, rows);
      this.lumaPass(a, this.lumATex, fw, fh);
      this.lumaPass(b, this.lumBTex, fw, fh);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.searchFbo);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
      gl.viewport(0, 0, cols, rows);
      gl.useProgram(this.searchProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lumATex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lumBTex);
      gl.uniform1i(this.uLumA, 0);
      gl.uniform1i(this.uLumB, 1);
      gl.uniform2i(this.uSize, fw, fh);
      gl.uniform1i(this.uStep, step);
      gl.uniform1i(this.uBlockR, r);
      gl.uniform1i(this.uSearchR, s);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const att0 = new Uint32Array(cols * rows * 4);
      const att1 = new Uint32Array(cols * rows * 4);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, cols, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, att0);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(0, 0, cols, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, att1);
      if (gl.getError() !== gl.NO_ERROR) return null;
      return flowFromSearchTexels(att0, att1, cols, rows, step, minImp);
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.dead = true;
    const gl = this.gl;
    try {
      for (const tex of [this.srcTex, this.lumATex, this.lumBTex, this.att0Tex, this.att1Tex]) gl.deleteTexture(tex);
      gl.deleteFramebuffer(this.lumaFbo);
      gl.deleteFramebuffer(this.searchFbo);
      gl.deleteProgram(this.lumaProg);
      gl.deleteProgram(this.searchProg);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* releasing a lost context is fine */
    }
  }
}

/** Deterministic BAND-LIMITED RGBA pattern for the self-check — a fixed sum
 *  of sinusoids (no Math.random, no time; same engine evaluates both
 *  backends' inputs, so `Math.sin` is a constant of the check), with distinct
 *  channels so all three luma weights are exercised. Band-limited matters:
 *  the coarse even-offset search stage cannot lock onto per-pixel noise, by
 *  design — the caveat documented on `searchAllCells`. `shiftX/shiftY` move
 *  the content so the check exercises real, non-zero winners. */
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

/**
 * The bit-equality gate: run both backends on a synthetic pair (through the
 * SAME canvas-upload path real frames take, so byte-parity of the upload is
 * covered too) and require the fields identical, twice (determinism of the
 * GPU run itself). Any deviation disqualifies the GPU for the session.
 */
function selfCheck(est: GpuFlowEstimator): boolean {
  const W = 96;
  const H = 96;
  const mk = (px: Uint8ClampedArray): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(W, H);
    img.data.set(px);
    ctx.putImageData(img, 0, 0);
    return { canvas, ctx };
  };
  const sa = mk(checkPattern(W, H, 0, 0));
  const sb = mk(checkPattern(W, H, 3, -2));
  if (!sa || !sb) return false;
  const cpu = computeFlow(
    lumaIntOf(sa.ctx.getImageData(0, 0, W, H).data, W, H),
    lumaIntOf(sb.ctx.getImageData(0, 0, W, H).data, W, H),
    W, H,
  );
  for (let run = 0; run < 2; run++) {
    const gpu = est.compute(sa.canvas, sb.canvas, W, H);
    if (!gpu || gpu.cols !== cpu.cols || gpu.rows !== cpu.rows) return false;
    for (let i = 0; i < cpu.dx.length; i++) {
      if (gpu.dx[i] !== cpu.dx[i] || gpu.dy[i] !== cpu.dy[i] || gpu.valid[i] !== cpu.valid[i]) return false;
    }
  }
  // The pattern is textured and genuinely shifted — a check that passed on
  // all-abstain output would prove nothing.
  let moved = 0;
  for (let i = 0; i < cpu.valid.length; i++) if (cpu.valid[i]) moved++;
  return moved > cpu.valid.length / 2;
}

/** undefined = not yet probed; null = probed and unavailable for the session. */
let singleton: GpuFlowEstimator | null | undefined;

/**
 * The process-wide estimator, or null where the GPU path is unavailable or
 * failed its bit-equality self-check. Decided ONCE per session — path
 * selection must not flap per-call, so preview and export inside one session
 * always estimate the same way (and even a flap would be invisible: the
 * self-check proved the fields identical).
 */
export function getGpuFlowEstimator(): GpuFlowEstimator | null {
  if (singleton !== undefined) return singleton;
  singleton = null;
  try {
    const est = GpuFlowEstimator.tryCreate();
    if (est) {
      if (selfCheck(est)) singleton = est;
      else est.dispose();
    }
  } catch {
    singleton = null;
  }
  return singleton;
}

/** Test seam: forget the probed estimator so the next call re-probes. */
export function resetGpuFlowEstimatorForTests(): void {
  try {
    singleton?.dispose();
  } catch {
    /* already lost */
  }
  singleton = undefined;
}
