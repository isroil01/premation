/**
 * The document exports — files made from the project's DATA, not rendered
 * pixels: the re-openable project JSON, the editorial cut lists (EDL, OTIO,
 * FCPXML, ALE), the .mogrt template package and Lottie.
 *
 * Rendered formats (MP4, WebM, MOV, GIF, image sequences, a still PNG and the
 * WAV mixdown) are the ENGINE's: the Export form queues them on main's export
 * supervisor (`premation-engine --export`, electron/engineExport.ts). The
 * page's render pipeline — `runExport`, the video sinks, the WebM muxer, the
 * GIF encoder and the raw pipe — is gone (docs/TS_ENGINE_REMOVAL.md phase 4).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, pointsToLottieBezier } from '@motion/animation';
import { shapeOutline } from '@core/scene/pathOps';
import { readNodePolystar } from '@core/scene/polystar';
import { readNodeStrokes, type PaintOpOptions, type Stroke } from '@core/paint/stroke';
import { readNodeFill, type FillPaint } from '@core/paint/fill';
import {
  dashParamAt,
  strokeColorChannelPaths,
  strokeGradientGeometryFor,
  strokeTrackPath,
} from '@core/rendering/strokeTracks';
import { paintBlendToLottie } from '@core/rendering/raster/paintBlend';
import { paintRenderOrder } from '@core/rendering/raster/vectorDraw';
import { liveDocument } from '@core/project/liveDocument';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { compRootOf } from '@core/scene/parenting';
import type { SceneNode } from '@core/types';
import { useUIStore } from '@stores/uiStore';
import { exportEdlText } from './exportEdl';
import { exportOtioText } from './exportOtio';
import { exportFcpxmlText } from './exportFcpxml';
import { exportAleText } from './exportAle';
import { exportMogrtZip } from './exportMogrt';
import { canEncodeLocally, type VideoFormat } from './renderSpec';
import { exportFormatCode, failureReason, track as trackEvent } from '@core/analytics/productEvents';

export type ExportFormat =
  | VideoFormat
  | 'png'
  | 'png-sequence'
  | 'jpg-sequence'
  | 'exr-sequence'
  | 'wav'
  | DataExportFormat;

/** The formats this module writes (no pixels). */
export type DataExportFormat = 'json' | 'lottie' | 'edl' | 'otio' | 'fcpxml' | 'ale' | 'mogrt';

const DATA_FORMATS: ReadonlySet<string> = new Set<DataExportFormat>(['json', 'lottie', 'edl', 'otio', 'fcpxml', 'ale', 'mogrt']);

/** Whether `format` is a document export (this module) rather than an engine render. */
export function isDataExportFormat(format: string): format is DataExportFormat {
  return DATA_FORMATS.has(format);
}

export interface ExportOptions {
  format: DataExportFormat;
  /** Lottie: the frame size and timing. */
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Lottie: the composition to export (absent = every layer). */
  rootId?: string;
  onProgress?: (fraction: number) => void;
}

/** True when an error is the cooperative-cancel rejection. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  download(blob, filename);
}
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 10 minutes, not 4 seconds: revoking mid-write aborts the save of a large
  // blob (multi-hundred-MB sequence zips on slow disks) in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
}

/**
 * Export the project as a re-openable document.
 *
 * This wrote its own hand-rolled shape (`{version, scene, animation,
 * exportedAt}`) that nothing could read back: the loader looks for a top-level
 * `nodes`, found none, and opened a SILENTLY EMPTY scene — while the preset
 * advertised "Re-openable Motion project file". It now writes exactly what
 * `File ▸ Open` restores, so the claim is true.
 */
async function exportJSON(opts: ExportOptions): Promise<void> {
  // F2: the owner's document (the engine's exportDocument when it owns it).
  const doc = { ...(await liveDocument()), exportedAt: new Date().toISOString() };
  opts.onProgress?.(1);
  download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), 'motion-project.json');
}

/** CMX 3600-style EDL of the active timeline's clip bars. */
function exportEDL(opts: ExportOptions): void {
  const text = exportEdlText('MOTION');
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'text/plain' }), 'timeline.edl');
}

/** OpenTimelineIO document of the same clip bars (see exportOtio.ts). */
function exportOTIO(opts: ExportOptions): void {
  const text = exportOtioText('MOTION');
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'application/json' }), 'timeline.otio');
}

/** Final Cut Pro X XML of the same clip bars. */
function exportFCPXML(opts: ExportOptions): void {
  const text = exportFcpxmlText('MOTION');
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'text/xml' }), 'timeline.fcpxml');
}

