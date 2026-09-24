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
 */

export type Op = unknown[];

interface Session { ops: Op[]; nextCanvas: number; nextGrad: number }
let session: Session = { ops: [], nextCanvas: 0, nextGrad: 0 };

/** Start a new program; returns its op log (filled as the painters draw). */
export function beginRecording(): Op[] {
  session = { ops: [], nextCanvas: 0, nextGrad: 0 };
  return session.ops;
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
  fill(rule: string = 'nonzero'): void { this.call('fill', rule); }
  stroke(): void { this.call('stroke'); }
  fillRect(x: number, y: number, w: number, h: number): void { this.call('fillRect', x, y, w, h); }
  clearRect(x: number, y: number, w: number, h: number): void { this.call('clearRect', x, y, w, h); }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): FakeGradient {
    return new FakeGradient(this.id, 'radial', [x0, y0, r0, x1, y1, r1]);
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): FakeGradient {
    return new FakeGradient(this.id, 'linear', [x0, y0, x1, y1]);
  }
  drawImage(img: RecordingCanvas, ...a: number[]): void {
    const src = { $c: img.id() };
    if (a.length === 2) this.call('drawImage', src, 0, 0, img.width, img.height, a[0], a[1], img.width, img.height);
    else if (a.length === 4) this.call('drawImage', src, 0, 0, img.width, img.height, a[0], a[1], a[2], a[3]);
    else this.call('drawImage', src, ...a);
  }
}

export class RecordingCanvas {
  width = 300;
  height = 150;
  private ctx: RecordingContext | null = null;
  private cid = -1;
  id(): number {
    if (this.cid < 0) {
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

/** Run `fn` with `document.createElement('canvas')` returning recording canvases. */
export function withRecordingCanvases<T>(fn: () => T): T {
  const create = document.createElement.bind(document);
  const spy = jest.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    (tag === 'canvas' ? new RecordingCanvas() : create(tag))) as typeof document.createElement);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}
