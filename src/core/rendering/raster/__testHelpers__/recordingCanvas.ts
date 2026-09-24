/**
 * A recording 2D canvas for the native cross-engine fixtures (plan E3/E4).
 *
 * Painters that take a `CanvasRenderingContext2D` run on it unchanged; every
 * call and property write is logged as one op of the harness recorder's
 * grammar (packages/render-tests/harness/rasterRecorder.ts), normalised the way
 * the C++ recording canvas (native/engine/tests/recording_canvas.hpp) writes
 * it: drawImage always with 9 arguments, arc / ellipse with their ccw flag,
 * fill with its rule, colours as `rgba(r,g,b,a)` (channels rounded and alpha
 * clamped as the canvas parses them), gradients emitted when first used with
 * their stops sorted by offset (as the canvas sorts them). It tracks the CTM,
 * the composite operation and the styles across save / restore, so getters
 * answer as a canvas would.
 *
 * ── Pixels (plan E4, the effect-chain fixture) ──────────────────────────────
 * Each canvas also holds straight RGBA8 pixels, so the CPU pixel passes of the
 * bake chain run on real data: `getImageData` / `putImageData` read and write
 * them (a put logs the FNV-1a 64 of its bytes), and the few composites the
 * chain itself issues — `fillRect` / `clearRect` with a colour and a 1:1
 * integer `drawImage`, at identity — are applied by a REFERENCE compositor
 * (`compositePixel`: premultiplied double arithmetic, round half up). That
 * model is not Chromium's Skia arithmetic; it exists so that a pixel pass after
 * a composite reads defined bytes on both engines. Everything else (paths,
 * gradients, text, filters, shadows, scaled or transformed images) leaves the
 * pixels unchanged, and the op log pins it.
 */

export type Op = unknown[];

interface Session { ops: Op[]; nextCanvas: number; nextGrad: number }
let session: Session = { ops: [], nextCanvas: 0, nextGrad: 0 };

/** Start a new program; returns its op log (filled as the painters draw). */
export function beginRecording(): Op[] {
  session = { ops: [], nextCanvas: 0, nextGrad: 0 };
  return session.ops;
}

/** FNV-1a 64 of a byte buffer, as a decimal string (the C++ recorder's `std::to_string`). */
export function fnv1a64(bytes: ArrayLike<number>): string {
  const P = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]! & 255)) * P) & MASK;
  return h.toString();
}

/** Canonical colour: rgba(r,g,b,a) with JS number formatting. */
export function canonColor(s: string): string {
  const t = s.trim().toLowerCase();
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    const h = m[1]!;
    const x = (i: number, n: number): number => parseInt(h.slice(i, i + n), 16);
    if (h.length === 3 || h.length === 4) {
      return `rgba(${x(0, 1) * 17},${x(1, 1) * 17},${x(2, 1) * 17},${h.length === 4 ? (x(3, 1) * 17) / 255 : 1})`;
    }
    return `rgba(${x(0, 2)},${x(2, 2)},${x(4, 2)},${h.length === 8 ? x(6, 2) / 255 : 1})`;
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const p = m[1]!.split(',').map((v) => Number(v.trim()));
    const ch = (v: number): number => Math.round(clamp(v, 0, 255));
    return `rgba(${ch(p[0]!)},${ch(p[1]!)},${ch(p[2]!)},${clamp(p[3] ?? 1, 0, 1)})`;
  }
  throw new Error(`fixture colour not canonicalisable: ${s}`);
}

/** Composite operations the reference compositor models; the others leave the pixels alone. */
const MODELED = new Set(['source-over', 'destination-in', 'destination-out', 'source-atop', 'source-in', 'lighter', 'copy']);
/** Operations that also clear the destination OUTSIDE the drawn rectangle (Canvas2D). */
const UNBOUNDED = new Set(['destination-in', 'source-in', 'copy']);
const round8 = (v: number): number => {
  const r = Math.floor(v * 255 + 0.5);
  return r < 0 ? 0 : r > 255 ? 255 : r;
};