/** Premation .mogrt foothold — template fields + document in a zip (not Adobe AME). */
async function exportMogrt(opts: ExportOptions): Promise<void> {
  const bytes = await exportMogrtZip('MOTION');
  opts.onProgress?.(1);
  download(new Blob([bytes as BlobPart], { type: 'application/zip' }), 'template.mogrt.zip');
}

/** Avid Log Exchange — text cut list Media Composer imports. */
function exportALE(opts: ExportOptions): void {
  const text = exportAleText();
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'text/plain' }), 'timeline.ale');
}

/** "#ff8800" (also #rgb / #rgba / #rrggbbaa) → Lottie's normalized [r, g, b] triple. */
function hexToLottieRgb(hex: unknown): [number, number, number] {
  const s = typeof hex === 'string' ? hex.trim().replace('#', '') : '';
  const short = s.length === 3 || s.length === 4 ? s.slice(0, 3).split('').map((c) => c + c).join('') : s;
  const full = short.length === 8 ? short.slice(0, 6) : short;
  if (!/^[0-9a-f]{6}$/i.test(full)) return [1, 1, 1];
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The alpha a #rgba / #rrggbbaa colour carries, 0..1 (1 when it has none). */
function hexAlpha(hex: unknown): number {
  const s = typeof hex === 'string' ? hex.trim().replace('#', '') : '';
  if (/^[0-9a-f]{8}$/i.test(s)) return parseInt(s.slice(6, 8), 16) / 255;
  if (/^[0-9a-f]{4}$/i.test(s)) return parseInt(s[3]! + s[3]!, 16) / 255;
  return 1;
}

const LOTTIE_LINE_CAP: Record<Stroke['cap'], number> = { butt: 1, round: 2, square: 3 };
const LOTTIE_LINE_JOIN: Record<Stroke['join'], number> = { miter: 1, round: 2, bevel: 3 };

/** The drawable's local box (centre + size) — gradient endpoints are placed in it. */
interface LottieBox { cx: number; cy: number; w: number; h: number }

/** One engine track as a Lottie scalar property (static when it has < 2 keys),
 *  with values multiplied by `mul` (e.g. 100 for a 0..1 track Lottie keeps in %). */
function lottieScalarProp(nodeId: string, prop: string, fr: number, fallback: number, mul = 1): unknown {
  const tr = defaultAnimation.tracksFor(nodeId).find((t) => t.prop === prop);
  if (!tr || tr.keyframes.length < 2) {
    const v = tr?.keyframes[0]?.value;
    return { a: 0, k: (typeof v === 'number' && Number.isFinite(v) ? v : fallback) * mul };
  }
  return { a: 1, k: tr.keyframes.map((k) => ({ t: Math.round(k.t * fr), s: [k.value * mul], ...lottieEase(k) })) };
}

/**
 * Stroke colour (`c`) and opacity (`o`, 0–100) for the stroke at stack `index`.
 * The renderer folds its colour channels (0..1) into the colour and the alpha
 * channel into its alpha, which multiplies the stroke's opacity — and that
 * opacity is itself a track (`strokeOpacity` / `stroke.<i>.opacity`) since
 * 2026-09-15. Either animating exports as animated `o`.
 *
 * `colorTracks` false (a gradient stroke) exports opacity alone; a gradient has
 * no `c`, so its colour channels have nothing to drive.
 */
function lottieStrokeColorOpacity(
  nodeId: string,
  stroke: Stroke,
  index: number,
  colorTracks: boolean,
  fr: number,
): { c: unknown; o: unknown } {
  const [rP, gP, bP, aP] = strokeColorChannelPaths(index) as [string, string, string, string];
  const opP = strokeTrackPath(index, 'opacity');
  const wanted = colorTracks ? [rP, gP, bP, aP, opP] : [opP];
  const tracks = defaultAnimation.tracksFor(nodeId).filter((t) => wanted.includes(t.prop) && t.keyframes.length > 0);
  // The renderer applies the colour channels only when red is present.
  const hasColor = tracks.some((t) => t.prop === rP);
  const hasOpacity = tracks.some((t) => t.prop === opP);
  if (!hasColor && !hasOpacity) {
    return {
      c: { a: 0, k: [...hexToLottieRgb(stroke.color), 1] },
      o: { a: 0, k: stroke.opacity * hexAlpha(stroke.color) * 100 },
    };
  }
  const live = tracks.filter((t) => hasColor || t.prop === opP);
  const times = [...new Set(live.flatMap((t) => t.keyframes.map((k) => k.t)))].sort((a, b) => a - b);
  const at = (prop: string, t: number, dflt: number): number => {
    const v = defaultAnimation.sample(nodeId, prop, t);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt;
  };
  const easeAt = (t: number) => live.map((tr) => tr.keyframes.find((k) => k.t === t)).find((k) => k !== undefined) ?? {};
  const rgbAt = (t: number): number[] => (hasColor
    ? [at(rP, t, 0), at(gP, t, 0), at(bP, t, 0), 1]
    : [...hexToLottieRgb(stroke.color), 1]);
  const opAt = (t: number): number =>
    (hasOpacity ? at(opP, t, stroke.opacity) : stroke.opacity)
    * (hasColor ? at(aP, t, 1) : hexAlpha(stroke.color)) * 100;
  const rgbAnimated = hasColor && live.some((t) => (t.prop === rP || t.prop === gP || t.prop === bP) && t.keyframes.length >= 2);
  const alphaAnimated = live.some((t) => (t.prop === aP || t.prop === opP) && t.keyframes.length >= 2);
  const t0 = times[0] ?? 0;
  return {
    c: rgbAnimated
      ? { a: 1, k: times.map((t) => ({ t: Math.round(t * fr), s: rgbAt(t), ...lottieEase(easeAt(t)) })) }
      : { a: 0, k: rgbAt(t0) },
    o: alphaAnimated
      ? { a: 1, k: times.map((t) => ({ t: Math.round(t * fr), s: [opAt(t)], ...lottieEase(easeAt(t)) })) }
      : { a: 0, k: opAt(t0) },
  };
}

/** A gradient stroke paint's `gs` fields (`g`, `t`, `s`, `e`), or null for solid. */
function lottieGradientFields(paint: FillPaint, box: LottieBox): Record<string, unknown> | null {
  if (paint.type === 'solid' || paint.stops.length === 0) return null;
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
  const k: number[] = [];
  for (const s of stops) k.push(s.offset, ...hexToLottieRgb(s.color));
  for (const o of paint.opacityStops ?? []) k.push(o.offset, o.opacity);
  let s: [number, number];
  let e: [number, number];
  if (paint.type === 'linear') {
    // The importer reads a linear gradient's direction back off s→e, so any
    // span along the angle round-trips; reaching the box edges also matches
    // how the renderer spans the ramp.
    const rad = (paint.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const half = (Math.abs(box.w * cos) + Math.abs(box.h * sin)) / 2;
    s = [box.cx - half * cos, box.cy - half * sin];
    e = [box.cx + half * cos, box.cy + half * sin];
  } else {
    // Engine radial: centre relative to the box, radius a fraction of its half-diagonal.
    const sx = box.cx + (paint.cx - 0.5) * box.w;
    const sy = box.cy + (paint.cy - 0.5) * box.h;
    s = [sx, sy];
    e = [sx + paint.radius * (Math.hypot(box.w, box.h) / 2), sy];
  }
  return { g: { p: stops.length, k: { a: 0, k } }, t: paint.type === 'radial' ? 2 : 1, s: { a: 0, k: s }, e: { a: 0, k: e } };
}

/**
 * Two engine tracks (an X and a Y) as one Lottie 2-D point property, mapped
 * through `map`. Static when neither track has two keys; otherwise keyed at the
 * union of both tracks' times, each axis SAMPLED there, so a point whose X and Y
 * were keyed at different times still plays back as the frame showed it.
 */
function lottiePointProp(
  nodeId: string,
  xProp: string,
  yProp: string,
  fr: number,
  fallback: readonly [number, number],
  map: (x: number, y: number) => [number, number],
): unknown {
  const tracks = defaultAnimation.tracksFor(nodeId).filter((t) => (t.prop === xProp || t.prop === yProp) && t.keyframes.length > 0);
  const sample = (prop: string, t: number, dflt: number): number => {
    const v = defaultAnimation.sample(nodeId, prop, t);
    return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  };
  if (!tracks.some((t) => t.keyframes.length >= 2)) {
    const x = tracks.find((t) => t.prop === xProp)?.keyframes[0]?.value ?? fallback[0];
    const y = tracks.find((t) => t.prop === yProp)?.keyframes[0]?.value ?? fallback[1];
    return { a: 0, k: map(x, y) };
  }
  const times = [...new Set(tracks.flatMap((t) => t.keyframes.map((k) => k.t)))].sort((a, b) => a - b);
  const easeAt = (t: number) => tracks.map((tr) => tr.keyframes.find((k) => k.t === t)).find((k) => k !== undefined) ?? {};
  return {
    a: 1,
    k: times.map((t) => ({
      t: Math.round(t * fr),
      s: map(sample(xProp, t, fallback[0]), sample(yProp, t, fallback[1])),
      ...lottieEase(easeAt(t)),
    })),
  };
}

/**
 * One engine stroke — the one at stack `index` — as a Lottie `st` (or `gs` for
 * gradient paint): colour, opacity, width, cap, join, miter limit, dashes and
 * blend mode, with every animated channel exported as keyframes on the tracks
 * `resolveStrokeTracks` folds for THAT index (width, colour, opacity, miter
 * limit as `ml2`, each dash/gap value, dash offset, gradient Start/End `s`/`e`
 * and radial highlight `h`/`a`).
 *
 * Not representable in Lottie, so not exported: Taper and Wave (no standard
 * bodymovin field), inside/outside alignment (AE has no stroke alignment), and
 * Composite as a FIELD — it is exported structurally instead, by the order the
 * paint items are written in (see `lottieShapesFor`).
 */
function lottieStrokeItem(nodeId: string, stroke: Stroke, index: number, fr: number, box: LottieBox): Record<string, unknown> {
  const color = stroke.paint?.type === 'solid' ? stroke.paint.color : stroke.color;
  const grad = stroke.paint ? lottieGradientFields(stroke.paint, box) : null;
  const { c, o } = lottieStrokeColorOpacity(nodeId, { ...stroke, color }, index, !grad, fr);
  let d: unknown[] | undefined;
  if (stroke.dash.some((v) => v > 0)) {
    // An odd pattern repeats doubled (Canvas2D and SVG both); spell that out
    // rather than rely on every player agreeing. A doubled entry follows the
    // SAME track as the stored entry it repeats.
    const n = stroke.dash.length;
    const pattern = n % 2 === 1 ? [...stroke.dash, ...stroke.dash] : stroke.dash;
    d = pattern.map((v, i) => {
      const pair = Math.floor(i / 2) + 1;
      const isDash = i % 2 === 0;
      const slot = dashParamAt(i % n);
      return {
        n: isDash ? 'd' : 'g',
        nm: `${isDash ? 'dash' : 'gap'}${pair > 1 ? pair : ''}`,
        v: slot ? lottieScalarProp(nodeId, strokeTrackPath(index, slot), fr, v) : { a: 0, k: v },
      };
    });
    d.push({
      n: 'o',
      nm: 'offset',
      v: lottieScalarProp(nodeId, strokeTrackPath(index, 'dashOffset'), fr, stroke.dashOffset ?? 0),
    });
  }
  const ml = stroke.miterLimit ?? 4;
  // AE's free gradient points, when the stroke has them (or keys them): they
  // replace the angle/centre reading `lottieGradientFields` derived.
  const g = grad && stroke.paint && stroke.paint.type !== 'solid' ? stroke.paint : null;
  const pts = g ? stroke.gradient ?? strokeGradientGeometryFor(g, box.w, box.h) : null;
  const pointTracked = !!g && ['gradientStartX', 'gradientStartY', 'gradientEndX', 'gradientEndY', 'highlightLength', 'highlightAngle']
    .some((p) => defaultAnimation.isAnimated(nodeId, strokeTrackPath(index, p as 'gradientStartX')));
  const toBox = (x: number, y: number): [number, number] => [box.cx + (x - 0.5) * box.w, box.cy + (y - 0.5) * box.h];
  const points = g && pts && (stroke.gradient || pointTracked)
    ? {
        s: lottiePointProp(nodeId, strokeTrackPath(index, 'gradientStartX'), strokeTrackPath(index, 'gradientStartY'), fr, [pts.startX, pts.startY], toBox),
        e: lottiePointProp(nodeId, strokeTrackPath(index, 'gradientEndX'), strokeTrackPath(index, 'gradientEndY'), fr, [pts.endX, pts.endY], toBox),
        ...(g.type === 'radial'
          ? {
              h: lottieScalarProp(nodeId, strokeTrackPath(index, 'highlightLength'), fr, pts.highlightLength ?? 0, 100),
              a: lottieScalarProp(nodeId, strokeTrackPath(index, 'highlightAngle'), fr, pts.highlightAngle ?? 0),
            }
          : {}),
      }
    : {};
  const bm = paintBlendToLottie(stroke.blendMode);
  return {
    ty: grad ? 'gs' : 'st',
    ...(grad ? { ...grad, ...points } : { c }),
    o,
    w: lottieScalarProp(nodeId, strokeTrackPath(index, 'width'), fr, stroke.width),
    lc: LOTTIE_LINE_CAP[stroke.cap] ?? 1,
    lj: LOTTIE_LINE_JOIN[stroke.join] ?? 1,
    ml,
    ml2: lottieScalarProp(nodeId, strokeTrackPath(index, 'miterLimit'), fr, ml),
    ...(d ? { d } : {}),
    ...(bm ? { bm } : {}),
    nm: `Stroke ${index + 1}`,
  };
}

/**
 * The layer's actual geometry, as Lottie shape items.
 *
 * Without this the export was structurally valid bodymovin with `shapes: []`
 * on every layer — it opened in a player and drew absolutely nothing. Lottie
 * shapes are positioned around the layer's own anchor, so `p` is [0,0] here;
 * the layer's `ks.p` does the placing.
 *
 * Returns [] for kinds with no vector equivalent (text needs embedded font
 * data, images need embedded assets) — the caller counts those and tells the
 * user rather than silently shipping a hole.
 */
export function lottieShapesFor(node: SceneNode, fr = 30): unknown[] {
  // Hard type-guard: only true vector shape layers export Lottie geometry.
  // Without this, a text/image/video node that happens to carry a default
  // `shapeType:'rect'` Transform with width/height would fall through to the
  // rect branch below and export as a rectangle. Non-shape layers return [] so
  // the caller counts them as unexported and warns the user (honest drop),
  // rather than silently shipping a bogus box.
  if (readNodeKind(node) !== 'shape') return [];

  const t = node.components.find((c) => c.type === 'Transform');
  const style = node.components.find((c) => c.type === 'Style');
  if (!t) return [];

  const p = t.props as Record<string, unknown>;
  const w = typeof p.width === 'number' ? p.width : 0;
  const h = typeof p.height === 'number' ? p.height : 0;

  const shapeType = typeof p.shapeType === 'string' ? p.shapeType : 'rect';
  const fill = (style?.props as Record<string, unknown> | undefined)?.fill;
  const hasFill = typeof fill === 'string' && fill !== '' && fill !== 'none' && fill !== 'transparent';
  // The strokes the RENDERER draws — the fx stroke stack Fill & Stroke edits.
  // This read the legacy `Style.stroke/strokeWidth` pair, which nothing renders,
  // so every stroke set in the inspector exported as no stroke at all.
  // Each with its STORED stack index: a stroke's tracks are keyed by that index
  // (`strokeTracks.ts`), so a disabled stroke 2 must not shift stroke 3 onto
  // stroke 2's keyframes.
  const strokes = readNodeStrokes(node)
    .map((stroke, index) => ({ stroke, index }))
    .filter((e) => e.stroke.enabled && e.stroke.width > 0);
  const hasStroke = strokes.length > 0;

  const geomComp = node.components.find((c) => c.type === 'Geometry');
  let geometry: unknown;
  let box: LottieBox = { cx: 0, cy: 0, w, h };

  const polystar = readNodePolystar(node);
  if (polystar) {
    box = { cx: 0, cy: 0, w: polystar.outerRadius * 2, h: polystar.outerRadius * 2 };
    // A PARAMETRIC polystar exports as Lottie's native 'sr' shape rather than
    // a re-derived outline — players then render the same roundness math this
    // renderer uses (both follow AE's segment-proportional tangents). Static
    // values only, matching every other shape here (rect w/h export static
    // too); keyframed polystar params flatten to their base values.
    geometry = {
      ty: 'sr',
      sy: polystar.starType === 'polygon' ? 2 : 1,
      d: 1,
      pt: { a: 0, k: polystar.points },
      p: { a: 0, k: [0, 0] },
      r: { a: 0, k: polystar.rotation },
      or: { a: 0, k: polystar.outerRadius },
      os: { a: 0, k: polystar.outerRoundness },
      ...(polystar.starType === 'star'
        ? { ir: { a: 0, k: polystar.innerRadius }, is: { a: 0, k: polystar.innerRoundness } }
        : {}),
      nm: polystar.starType === 'polygon' ? 'Polygon' : 'Star',
    };
  } else if (geomComp && Array.isArray(geomComp.props.points) && (geomComp.props.points as Array<{ x: number; y: number }>).length > 0) {
    const pts = geomComp.props.points as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>;
    const closed = geomComp.props.open !== true;
    const lottieBez = pointsToLottieBezier(pts, closed);
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    box = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    geometry = {
      ty: 'sh',
      d: 1,
      ks: { a: 0, k: lottieBez },
      nm: 'Path',
    };
  } else if (shapeType === 'ellipse') {
    if (w <= 0 || h <= 0) return [];
    geometry = { ty: 'el', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [w, h] }, nm: 'Ellipse' };
  } else if (shapeType === 'polygon' || shapeType === 'star') {
    const width = w > 0 ? w : 100;
    const height = h > 0 ? h : 100;
    box = { cx: 0, cy: 0, w: width, h: height };
    const outline = shapeOutline(shapeType as 'polygon' | 'star', width, height, 32);
    if (outline && outline.length >= 3) {
      const lottieBez = pointsToLottieBezier(outline, true);
      geometry = { ty: 'sh', d: 1, ks: { a: 0, k: lottieBez }, nm: shapeType === 'polygon' ? 'Polygon' : 'Star' };
    } else {
      geometry = { ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [width, height] }, r: { a: 0, k: 0 }, nm: 'Rect' };
    }
  } else {
    if (w <= 0 || h <= 0) return [];
    geometry = {
      ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [w, h] },
      r: { a: 0, k: typeof p.cornerRadius === 'number' ? p.cornerRadius : 0 },
      nm: 'Rect',
    };
  }

  const groupItems: unknown[] = [geometry];
  // Lottie draws a group's FIRST paint item on top, so the paints go out
  // FRONT → BACK in the order the renderer composites them (`paintRenderOrder`,
  // which resolves each paint's Composite). With every paint at its default
  // that is today's order: strokes first, top one leading, then the fill — which
  // also leaves the primary (bottom) stroke last among the strokes, the one an
  // importer that keeps a single stroke picks up. A fill set Composite Above is
  // written ahead of the strokes it covers, which is how Lottie says so.
  const fillOp = (readNodeFill(node) ?? undefined) as (FillPaint & PaintOpOptions) | undefined;
  const fillBm = paintBlendToLottie(fillOp?.blendMode);
  const fillItem = hasFill || !hasStroke
    ? {
        ty: 'fl',
        c: { a: 0, k: [...hexToLottieRgb(hasFill ? fill : '#ffffff'), 1] },
        o: { a: 0, k: hasFill ? 100 : 0 },
        r: 1,
        ...(fillBm ? { bm: fillBm } : {}),
        nm: 'Fill',
      }
    : null;
  const order = paintRenderOrder(fillItem ? [fillOp] : [], strokes.map((e) => e.stroke)).reverse();
  for (const op of order) {
    if (op.kind === 'fill') {
      groupItems.push(fillItem);
    } else {
      const entry = strokes.find((e) => e.stroke === op.stroke)!;
      groupItems.push(lottieStrokeItem(node.id, entry.stroke, entry.index, fr, box));
    }
  }
  groupItems.push({
    ty: 'tr',
    p: { a: 0, k: [0, 0] },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
  });

  return [
    {
      ty: 'gr',
      nm: 'Group',
      it: groupItems,
    },
  ];
}

