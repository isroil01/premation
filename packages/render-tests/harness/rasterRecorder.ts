/**
 * Raster recorder — the harness side of the E3 parity export
 * (src/core/rendering/raster/rasterCapture.ts, docs/NATIVE_CORE_PLAN.md E3).
 *
 * While Canvas2DVectorRasterizer draws one raster (between `begin` and `end`),
 * every 2D context obtained from ANY canvas is a recording proxy: each call and
 * property write is logged, then forwarded unchanged to the real context — the
 * pixels the harness renders are exactly the ones it rendered before. The log is
 * the Canvas2D program the TS painter ran; `premation-render --raster-parity`
 * replays it on Skia (native/engine/src/raster/canvas_replay.cpp) and compares
 * pixels with the texels the TS raster uploaded.
 *
 * Op grammar (JSON array of arrays; `c` = canvas id, 0 = the raster itself):
 *   [c, "canvas", w, h]                  a canvas seen (or resized)
 *   [c, "call", name, ...args]           a method call
 *   [c, "set", name, value]              a property write
 *   [c, "grad", g, "linear"|"radial"|"conic", ...args]   create a gradient
 *   [-1, "stop", g, offset, color]       gradient addColorStop
 *   [c, "pattern", p, {"$c": src}, repetition]          createPattern (snapshots src NOW)
 *   [-1, "patxf", p, a, b, c, d, e, f]   pattern.setTransform
 *   [c, "measure", text, font, letterSpacing, width, abl, abr, aba, abd]   measureText result
 * Values: gradients {"$g": id}, patterns {"$p": id}, canvases {"$c": id},
 * matrices {"$m": [a,b,c,d,e,f]}.
 */

import type { CapturedRaster, RasterCapture, RasterCaptureBegin, RasterCaptureEnd } from '@core/rendering/raster/rasterCapture';
import { layerIsBaked } from '@core/effects/effectBake';

type Op = unknown[];

interface Session {
  begin: RasterCaptureBegin;
  ops: Op[];
  incomplete: Set<string>;
  canvasIds: Map<HTMLCanvasElement, number>;
  canvasSize: Map<number, string>;
  nextCanvas: number;
  nextObj: number;
  objIds: WeakMap<object, number>;
  /** proxy → real object, for unwrapping arguments */
  real: WeakMap<object, object>;
  proxies: WeakMap<object, object>;
}

function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'function') return undefined;
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (v instanceof Map) return Object.fromEntries(v);
  if (v instanceof Set) return [...v];
  if (typeof HTMLElement !== 'undefined' && v instanceof HTMLElement) return undefined;
  if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) return undefined;
  return v;
}

