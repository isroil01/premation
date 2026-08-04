import '@testing-library/jest-dom';

// jsdom (older versions) lacks structuredClone, which some stores use at import
// time. Provide a JSON-based polyfill for the test environment only.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
}

// jsdom doesn't expose TextEncoder/TextDecoder globally; the zip writer needs
// them. Bridge Node's implementations for the test environment.
 
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = NodeTextEncoder as typeof globalThis.TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = NodeTextDecoder as unknown as typeof globalThis.TextDecoder;
}

// ── PointerEvent ──────────────────────────────────────────────────────
//
// jsdom ships NO PointerEvent class. testing-library's `fireEvent.pointerDown`
// et al then fall back to a generic Event, which carries no clientX/clientY —
// so a handler doing `e.clientX - rect.left` gets `undefined - 0` = NaN and
// silently writes NaN coordinates. That failure is quiet and confusing: the
// event fires, the handler runs, the data it produces is just garbage.
//
// MouseEvent implements the whole coordinate surface, so extend it and carry
// the pointer-specific fields across. Only defined when absent, so a jsdom
// version that gains real PointerEvent support wins.
if (typeof globalThis.PointerEvent !== 'function') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    readonly width: number;
    readonly height: number;
    readonly pressure: number;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? 'mouse';
      this.isPrimary = params.isPrimary ?? true;
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.pressure = params.pressure ?? 0.5;
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof globalThis.PointerEvent;
}

// Pointer capture is likewise unimplemented in jsdom. Product code guards the
// throw (see capturePointer in the canvas overlays), but leaving these missing
// means every test exercises only the failure path.
for (const proto of [Element.prototype]) {
  const p = proto as unknown as Record<string, unknown>;
  p.setPointerCapture ??= function () { /* no-op */ };
  p.releasePointerCapture ??= function () { /* no-op */ };
  p.hasPointerCapture ??= function () { return false; };
}

// ── Canvas2D backing store ────────────────────────────────────────────
//
// jsdom ships no rasterizer, so every pixel-level test was skipped and the CPU
// effect chain (interior layer styles, fill opacity, effect bake) had no
// automated coverage at all.
//
// @napi-rs/canvas (Skia) backs it here rather than node-canvas, which jsdom
// would otherwise wire up itself. node-canvas ACCEPTS `ctx.filter` and silently
// ignores it — measured: a rect edge is byte-identical with and without
// `blur(8px)`. Every interior style and the bevel ramp is built on that blur, so
// under node-canvas those tests would run against structurally wrong pixels and
// the looser assertions would still pass. Skia implements it for real.
//
// Caveat worth knowing: this validates the CPU chain against Skia, not against
// Chromium. Cross-rasterizer differences are small and the assertions here are
// relational, but end-to-end fidelity is the golden-frame suite's job
// (packages/render-tests), not this shim's.
import { createCanvas } from '@napi-rs/canvas';

{
  type Backing = ReturnType<typeof createCanvas>;
  const backings = new WeakMap<HTMLCanvasElement, Backing>();

  /** The Skia canvas behind a jsdom <canvas>, resized to follow width/height. */
  const backingOf = (el: HTMLCanvasElement): Backing => {
    const w = el.width || 300;
    const h = el.height || 150;
    let c = backings.get(el);
    if (!c) {
      c = createCanvas(w, h);
      backings.set(el, c);
    } else if (c.width !== w || c.height !== h) {
      // Matches the DOM: resizing a canvas clears it.
      c.width = w;
      c.height = h;
    }
    return c;
  };

  // drawImage is the ONE call that can be handed a jsdom <canvas> (scratch
  // buffers are created via document.createElement), which Skia cannot consume.
  // Swap any such argument for its backing store. ImageData never crosses the
  // boundary — get/put/createImageData all stay inside the Skia realm.
  const unwrap = (src: unknown): unknown =>
    typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement ? backingOf(src) : src;

  const patched = new WeakSet<object>();

  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ..._rest: unknown[]
  ) {
    // WebGL and friends are not provided — callers already handle a null here.
    if (type !== '2d') return null;

    const ctx = backingOf(this).getContext('2d') as unknown as CanvasRenderingContext2D;
    if (!patched.has(ctx)) {
      patched.add(ctx);
      const raw = ctx.drawImage.bind(ctx) as (...a: unknown[]) => void;
      (ctx as unknown as { drawImage: (...a: unknown[]) => void }).drawImage = (
        src: unknown,
        ...args: unknown[]
      ) => {
        try {
          raw(unwrap(src), ...args);
        } catch (err) {
          // Suites written against jsdom's no-op canvas hand this plain-object
          // stand-ins for <video>/<img> (see videoFrameCache.test.ts), which
          // Skia rejects. Tolerate those, but never a real canvas — that is the
          // effect chain's own path and a throw there is a genuine failure.
          if (src instanceof HTMLCanvasElement) throw err;
        }
      };
    }
    return ctx;
  } as HTMLCanvasElement['getContext'];
}

jest.mock('@core/api/env', () => ({
  IS_ELECTRON: false,
  BACKEND_ORIGIN: 'http://localhost:4000',
  API_URL: '/api',
}));
jest.mock('./src/core/api/env', () => ({
  IS_ELECTRON: false,
  BACKEND_ORIGIN: 'http://localhost:4000',
  API_URL: '/api',
}));