/** Lottie out/in handles for the segment STARTING at keyframe `k` (bodymovin
 *  stores both on the leading keyframe). Hold segments use `h: 1`. */
function lottieEase(k: { easing?: string; bezier?: readonly number[] }): Record<string, unknown> {
  const CURVES: Record<string, [number, number, number, number]> = {
    linear: [0.167, 0.167, 0.833, 0.833],
    ease: [0.25, 0.1, 0.25, 1],
    easeIn: [0.42, 0, 1, 1],
    easeOut: [0, 0, 0.58, 1],
    easeInOut: [0.42, 0, 0.58, 1],
  };
  if (k.easing === 'hold' || k.easing === 'step') return { h: 1 };
  const b =
    (k.easing === 'bezier' || k.easing === 'autoBezier' || k.easing === 'continuousBezier') && k.bezier?.length === 4
      ? (k.bezier as [number, number, number, number])
      : CURVES[k.easing ?? 'linear'] ?? CURVES.linear!;
  return { o: { x: [b[0]], y: [b[1]] }, i: { x: [b[2]], y: [b[3]] } };
}

/** Build a Lottie animation from the scene's geometry and transform tracks. */
function exportLottie(opts: ExportOptions): void {
  const fr = opts.fps;
  const op = Math.round(opts.duration * fr);
  // Scoped to THIS composition: flattenScene walks the whole project, so a
  // multi-comp project exported every comp's layers stacked into one Lottie.
  const rootId = opts.rootId;
  const layers = flattenScene(defaultSceneGraph)
    .filter((n) => (rootId ? compRootOf(n.id) === rootId && n.id !== rootId : true))
    .filter((n) => readNodeKind(n) !== 'group')
    .map((node, idx) => {
      // Base (un-keyframed) value straight off the components — the engine's
      // base provider only covers some props, and `?? 0` here once exported
      // every un-animated-opacity layer invisible.
      const baseProp = (prop: string): number | undefined => {
        for (const c of node.components) {
          const v = (c.props as Record<string, unknown>)[prop];
          if (typeof v === 'number') return v;
        }
        return undefined;
      };
      const kf = (prop: string, mul = 1, fallback = 0): unknown => {
        const tr = defaultAnimation.tracksFor(node.id).find((t) => t.prop === prop);
        if (!tr || tr.keyframes.length < 2) {
          const v = defaultAnimation.sample(node.id, prop, 0) ?? baseProp(prop) ?? fallback;
          return { a: 0, k: v * mul };
        }
        // Real per-segment easing — this was a hardcoded 0.4 bezier for every
        // keyframe regardless of the authored curves.
        return {
          a: 1,
          k: tr.keyframes.map((k) => ({ t: Math.round(k.t * fr), s: [k.value * mul], ...lottieEase(k) })),
        };
      };

      // Scale: engine stores 1 = 100%, split across scale/scaleX/scaleY —
      // Lottie wants one [sx, sy, sz] vector track, so animated scale merges
      // over the union of keyframe times. (It exported a hardcoded static
      // [100,100,100] before — scale animation vanished from every Lottie.)
      const scaleProps = ['scale', 'scaleX', 'scaleY'] as const;
      const scaleAnimated = scaleProps.some((p) => defaultAnimation.isAnimated(node.id, p));
      const sampleScale = (axis: 'scaleX' | 'scaleY', t: number): number =>
        defaultAnimation.sample(node.id, 'scale', t) ??
        defaultAnimation.sample(node.id, axis, t) ??
        baseProp('scale') ?? baseProp(axis) ?? 1;
      let s: unknown;
      if (!scaleAnimated) {
        s = { a: 0, k: [sampleScale('scaleX', 0) * 100, sampleScale('scaleY', 0) * 100, 100] };
      } else {
        const times = [...new Set(
          scaleProps.flatMap((p) =>
            defaultAnimation.tracksFor(node.id).find((t) => t.prop === p)?.keyframes.map((k) => k.t) ?? [],
          ),
        )].sort((a, b) => a - b);
        const easeSourceAt = (t: number) =>
          scaleProps
            .map((p) => defaultAnimation.tracksFor(node.id).find((tr) => tr.prop === p)?.keyframes.find((k) => k.t === t))
            .find((k) => k !== undefined) ?? {};
        s = {
          a: 1,
          k: times.map((t) => ({
            t: Math.round(t * fr),
            s: [sampleScale('scaleX', t) * 100, sampleScale('scaleY', t) * 100, 100],
            ...lottieEase(easeSourceAt(t)),
          })),
        };
      }

      return {
        ddd: 0, ind: idx + 1, ty: 4, nm: node.name ?? `Layer ${idx}`,
        sr: 1, ip: 0, op,
        ks: {
          o: kf('opacity', 1, 100),
          r: kf('rotation'),
          // Split-dimension position: x and y are independent scalar tracks in
          // the engine, and Lottie's `s: true` form keeps their keyframes AND
          // easing intact. (Position was sampled once and written static.)
          p: { s: true, x: kf('x'), y: kf('y') },
          a: { a: 0, k: [0, 0, 0] },
          s,
        },
        shapes: lottieShapesFor(node, fr),
      };
    });

  const lottie = { v: '5.7.0', fr, ip: 0, op, w: opts.width, h: opts.height, nm: 'Motion Export', ddd: 0, assets: [], layers };
  opts.onProgress?.(1);
  download(new Blob([JSON.stringify(lottie)], { type: 'application/json' }), 'motion-export.lottie.json');

  // Say what didn't make it. A Lottie that silently drops every text layer is
  // worse than one that admits it — the user finds out in the player otherwise.
  const dropped = layers.filter((l) => (l as { shapes: unknown[] }).shapes.length === 0).length;
  if (dropped > 0) {
    useUIStore.getState().notify({
      level: 'warning',
      message: `Lottie exported, but ${dropped} layer${dropped > 1 ? 's' : ''} had no vector equivalent (text and images need WebM or MP4).`,
      durationMs: 6000,
    });
  }
}