/**
 * One pixel of the reference compositor: straight source colour `sr, sg, sb`
 * (0..255) at straight alpha `as` (0..1, global alpha folded in) onto the
 * straight RGBA8 destination at `d[i]`. Mirrored by recording_canvas.hpp.
 */
function compositePixel(d: Uint8ClampedArray, i: number, sr: number, sg: number, sb: number, as: number, op: string): void {
  const ad = d[i + 3]! / 255;
  const s0 = (sr / 255) * as; const s1 = (sg / 255) * as; const s2 = (sb / 255) * as;
  const d0 = (d[i]! / 255) * ad; const d1 = (d[i + 1]! / 255) * ad; const d2 = (d[i + 2]! / 255) * ad;
  let ao: number; let c0: number; let c1: number; let c2: number;
  switch (op) {
    case 'source-over': ao = as + ad * (1 - as); c0 = s0 + d0 * (1 - as); c1 = s1 + d1 * (1 - as); c2 = s2 + d2 * (1 - as); break;
    case 'destination-in': ao = ad * as; c0 = d0 * as; c1 = d1 * as; c2 = d2 * as; break;
    case 'destination-out': ao = ad * (1 - as); c0 = d0 * (1 - as); c1 = d1 * (1 - as); c2 = d2 * (1 - as); break;
    case 'source-atop': ao = ad; c0 = s0 * ad + d0 * (1 - as); c1 = s1 * ad + d1 * (1 - as); c2 = s2 * ad + d2 * (1 - as); break;
    case 'source-in': ao = as * ad; c0 = s0 * ad; c1 = s1 * ad; c2 = s2 * ad; break;
    case 'lighter': ao = Math.min(1, as + ad); c0 = Math.min(1, s0 + d0); c1 = Math.min(1, s1 + d1); c2 = Math.min(1, s2 + d2); break;
    default: ao = as; c0 = s0; c1 = s1; c2 = s2; break; // copy
  }
  const a8 = round8(ao);
  if (a8 === 0) {
    d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
    return;
  }
  d[i] = round8(c0 / ao); d[i + 1] = round8(c1 / ao); d[i + 2] = round8(c2 / ao); d[i + 3] = a8;
}

/** A Path2D that records its commands (jsdom has none); `fill(path, rule)` logs them. */
export class RecordingPath2D {
  readonly cmds: unknown[][] = [];
  moveTo(x: number, y: number): void { this.cmds.push(['moveTo', x, y]); }
  lineTo(x: number, y: number): void { this.cmds.push(['lineTo', x, y]); }
  quadraticCurveTo(a: number, b: number, x: number, y: number): void { this.cmds.push(['quadraticCurveTo', a, b, x, y]); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
    this.cmds.push(['bezierCurveTo', a, b, c, d, x, y]);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.cmds.push(['arc', x, y, r, a0, a1, ccw]); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
    this.cmds.push(['ellipse', x, y, rx, ry, rot, a0, a1, ccw]);
  }
  rect(x: number, y: number, w: number, h: number): void { this.cmds.push(['rect', x, y, w, h]); }
  closePath(): void { this.cmds.push(['closePath']); }
}

/** The ImageData the recorder hands out (jsdom has none). */
export interface RecordedImageData { width: number; height: number; data: Uint8ClampedArray }

class FakeGradient {
  private id = -1;
  private stops: Array<[number, string]> = [];
  constructor(private readonly canvasId: number, private readonly kind: string, private readonly args: number[]) {}
  addColorStop(offset: number, color: string): void {
    this.stops.push([offset, canonColor(color)]);
  }
  /** The style value; emits the gradient and its (stably sorted) stops on first use. */
  ref(): { $g: number } {
    if (this.id < 0) {
      this.id = session.nextGrad++;
      session.ops.push([this.canvasId, 'grad', this.id, this.kind, ...this.args]);
      const sorted = this.stops.map((s, i) => [s, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]);
      for (const [[offset, color]] of sorted) session.ops.push([-1, 'stop', this.id, offset, color]);
    }
    return { $g: this.id };
  }
}

