/**
 * PAINT STROKES over the engine API (B3; ENGINE_API.md §4.7): the layer's
 * `fx.paint` — `{strokes: PaintStroke[], onTransparent?}` (src/core/paint/
 * paintStrokes.ts) — as commands, validated before anything changes:
 *
 *   addPaintStroke        append one normalised stroke (engine-minted `pstroke_<n>`)
 *                         + keyframes on its numeric params (Write On's End keys)
 *   updatePaintStroke     merge a JSON patch (null clears a key), renormalise
 *   removePaintStrokes    strokes + every `paint.<id>.` track / expression / data track
 *   setPaintOnTransparent the layer flag
 *   setPaintStrokePath    AE's "draw with a stroke selected": a Path key when the
 *                         Path is animated, else the static points (pen input dropped)
 *   setPaintPathAnimated  the Path stopwatch
 *
 * Writes go straight to the scene graph and the animation engine (no events,
 * no bumpScene — the engine refreshes the panels). The C++ engine ports this
 * file (native/engine/src/core/handlers_strokes.cpp).
 */

import { defaultAnimation } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { normalizeStroke, readNodePaint, type PaintConfig, type PaintStroke } from '@core/paint/paintStrokes';
import { PAINT_CLONE_KEYS, PAINT_OPTION_KEYS, PAINT_TRANSFORM_KEYS } from '@core/paint/paintProps';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { graph } from './doc';
import { fail } from './errors';
import { dropTrackProps } from './fields';
import { flicksToSeconds } from './time';

type Pt = { x: number; y: number };
type Raw = Record<string, unknown>;

const NUMERIC_PARAMS: ReadonlySet<string> = new Set<string>([...PAINT_OPTION_KEYS, ...PAINT_CLONE_KEYS, ...PAINT_TRANSFORM_KEYS]);

export function isPaintNumericParam(param: string): boolean {
  return NUMERIC_PARAMS.has(param);
}

/** `text` as a JSON object, else invalidArgument. */
export function parsePaintObject(text: string, what: string, layer: string): Raw {
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch {
    fail('invalidArgument', `'${what}' is not valid json`, { layer });
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalidArgument', `'${what}' must be a json object`, { layer });
  return v as Raw;
}

/** A non-empty array of objects with finite `x` / `y`, else invalidArgument. */
export function checkPaintPoints(v: unknown, what: string, layer: string): asserts v is Pt[] {
  const ok = Array.isArray(v) && v.length > 0 && v.every((p) => !!p && typeof p === 'object' && !Array.isArray(p)
    && Number.isFinite((p as Raw).x) && Number.isFinite((p as Raw).y));
  if (!ok) fail('invalidArgument', `'${what}' must be a non-empty array of finite {x, y}`, { layer });
}

/** A JSON array of points (setPaintStrokePath). */
export function parsePaintPoints(text: string, layer: string): Pt[] {
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch {
    fail('invalidArgument', `'points' is not valid json`, { layer });
  }
  checkPaintPoints(v, 'points', layer);
  return v.map((p) => ({ x: p.x, y: p.y }));
}

/** The layer's paint and the index of stroke `id` in it, else notFound. */
export function paintStrokeOrFail(layer: string, node: SceneNode, id: string): { cfg: PaintConfig; index: number } {
  const cfg = readNodePaint(node);
  const index = cfg ? cfg.strokes.findIndex((s) => s.id === id) : -1;
  if (!cfg || index < 0) fail('notFound', `layer '${layer}' has no paint stroke '${id}'`, { layer, path: `paint/${id}` });
  return { cfg, index };
}

/** paintStrokes.ts `writePaint` without the notifications. */
export function storePaint(layer: string, strokes: PaintStroke[], onTransparent: boolean | undefined): void {
  graph.setPaint(layer, strokes.length > 0 || onTransparent
    ? { strokes, ...(onTransparent ? { onTransparent: true } : {}) }
    : { strokes: [] });
}

export function paintPathTrack(id: string): string {
  return `paint.${id}.path`;
}

/** Every animation prop (track, expression, data track) of the layer under `paint.<id>.`. */
export function paintStrokeProps(layer: string, ids: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const snap = defaultAnimation.snapshotNode(layer);
  if (!snap) return out;
  for (const section of [snap.tracks, snap.expressions, snap.data] as Array<Record<string, unknown>>) {
    for (const p of Object.keys(section)) {
      const m = /^paint\.([^.]+)\./.exec(p);
      if (m && ids.has(m[1]!)) out.add(p);
    }
  }
  return out;
}

/** Drop the strokes' tracks, then the strokes (the paint's `onTransparent` kept). */
export function removeStrokes(layer: string, cfg: PaintConfig, ids: ReadonlySet<string>): void {
  dropTrackProps(layer, paintStrokeProps(layer, ids));
  storePaint(layer, cfg.strokes.filter((s) => !ids.has(s.id)), cfg.onTransparent);
}

/** Merge a patch into stroke `index` (null clears a key) and renormalise. */
export function patchStroke(layer: string, cfg: PaintConfig, index: number, patch: Raw): void {
  const s = cfg.strokes[index]!;
  const merged: Raw = { ...(s as unknown as Raw), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete merged[k];
  const strokes = cfg.strokes.slice();
  strokes[index] = normalizeStroke(merged as unknown as PaintStroke, s.id);
  storePaint(layer, strokes, cfg.onTransparent);
}

/** A Path key at comp time `flicks` (AnimationEngine.setDataKeyframe: a key already there keeps its easing / id). */
export function keyPaintPath(layer: string, id: string, flicks: number, points: Pt[]): void {
  const prop = paintPathTrack(id);
  const t = compToKeyframeTime(layer, flicksToSeconds(flicks), prop);
  defaultAnimation.setDataKeyframe(layer, prop, 'points', t, points.map((p) => ({ x: p.x, y: p.y })));
}