export function createRasterRecorder(): RasterCapture {
  const byTexture = new WeakMap<object, CapturedRaster>();
  let s: Session | null = null;
  const proto = HTMLCanvasElement.prototype;
  const origGetContext = proto.getContext;

  const canvasId = (c: HTMLCanvasElement): number => {
    const sess = s!;
    let id = sess.canvasIds.get(c);
    if (id === undefined) {
      id = sess.nextCanvas++;
      sess.canvasIds.set(c, id);
    }
    const size = `${c.width}x${c.height}`;
    if (sess.canvasSize.get(id) !== size) {
      sess.canvasSize.set(id, size);
      sess.ops.push([id, 'canvas', c.width, c.height]);
    }
    return id;
  };

  const encode = (v: unknown): unknown => {
    const sess = s!;
    if (v === null || v === undefined || typeof v !== 'object') return v;
    const realObj = sess.real.get(v as object) ?? (v as object);
    if (typeof HTMLCanvasElement !== 'undefined' && realObj instanceof HTMLCanvasElement) {
      if (!sess.canvasIds.has(realObj)) sess.incomplete.add('canvas used before any 2d context was taken during the raster');
      return { $c: canvasId(realObj) };
    }
    if (typeof CanvasGradient !== 'undefined' && realObj instanceof CanvasGradient) {
      const id = sess.objIds.get(realObj);
      if (id === undefined) { sess.incomplete.add('gradient created outside the raster'); return null; }
      return { $g: id };
    }
    if (typeof CanvasPattern !== 'undefined' && realObj instanceof CanvasPattern) {
      const id = sess.objIds.get(realObj);
      if (id === undefined) { sess.incomplete.add('pattern created outside the raster'); return null; }
      return { $p: id };
    }
    if (typeof Path2D !== 'undefined' && realObj instanceof Path2D) {
      const id = pathIds.get(realObj);
      if (id === undefined) { sess.incomplete.add('Path2D built outside the raster'); return null; }
      return { $path: id };
    }
    if (typeof DOMMatrix !== 'undefined' && (realObj instanceof DOMMatrix || realObj instanceof DOMMatrixReadOnly)) {
      const m = realObj as DOMMatrixReadOnly;
      return { $m: [m.a, m.b, m.c, m.d, m.e, m.f] };
    }
    if (Array.isArray(realObj)) return realObj.map(encode);
    if (typeof ImageData !== 'undefined' && realObj instanceof ImageData) {
      sess.incomplete.add('putImageData');
      return null;
    }
    if ((typeof ImageBitmap !== 'undefined' && realObj instanceof ImageBitmap)
      || (typeof HTMLImageElement !== 'undefined' && realObj instanceof HTMLImageElement)
      || (typeof HTMLVideoElement !== 'undefined' && realObj instanceof HTMLVideoElement)) {
      sess.incomplete.add('drawImage of a bitmap/image/video source');
      return null;
    }
    return JSON.parse(JSON.stringify(realObj, jsonReplacer));
  };

  const unwrap = (v: unknown): unknown => {
    if (v && typeof v === 'object' && s) return s.real.get(v as object) ?? v;
    return v;
  };

  const wrapGradient = (g: CanvasGradient, id: number): CanvasGradient => {
    const sess = s!;
    const p = new Proxy(g, {
      get(target, prop) {
        if (prop === 'addColorStop') {
          return (offset: number, color: string) => {
            s?.ops.push([-1, 'stop', id, offset, color]);
            target.addColorStop(offset, color);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    sess.real.set(p, g);
    return p;
  };

  const wrapPattern = (pat: CanvasPattern, id: number): CanvasPattern => {
    const sess = s!;
    const p = new Proxy(pat, {
      get(target, prop) {
        if (prop === 'setTransform') {
          return (m?: DOMMatrix2DInit) => {
            const mm = m ? new DOMMatrix([m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0]) : new DOMMatrix();
            s?.ops.push([-1, 'patxf', id, mm.a, mm.b, mm.c, mm.d, mm.e, mm.f]);
            target.setTransform(m);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    sess.real.set(p, pat);
    return p;
  };

  const wrapContext = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
    const sess = s!;
    const existing = sess.proxies.get(ctx);
    if (existing) return existing as CanvasRenderingContext2D;
    const proxy = new Proxy(ctx, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== 'function' || typeof prop !== 'string') return v;
        return (...args: unknown[]) => {
          const sess2 = s;
          const real = args.map(unwrap);
          if (!sess2) return (v as (...a: unknown[]) => unknown).apply(target, real);
          const cid = canvasId(canvas);
          switch (prop) {
            case 'createLinearGradient':
            case 'createRadialGradient':
            case 'createConicGradient': {
              const g = (v as (...a: unknown[]) => CanvasGradient).apply(target, real);
              const id = sess2.nextObj++;
              sess2.objIds.set(g, id);
              sess2.ops.push([cid, 'grad', id, prop.replace('create', '').replace('Gradient', '').toLowerCase(), ...real]);
              return wrapGradient(g, id);
            }
            case 'createPattern': {
              const pat = (v as (...a: unknown[]) => CanvasPattern | null).apply(target, real);
              if (!pat) return pat;
              const id = sess2.nextObj++;
              sess2.objIds.set(pat, id);
              sess2.ops.push([cid, 'pattern', id, encode(real[0]), real[1] ?? 'repeat']);
              return wrapPattern(pat, id);
            }
            case 'measureText': {
              const m = (v as (t: string) => TextMetrics).apply(target, real as [string]);
              sess2.ops.push([cid, 'measure', String(real[0]), target.font, (target as { letterSpacing?: string }).letterSpacing ?? '0px',
                m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent]);
              return m;
            }
            case 'getImageData':
              sess2.incomplete.add('getImageData (pixel readback: a CPU-baked chain)');
              return (v as (...a: unknown[]) => unknown).apply(target, real);
            case 'getTransform':
            case 'getLineDash':
            case 'isPointInPath':
            case 'isPointInStroke':
            case 'getContextAttributes':
              return (v as (...a: unknown[]) => unknown).apply(target, real);
            default:
              sess2.ops.push([cid, 'call', prop, ...args.map(encode)]);
              return (v as (...a: unknown[]) => unknown).apply(target, real);
          }
        };
      },
      set(target, prop, value) {
        if (s && typeof prop === 'string') s.ops.push([canvasId(canvas), 'set', prop, encode(value)]);
        return Reflect.set(target, prop, unwrap(value), target);
      },
    });
    sess.proxies.set(ctx, proxy);
    sess.real.set(proxy, ctx);
    return proxy;
  };

  // Path2D objects built during the raster record their own calls:
  //   [-1, "path2d", id, init]  (init: null | {"$path": id} | an SVG path string)
  //   [-1, "p2d", id, method, ...args]
  const OrigPath2D = globalThis.Path2D;
  const pathIds = new WeakMap<object, number>();
  class RecordingPath2D extends OrigPath2D {
    constructor(init?: Path2D | string) {
      super(init as Path2D);
      if (!s) return;
      const id = s.nextObj++;
      pathIds.set(this, id);
      const enc = init === undefined ? null : typeof init === 'string' ? init
        : pathIds.has(init) ? { $path: pathIds.get(init) } : (s.incomplete.add('Path2D copied from an unrecorded path'), null);
      s.ops.push([-1, 'path2d', id, enc]);
    }
  }
  for (const m of ['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'closePath', 'addPath'] as const) {
    const orig = (OrigPath2D.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[m];
    if (typeof orig !== 'function') continue;
    Object.defineProperty(RecordingPath2D.prototype, m, {
      value(this: Path2D, ...args: unknown[]) {
        const id = pathIds.get(this);
        if (s && id !== undefined) s.ops.push([-1, 'p2d', id, m, ...args.map(encode)]);
        return orig.apply(this, args);
      },
    });
  }

  function patchedGetContext(this: HTMLCanvasElement, type: string, opts?: unknown): RenderingContext | null {
    const ctx = (origGetContext as (t: string, o?: unknown) => RenderingContext | null).call(this, type, opts);
    if (!s || type !== '2d' || !ctx) return ctx;
    canvasId(this);
    return wrapContext(ctx as CanvasRenderingContext2D, this);
  }

  return {
    begin(info) {
      s = {
        begin: info, ops: [], incomplete: new Set(), canvasIds: new Map(), canvasSize: new Map(),
        nextCanvas: 0, nextObj: 0, objIds: new WeakMap(), real: new WeakMap(), proxies: new WeakMap(),
      };
      proto.getContext = patchedGetContext as typeof proto.getContext;
      globalThis.Path2D = RecordingPath2D;
    },
    end(info: RasterCaptureEnd) {
      proto.getContext = origGetContext;
      globalThis.Path2D = OrigPath2D;
      const sess = s;
      s = null;
      if (!sess) return;
      const root = sess.canvasIds.get(info.canvas);
      if (root !== 0) sess.incomplete.add('the raster canvas was not the first canvas drawn');
      const kind = sess.begin.kind === 'text' || sess.begin.kind === 'mask' ? sess.begin.kind : 'path';
      byTexture.set(info.texture as object, {
        kind,
        cacheKey: sess.begin.cacheKey,
        width: info.canvas.width,
        height: info.canvas.height,
        resolutionScale: sess.begin.resolutionScale,
        padding: sess.begin.padding,
        // Two facts the painter decides from outside the drawable: whether the
        // layer takes the CPU bake (Canvas2DVectorRasterizer's layerIsBaked —
        // an effect-registry question, E4's) and the device texture cap.
        specJson: JSON.stringify({
          ...(sess.begin.drawable as object),
          __baked: layerIsBaked(sess.begin.drawable as Parameters<typeof layerIsBaked>[0]),
          __deviceMax: sess.begin.deviceMax,
        }, jsonReplacer) ?? '{}',
        opsJson: JSON.stringify(sess.ops),
        incomplete: [...sess.incomplete].join('; '),
      });
    },
    rasterOf(texture) {
      return texture && typeof texture === 'object' ? byTexture.get(texture) : undefined;
    },
  };
}
