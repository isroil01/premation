/**
 * Keyframe tracks for EVERY stroke in a layer's stack, and the fold that lays
 * them over the stored strokes.
 *
 * ## Why this is its own module
 *
 * The fold used to live inline in `buildSnapshot` and bound every track to
 * strokes[0]: a second stroke could be added, but its width, colour and dashes
 * were frozen — AE treats every Stroke in Contents as a full citizen with its
 * own stopwatches. One table of track names and one resolver means the
 * renderer, the inspector, the timeline tree and the Lottie exporter cannot
 * disagree about what `stroke.2.dash1` means.
 *
 * ## Paths
 *
 *   index 0   the ORIGINAL flat names (`strokeWidth`, `stroke_r`, …). Documents
 *             keyed before multi-stroke tracks existed keep animating with no
 *             migration, and the text-layer/inspector code that already
 *             writes these names keeps working.
 *   index ≥1  `stroke.<index>.<param>`, colour channels `stroke.<index>.color_r`.
 *
 * Index-scoped, not id-scoped: strokes carry no id, and giving them one would
 * put a new field into every stored stroke (and every raster cache key).
 * Removing a stroke re-keys the tracks above it — `removeNodeStrokeAt`.
 *
 * ## The quoted names are load-bearing
 *
 * `animatablePropertyReaders.test.ts` passes a keyframeable property only when
 * its name appears QUOTED in the pixel path. The table below is that quote.
 */

import type { Stroke, StrokeGradientGeometry } from '@core/paint/stroke';
import type { FillPaint } from '@core/paint/fill';
import { Color } from '@motion/renderer';

/** Every per-stroke keyframeable parameter, in AE's Stroke group order. */
export const STROKE_TRACK_PARAMS = [
  'color', 'opacity', 'width', 'miterLimit',
  'dash1', 'gap1', 'dash2', 'gap2', 'dash3', 'gap3', 'dashOffset',
  'taperStartLength', 'taperEndLength', 'taperStartWidth', 'taperEndWidth', 'taperStartEase', 'taperEndEase',
  'waveAmount', 'waveWavelength', 'wavePhase',
  'gradientStartX', 'gradientStartY', 'gradientEndX', 'gradientEndY', 'highlightLength', 'highlightAngle',
] as const;

export type StrokeTrackParam = typeof STROKE_TRACK_PARAMS[number];

/** The dash-pattern slots, in pattern order: AE's three Dash/Gap pairs. */
export const STROKE_DASH_PARAMS = ['dash1', 'gap1', 'dash2', 'gap2', 'dash3', 'gap3'] as const;

/** AE's cap: three dash/gap pairs. */
export const MAX_STROKE_DASH_ENTRIES = STROKE_DASH_PARAMS.length;

/** strokes[0]'s names — see the header. `color` is a channel PREFIX. */
const PRIMARY_TRACKS: Readonly<Record<StrokeTrackParam, string>> = {
  color: 'stroke',
  opacity: 'strokeOpacity',
  width: 'strokeWidth',
  miterLimit: 'strokeMiterLimit',
  dash1: 'strokeDash1',
  gap1: 'strokeGap1',
  dash2: 'strokeDash2',
  gap2: 'strokeGap2',
  dash3: 'strokeDash3',
  gap3: 'strokeGap3',
  dashOffset: 'strokeDashOffset',
  taperStartLength: 'strokeTaperStartLength',
  taperEndLength: 'strokeTaperEndLength',
  taperStartWidth: 'strokeTaperStartWidth',
  taperEndWidth: 'strokeTaperEndWidth',
  taperStartEase: 'strokeTaperStartEase',
  taperEndEase: 'strokeTaperEndEase',
  waveAmount: 'strokeWaveAmount',
  waveWavelength: 'strokeWaveWavelength',
  wavePhase: 'strokeWavePhase',
  gradientStartX: 'strokeGradientStartX',
  gradientStartY: 'strokeGradientStartY',
  gradientEndX: 'strokeGradientEndX',
  gradientEndY: 'strokeGradientEndY',
  highlightLength: 'strokeHighlightLength',
  highlightAngle: 'strokeHighlightAngle',
};

const PRIMARY_BY_NAME = new Map<string, StrokeTrackParam>(
  (Object.entries(PRIMARY_TRACKS) as Array<[StrokeTrackParam, string]>)
    .filter(([p]) => p !== 'color')
    .map(([p, name]) => [name, p]),
);

const COLOR_CHANNELS = ['_r', '_g', '_b', '_a'] as const;

/** The track path of `param` on the stroke at `index` (colour: the channel prefix). */
export function strokeTrackPath(index: number, param: StrokeTrackParam): string {
  if (index <= 0) return PRIMARY_TRACKS[param];
  return `stroke.${index}.${param}`;
}