/**
 * A document export — the Export panel and the assistant both come through
 * here for the data formats, so this is the one place one is reported.
 */
export async function runDataExport(opts: ExportOptions): Promise<void> {
  const format = exportFormatCode(String(opts.format));
  const started = Date.now();
  trackEvent('export_started', { format, target: 'local' });
  try {
    await runDataExportFormat(opts);
    trackEvent('export_completed', { format, target: 'local', seconds: (Date.now() - started) / 1000 });
  } catch (err) {
    if (!isAbortError(err)) trackEvent('export_failed', { format, target: 'local', reason: failureReason(err) });
    throw err;
  }
}

async function runDataExportFormat(opts: ExportOptions): Promise<void> {
  switch (opts.format) {
    case 'json': await exportJSON(opts); return;
    case 'edl': exportEDL(opts); return;
    case 'otio': exportOTIO(opts); return;
    case 'fcpxml': exportFCPXML(opts); return;
    case 'ale': exportALE(opts); return;
    case 'mogrt': await exportMogrt(opts); return;
    case 'lottie': exportLottie(opts); return;
    default:
      throw new Error(`Unsupported export format "${String(opts.format)}".`);
  }
}

export interface ExportPreset {
  format: ExportFormat;
  label: string;
  ext: string;
  hint: string;
  /** True when only the desktop build can produce this format. */
  desktopOnly?: boolean;
}