type M = [number, number, number, number, number, number];
interface Saved { m: M; fill: unknown; stroke: unknown; gco: string; alpha: number }

export class RecordingContext {
  private m: M = [1, 0, 0, 1, 0, 0];
  private stack: Saved[] = [];
  private fill_: unknown = '#000';
  private stroke_: unknown = '#000';
  private gco_ = 'source-over';
  private alpha_ = 1;
  constructor(readonly canvas: RecordingCanvas) {}
  private get id(): number { return this.canvas.id(); }
  private call(name: string, ...args: unknown[]): void { session.ops.push([this.id, 'call', name, ...args]); }
  private set(name: string, v: unknown): void { session.ops.push([this.id, 'set', name, v]); }
  private style(v: unknown): unknown { return v instanceof FakeGradient ? v.ref() : canonColor(String(v)); }

  save(): void {
    this.stack.push({ m: [...this.m] as M, fill: this.fill_, stroke: this.stroke_, gco: this.gco_, alpha: this.alpha_ });
    this.call('save');
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) { this.m = s.m; this.fill_ = s.fill; this.stroke_ = s.stroke; this.gco_ = s.gco; this.alpha_ = s.alpha; }
    this.call('restore');
  }
  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a, b, c, d, a * x + c * y + e, b * x + d * y + f];
    this.call('translate', x, y);
  }
  scale(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * x, b * x, c * y, d * y, e, f];
    this.call('scale', x, y);
  }
  rotate(t: number): void {
    const [a, b, c, d, e, f] = this.m;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    this.m = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin, e, f];
    this.call('rotate', t);
  }
  setTransform(a: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    this.m = typeof a === 'number' ? [a, b!, c!, d!, e!, f!] : [a.a, a.b, a.c, a.d, a.e, a.f];
    this.call('setTransform', ...this.m);
  }
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    const [a, b, c, d, e, f] = this.m;
    return { a, b, c, d, e, f };
  }
  set fillStyle(v: unknown) { this.fill_ = v; this.set('fillStyle', this.style(v)); }
  get fillStyle(): unknown { return this.fill_; }
  set strokeStyle(v: unknown) { this.stroke_ = v; this.set('strokeStyle', this.style(v)); }
  get strokeStyle(): unknown { return this.stroke_; }
  set lineWidth(v: number) { this.set('lineWidth', v); }
  set lineCap(v: string) { this.set('lineCap', v); }
  set lineJoin(v: string) { this.set('lineJoin', v); }
  set globalAlpha(v: number) { this.alpha_ = v; this.set('globalAlpha', v); }
  get globalAlpha(): number { return this.alpha_; }
  set globalCompositeOperation(v: string) { this.gco_ = v; this.set('globalCompositeOperation', v); }
  get globalCompositeOperation(): string { return this.gco_; }
  set filter(v: string) { this.set('filter', v); }
  set imageSmoothingEnabled(v: boolean) { this.set('imageSmoothingEnabled', v); }
  set shadowColor(v: string) { this.set('shadowColor', canonColor(v)); }
  set shadowBlur(v: number) { this.set('shadowBlur', v); }
  set shadowOffsetX(v: number) { this.set('shadowOffsetX', v); }
  set shadowOffsetY(v: number) { this.set('shadowOffsetY', v); }
  beginPath(): void { this.call('beginPath'); }
  closePath(): void { this.call('closePath'); }
  moveTo(x: number, y: number): void { this.call('moveTo', x, y); }
  lineTo(x: number, y: number): void { this.call('lineTo', x, y); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.call('arc', x, y, r, a0, a1, ccw); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
    this.call('ellipse', x, y, rx, ry, rot, a0, a1, ccw);
  }
  fill(a: string | RecordingPath2D = 'nonzero', rule: string = 'nonzero'): void {
    if (a instanceof RecordingPath2D) this.call('fillPath2D', rule, a.cmds);
    else this.call('fill', a);
  }
  stroke(): void { this.call('stroke'); }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.call('fillRect', x, y, w, h);
    if (typeof this.fill_ !== 'string' || !this.identity() || !MODELED.has(this.gco_)) return;
    const [r, g, b, a] = canonColor(this.fill_).slice(5, -1).split(',').map(Number) as [number, number, number, number];
    const op = this.gco_;
    const as = a * this.alpha_;
    this.visitRect(x, y, w, h, !UNBOUNDED.has(op), (d, i, inside) => {
      if (inside) compositePixel(d, i, r, g, b, as, op);
      else compositePixel(d, i, 0, 0, 0, 0, op);
    });
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.call('clearRect', x, y, w, h);
    if (!this.identity()) return;
    this.visitRect(x, y, w, h, true, (d, i) => {
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
    });
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): FakeGradient {
    return new FakeGradient(this.id, 'radial', [x0, y0, r0, x1, y1, r1]);
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): FakeGradient {
    return new FakeGradient(this.id, 'linear', [x0, y0, x1, y1]);
  }
  createImageData(w: number, h: number): RecordedImageData {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  getImageData(x: number, y: number, w: number, h: number): RecordedImageData {
    this.call('getImageData', x, y, w, h);
    const out = this.createImageData(w, h);
    const px = this.canvas.pixels();
    const cw = this.canvas.width; const ch = this.canvas.height;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const sx = x + i; const sy = y + j;
        if (sx < 0 || sy < 0 || sx >= cw || sy >= ch) continue;
        const s = (sy * cw + sx) * 4; const o = (j * w + i) * 4;
        out.data[o] = px[s]!; out.data[o + 1] = px[s + 1]!; out.data[o + 2] = px[s + 2]!; out.data[o + 3] = px[s + 3]!;
      }
    }
    return out;
  }
  putImageData(img: RecordedImageData, x: number, y: number): void {
    this.call('putImageData', fnv1a64(img.data), img.width, img.height, x, y);
    const px = this.canvas.pixels();
    const cw = this.canvas.width; const ch = this.canvas.height;
    for (let j = 0; j < img.height; j++) {
      for (let i = 0; i < img.width; i++) {
        const dx = x + i; const dy = y + j;
        if (dx < 0 || dy < 0 || dx >= cw || dy >= ch) continue;
        const o = (dy * cw + dx) * 4; const s = (j * img.width + i) * 4;
        px[o] = img.data[s]!; px[o + 1] = img.data[s + 1]!; px[o + 2] = img.data[s + 2]!; px[o + 3] = img.data[s + 3]!;
      }
    }
  }
  drawImage(img: RecordingCanvas, ...a: number[]): void {
    const src = { $c: img.id() };
    const args = a.length === 2 ? [0, 0, img.width, img.height, a[0]!, a[1]!, img.width, img.height]
      : a.length === 4 ? [0, 0, img.width, img.height, a[0]!, a[1]!, a[2]!, a[3]!]
        : a;
    this.call('drawImage', src, ...args);
    // The model: a 1:1 integer blit at identity (the chain's snapshots,
    // composites and CSS flush). Scaled / transformed draws leave the pixels.
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args as [number, number, number, number, number, number, number, number];
    if (!this.identity() || !MODELED.has(this.gco_) || sw !== dw || sh !== dh) return;
    if (![sx, sy, sw, sh, dx, dy].every(Number.isInteger)) return;
    const sp = img.pixels();
    const iw = img.width; const ih = img.height;
    const cw = this.canvas.width;
    const op = this.gco_;
    const ga = this.alpha_;
    this.visitRect(dx, dy, dw, dh, !UNBOUNDED.has(op), (d, i, inside) => {
      const p = i / 4; const qx = p % cw; const qy = (p - qx) / cw;
      const ux = qx - dx + sx; const uy = qy - dy + sy;
      if (!inside || ux < sx || uy < sy || ux >= sx + sw || uy >= sy + sh || ux < 0 || uy < 0 || ux >= iw || uy >= ih) {
        compositePixel(d, i, 0, 0, 0, 0, op);
        return;
      }
      const s = (uy * iw + ux) * 4;
      compositePixel(d, i, sp[s]!, sp[s + 1]!, sp[s + 2]!, (sp[s + 3]! / 255) * ga, op);
    });
  }
  private identity(): boolean {
    const [a, b, c, d, e, f] = this.m;
    return a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
  }
  /**
   * Visit the pixels whose centres lie in [x, x + w) × [y, y + h) (`inside`),
   * and — unless `bounded` — every other pixel of the canvas too.
   */
  private visitRect(
    x: number, y: number, w: number, h: number, bounded: boolean,
    fn: (d: Uint8ClampedArray, i: number, inside: boolean) => void,
  ): void {
    const px = this.canvas.pixels();
    const cw = this.canvas.width; const ch = this.canvas.height;
    for (let py = 0; py < ch; py++) {
      for (let qx = 0; qx < cw; qx++) {
        const inside = qx + 0.5 >= x && qx + 0.5 < x + w && py + 0.5 >= y && py + 0.5 < y + h;
        if (inside || !bounded) fn(px, (py * cw + qx) * 4, inside);
      }
    }
  }
}