/** The four colour-channel tracks of the stroke at `index`. */
export function strokeColorChannelPaths(index: number): string[] {
  const prefix = strokeTrackPath(index, 'color');
  return COLOR_CHANNELS.map((c) => `${prefix}${c}`);
}

/** Every track path the stroke at `index` can own — what a re-key moves. */
export function strokeTrackPathsFor(index: number): string[] {
  return [
    ...strokeColorChannelPaths(index),
    ...STROKE_TRACK_PARAMS.filter((p) => p !== 'color').map((p) => strokeTrackPath(index, p)),
  ];
}

/** The dash slot param for position `k` of a dash pattern. */
export function dashParamAt(k: number): StrokeTrackParam | undefined {
  return STROKE_DASH_PARAMS[k];
}

/**
 * `{ index, param, channel? }` for a stroke track path, or null.
 *
 * Primary names parse to index 0, so a caller that labels or groups a track
 * never has to special-case the legacy spelling.
 */
export function parseStrokeTrackPath(
  path: string,
): { index: number; param: StrokeTrackParam; channel?: '_r' | '_g' | '_b' | '_a' } | null {
  const primaryChannel = /^stroke(_[rgba])$/.exec(path);
  if (primaryChannel) return { index: 0, param: 'color', channel: primaryChannel[1] as '_r' };
  const primary = PRIMARY_BY_NAME.get(path);
  if (primary) return { index: 0, param: primary };
  const m = /^stroke\.(\d+)\.([A-Za-z0-9]+)(_[rgba])?$/.exec(path);
  if (!m) return null;
  const index = Number(m[1]);
  const param = m[2] as StrokeTrackParam;
  if (!(index >= 1) || !(STROKE_TRACK_PARAMS as readonly string[]).includes(param)) return null;
  if (m[3]) return param === 'color' ? { index, param, channel: m[3] as '_r' } : null;
  return param === 'color' ? null : { index, param };
}

/**
 * The Start/End points a legacy gradient paint IMPLIES — `makeCanvasGradient`'s
 * own geometry, re-expressed in the relative box units `StrokeGradientGeometry`
 * stores.
 *
 * This is what makes a first handle drag, or a first keyframe on one point,
 * continue from the gradient on screen instead of jumping to a default: the
 * other three coordinates come from here.
 */