/**
 * The export menu. Hints say what each format is actually for and what it costs,
 * because the choice is otherwise opaque — and because an earlier version of this
 * list advertised things that were not true ("requires backend online" for a
 * format that renders locally, "Re-openable Motion project file" for a shape
 * nothing could open).
 */
export const EXPORT_PRESETS: ExportPreset[] = [
  { format: 'mp4', label: 'MP4 · H.264', ext: 'mp4', hint: 'Plays everywhere. Best default for sharing.', desktopOnly: true },
  { format: 'webm', label: 'WebM · VP9', ext: 'webm', hint: 'Smaller than MP4, keeps transparency, ideal for the web.', desktopOnly: true },
  { format: 'mov', label: 'MOV · ProRes', ext: 'mov', hint: 'For editing in another app. 4444 keeps alpha; the 422 profiles halve the file for opaque delivery.', desktopOnly: true },
  { format: 'gif', label: 'Animated GIF', ext: 'gif', hint: 'No audio, 256 colours. Keep it short and small.', desktopOnly: true },
  { format: 'wav', label: 'Audio only · WAV', ext: 'wav', hint: 'The comp’s mixed audio as 48kHz 16-bit stereo PCM. No picture.', desktopOnly: true },
  { format: 'png-sequence', label: 'PNG sequence', ext: 'zip', hint: 'Lossless frames with alpha, zipped. The archival option.', desktopOnly: true },
  { format: 'jpg-sequence', label: 'JPEG sequence', ext: 'zip', hint: 'Smaller frames, no alpha.', desktopOnly: true },
  { format: 'exr-sequence', label: 'EXR sequence', ext: 'zip', hint: 'Half-float linear RGB per frame. Prefers GPU linear RT readback (WebGL2 sync / WebGPU async); falls back to display undo-gamma.', desktopOnly: true },
  { format: 'png', label: 'Still frame', ext: 'png', hint: 'The current frame as one PNG.', desktopOnly: true },
  { format: 'lottie', label: 'Lottie', ext: 'json', hint: 'Vector animation for web/mobile players. Shapes only.' },
  { format: 'json', label: 'Project file', ext: 'json', hint: 'The editable document, re-openable with File ▸ Open.' },
  { format: 'edl', label: 'EDL (CMX 3600)', ext: 'edl', hint: 'Clip list for Premiere / Avid. No nested comps or AAF.' },
  { format: 'otio', label: 'OpenTimelineIO', ext: 'otio', hint: 'Editorial interchange: Resolve opens it natively; OTIO adapters convert to AAF/FCPXML. Cuts only — no effects.' },
  { format: 'fcpxml', label: 'FCPXML', ext: 'fcpxml', hint: 'Final Cut / Premiere XML cuts. Same clip bars as EDL — no nested comps.' },
  { format: 'ale', label: 'ALE (Avid)', ext: 'ale', hint: 'Avid Log Exchange cut list. Binary AAF still needs OTIO adapters.' },
  { format: 'mogrt', label: 'Essential Graphics (.mogrt.zip)', ext: 'zip', hint: 'Premation template package (fields + project). Not Adobe AME — re-importable here.' },
];

/** Presets this build can actually produce. */
export function availableExportPresets(): ExportPreset[] {
  const local = canEncodeLocally();
  return EXPORT_PRESETS.filter((p) => local || !p.desktopOnly);
}