export class RecordingCanvas {
  private w = 300;
  private h = 150;
  private px: Uint8ClampedArray | null = null;
  private ctx: RecordingContext | null = null;
  private cid = -1;
  /** Setting a dimension clears the pixels, as on a canvas. */
  get width(): number { return this.w; }
  set width(v: number) { this.w = v; this.px = null; }
  get height(): number { return this.h; }
  set height(v: number) { this.h = v; this.px = null; }
  /** The straight RGBA8 pixels (the model; see the module header). */
  pixels(): Uint8ClampedArray {
    this.px ??= new Uint8ClampedArray(this.w * this.h * 4);
    return this.px;
  }
  private sess: Session | null = null;
  /**
   * The canvas's id in the CURRENT program. A canvas kept alive across
   * programs (a painter's module-level scratch pool) re-registers, blank, in
   * the next one — each program then reads as if it ran in a fresh realm,
   * which is what the C++ (a pool per bake) does.
   */
  id(): number {
    if (this.cid < 0 || this.sess !== session) {
      this.sess = session;
      this.px = null;
      this.cid = session.nextCanvas++;
      session.ops.push([this.cid, 'canvas', this.width, this.height]);
    }
    return this.cid;
  }
  getContext(): RecordingContext {
    this.id();
    this.ctx ??= new RecordingContext(this);
    return this.ctx;
  }
}

/** A root canvas of `w` × `h` and its context. */
export function recordingCanvas(w: number, h: number): { canvas: RecordingCanvas; ctx: RecordingContext } {
  const canvas = new RecordingCanvas();
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext() };
}

/** Run `fn` with `document.createElement('canvas')` returning recording canvases and `Path2D` recording its commands. */
export function withRecordingCanvases<T>(fn: () => T): T {
  const create = document.createElement.bind(document);
  const spy = jest.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    (tag === 'canvas' ? new RecordingCanvas() : create(tag))) as typeof document.createElement);
  const g = globalThis as { Path2D?: unknown };
  const hadPath2D = 'Path2D' in g;
  const prevPath2D = g.Path2D;
  g.Path2D = RecordingPath2D;
  try {
    return fn();
  } finally {
    spy.mockRestore();
    if (hadPath2D) g.Path2D = prevPath2D;
    else delete g.Path2D;
  }
}