export function strokeGradientGeometryFor(
  paint: FillPaint | undefined,
  w: number,
  h: number,
): StrokeGradientGeometry {
  const rel = (px: number, extent: number): number => (extent > 0 ? 0.5 + px / extent : 0.5);
  if (!paint || paint.type === 'solid') return { startX: 0.5, startY: 0, endX: 0.5, endY: 1 };
  if (paint.type === 'linear') {
    const a = (paint.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    return {
      startX: rel(-dx * half, w), startY: rel(-dy * half, h),
      endX: rel(dx * half, w), endY: rel(dy * half, h),
    };
  }
  const r = (Math.max(0.01, paint.radius) * Math.hypot(w, h)) / 2;
  return {
    startX: paint.cx, startY: paint.cy,
    endX: paint.cx + (w > 0 ? r / w : 0), endY: paint.cy,
  };
}

/**
 * One stroke with every live track at `index` laid over it.
 *
 * ORDER IS PRESERVED from the inline fold this replaced — dash offset, width,
 * taper, wave, colour — and each step spreads the previous result, because the
 * resolved object is serialised into the raster cache key: the same animated
 * layer must produce the same key it always did. The fields that are new here
 * (opacity, miter limit, dash values, gradient points) fold AFTER, so a layer
 * without their tracks cannot see them.
 *
 * Every fallback is the STORED value, never a constant — animating one field
 * must not reset its siblings.
 */
export function resolveStrokeTracks(
  stroke: Stroke,
  index: number,
  a: ReadonlyMap<string, number> | undefined,
  w: number,
  h: number,
): Stroke {
  if (!a || a.size === 0) return stroke;
  const path = (p: StrokeTrackParam): string => strokeTrackPath(index, p);
  const has = (p: StrokeTrackParam): boolean => a.has(path(p));
  const num = (p: StrokeTrackParam, fallback: number): number => {
    const v = a.get(path(p));
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  let s = stroke;

  // Dash offset: arc length along the path (see `Stroke.dashOffset`).
  if (has('dashOffset')) s = { ...s, dashOffset: a.get(path('dashOffset')) ?? 0 };
  // Width: clamped at 0 — an overshooting ease undershoots between keys, and a
  // negative lineWidth is a Canvas2D exception rather than a thinner stroke.
  if (has('width')) {
    const v = a.get(path('width'));
    if (typeof v === 'number' && Number.isFinite(v)) s = { ...s, width: Math.max(0, v) };
  }
  // Taper and Wave, each falling back to the STORED profile.
  if (has('taperStartWidth') || has('taperEndWidth') || has('taperStartLength')
    || has('taperEndLength') || has('taperStartEase') || has('taperEndEase')) {
    const t = s.taper;
    s = { ...s, taper: {
      startWidth: num('taperStartWidth', t?.startWidth ?? 1),
      endWidth: num('taperEndWidth', t?.endWidth ?? 1),
      startLength: num('taperStartLength', t?.startLength ?? 0),
      endLength: num('taperEndLength', t?.endLength ?? 0),
      startEase: num('taperStartEase', t?.startEase ?? 0),
      endEase: num('taperEndEase', t?.endEase ?? 0),
      ...(t?.lengthUnits === 'pixels' ? { lengthUnits: 'pixels' as const } : {}),
    } };
  }
  if (has('waveAmount') || has('waveWavelength') || has('wavePhase')) {
    const wv = s.wave;
    s = { ...s, wave: {
      amount: num('waveAmount', wv?.amount ?? 0),
      wavelength: num('waveWavelength', wv?.wavelength ?? 0),
      phase: num('wavePhase', wv?.phase ?? 0),
      ...(wv?.units === 'cycles' ? { units: 'cycles' as const } : {}),
    } };
  }
  // Colour: four channels, gated on red — the rule the colour rows write by.
  const [rP, gP, bP, aP] = strokeColorChannelPaths(index);
  if (a.has(rP!)) {
    s = { ...s, color: Color.toHex({ r: a.get(rP!) ?? 0, g: a.get(gP!) ?? 0, b: a.get(bP!) ?? 0, a: a.get(aP!) ?? 1 }) };
  }

  // ── New in the multi-stroke fold ──
  // Opacity: a REAL track, multiplied by the colour's own alpha at draw time
  // exactly as the static opacity always was.
  if (has('opacity')) s = { ...s, opacity: Math.max(0, Math.min(1, num('opacity', s.opacity))) };
  // Floored at 1: Canvas2D ignores a miter limit below it.
  if (has('miterLimit')) s = { ...s, miterLimit: Math.max(1, num('miterLimit', s.miterLimit ?? 4)) };
  // Each STORED dash slot takes its own track. A track for a slot the pattern
  // does not have is ignored — the pattern's length is structure, not a value.
  if (s.dash.length > 0 && s.dash.some((_, k) => { const p = dashParamAt(k); return !!p && has(p); })) {
    s = { ...s, dash: s.dash.map((v, k) => {
      const p = dashParamAt(k);
      return p ? Math.max(0, num(p, v)) : v;
    }) };
  }
  // Gradient points: only meaningful on a gradient paint; the unkeyed three
  // come from what the stroke already shows (see strokeGradientGeometryFor).
  if (s.paint && s.paint.type !== 'solid' && (has('gradientStartX') || has('gradientStartY')
    || has('gradientEndX') || has('gradientEndY') || has('highlightLength') || has('highlightAngle'))) {
    const g = s.gradient ?? strokeGradientGeometryFor(s.paint, w, h);
    const hl = has('highlightLength') ? num('highlightLength', 0) : g.highlightLength;
    const ha = has('highlightAngle') ? num('highlightAngle', 0) : g.highlightAngle;
    s = { ...s, gradient: {
      startX: num('gradientStartX', g.startX),
      startY: num('gradientStartY', g.startY),
      endX: num('gradientEndX', g.endX),
      endY: num('gradientEndY', g.endY),
      ...(hl !== undefined ? { highlightLength: hl } : {}),
      ...(ha !== undefined ? { highlightAngle: ha } : {}),
    } };
  }
  return s;
}

/**
 * The layer's resolved `stroke` / `strokes` pair from its FULL stored stack.
 *
 * Tracks bind by STORED index — a disabled stroke 2 still owns `stroke.1.*`,
 * so switching it off and on does not hand its keyframes to its neighbour.
 * Only after resolving are unrenderable entries dropped (on their STORED
 * enabled/width, as `readNodeRenderStrokes` always judged them).
 *
 * `strokes` stays undefined for a single renderable stroke, as before. One
 * deliberate change: when strokes[0] is off and exactly one other stroke is on,
 * that stroke is now returned (it used to be silently dropped — the inline
 * fold sliced the primary slot off the already-filtered list).
 */
export function resolveStrokeStack(
  stack: ReadonlyArray<Stroke>,
  a: ReadonlyMap<string, number> | undefined,
  w: number,
  h: number,
): { stroke?: Stroke; strokes?: Stroke[] } {
  const renderable = (s: Stroke): boolean => s.enabled && s.width > 0;
  const resolved = stack.map((s, i) => (renderable(s) ? resolveStrokeTracks(s, i, a, w, h) : null));
  const primary = resolved[0] ?? undefined;
  const list = resolved.filter((s): s is Stroke => s !== null);
  const strokes = list.length > 1 || (list.length === 1 && !primary) ? list : undefined;
  return { ...(primary ? { stroke: primary } : {}), ...(strokes ? { strokes } : {}) };
}
