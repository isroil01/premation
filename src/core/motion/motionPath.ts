/**
 * Motion paths (Prompt E4) — turn a layer's position keyframes into a spatial
 * path so it can be drawn on the canvas (an editable bezier trajectory, AE-style)
 * and so a layer can auto-orient along its direction of travel.
 *
 * The maths is pure and sampler-driven (tested without the engine); thin engine
 * wrappers read the x/y tracks and build the position sampler. Everything is in
 * composition/world space — the overlay converts to screen via the camera.
 */

import { defaultAnimation, type AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';

export interface PathSample {
  /** Time in seconds. */
  t: number;
  /** Composition-space position. */
  x: number;
  y: number;
}

// ── Pure geometry (tested) ───────────────────────────────────────────

/** Heading in degrees for a velocity vector, or null when stationary. */
export function velocityAngleDeg(dx: number, dy: number): number | null {
  if (dx === 0 && dy === 0) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * Sample a path across [min,max] into n+1 evenly-spaced points using `sampleXY`.
 * Degenerate ranges collapse to a single sample. Pure.
 */
export function samplePath(
  min: number,
  max: number,
  n: number,
  sampleXY: (t: number) => { x: number; y: number },
): PathSample[] {
  if (n < 1 || max <= min) {
    const p = sampleXY(min);
    return [{ t: min, x: p.x, y: p.y }];
  }
  const out: PathSample[] = [];
  for (let i = 0; i <= n; i++) {
    const t = min + ((max - min) * i) / n;
    const p = sampleXY(t);
    out.push({ t, x: p.x, y: p.y });
  }
  return out;
}

// ── Engine-facing helpers ────────────────────────────────────────────

/** Static x/y from the node's Transform component (fallback when unanimated). */
function baseXY(node: SceneNode): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number') x = p.x;
    if (typeof p.y === 'number') y = p.y;
  }
  return { x, y };
}

/** True when the layer has a position (x or y) animation. */
export function hasPositionAnimation(nodeId: string, engine: AnimationEngine = defaultAnimation): boolean {
  return engine.isAnimated(nodeId, 'x') || engine.isAnimated(nodeId, 'y');
}

/** A sampler giving the layer's animated position at any time. */
export function positionSamplerFor(
  node: SceneNode,
  engine: AnimationEngine = defaultAnimation,
): (t: number) => { x: number; y: number } {
  const base = baseXY(node);
  return (t) => ({
    x: engine.sample(node.id, 'x', t) ?? base.x,
    y: engine.sample(node.id, 'y', t) ?? base.y,
  });
}

/** The [min,max] time span across the x and y keyframes (null when none). */
export function positionSpan(
  nodeId: string,
  engine: AnimationEngine = defaultAnimation,
): { min: number; max: number } | null {
  const xs = engine.getTrackKeyframes(nodeId, 'x') ?? [];
  const ys = engine.getTrackKeyframes(nodeId, 'y') ?? [];
  const times = [...xs, ...ys].map((k) => k.t);
  if (!times.length) return null;
  return { min: Math.min(...times), max: Math.max(...times) };
}

/** Distinct, sorted keyframe times across the x and y tracks. */
export function keyframeTimes(nodeId: string, engine: AnimationEngine = defaultAnimation): number[] {
  const xs = engine.getTrackKeyframes(nodeId, 'x') ?? [];
  const ys = engine.getTrackKeyframes(nodeId, 'y') ?? [];
  return [...new Set([...xs, ...ys].map((k) => k.t))].sort((a, b) => a - b);
}

/** Fine samples of the trajectory for drawing the smooth path curve. */
export function motionPathSamples(
  node: SceneNode,
  engine: AnimationEngine = defaultAnimation,
  perSegment = 16,
): PathSample[] {
  const span = positionSpan(node.id, engine);
  if (!span || span.max <= span.min) return [];
  const segments = Math.max(1, keyframeTimes(node.id, engine).length - 1);
  const n = Math.max(8, perSegment * segments);
  return samplePath(span.min, span.max, n, positionSamplerFor(node, engine));
}

/** The trajectory position at each keyframe time (drawn as draggable dots). */
export function motionPathKeyframes(
  node: SceneNode,
  engine: AnimationEngine = defaultAnimation,
): PathSample[] {
  const sampler = positionSamplerFor(node, engine);
  return keyframeTimes(node.id, engine).map((t) => {
    const p = sampler(t);
    return { t, x: p.x, y: p.y };
  });
}

/**
 * Samples of the trajectory at every composition frame (dt = 1 / fps).
 * These correspond to AE's per-frame velocity tick dots along the motion path,
 * where dot spacing provides instant visual feedback of velocity and easing.
 */
export function motionPathFrameSamples(
  node: SceneNode,
  fps = 30,
  engine: AnimationEngine = defaultAnimation,
): PathSample[] {
  const span = positionSpan(node.id, engine);
  if (!span || span.max <= span.min) return [];
  const safeFps = Math.max(1, fps);
  const dt = 1 / safeFps;
  const sampler = positionSamplerFor(node, engine);
  const out: PathSample[] = [];

  const eps = 1e-5;
  for (let t = span.min; t <= span.max + eps; t += dt) {
    const clampedT = Math.min(span.max, t);
    const p = sampler(clampedT);
    out.push({ t: clampedT, x: p.x, y: p.y });
    if (clampedT >= span.max - eps) break;
  }
  return out;
}

// ── Spatial bezier tangents (curved motion paths) ────────────────────

/** One keyframe's tangent handles in comp space, at their EFFECTIVE positions
 *  (explicit spatial tangents, or the linear third-point default so a handle is
 *  always grabbable). `out`/`in` are absolute comp positions; null at the ends
 *  of the path where no segment exists. */
export interface PathTangents {
  t: number;
  x: number;
  y: number;
  out: { x: number; y: number } | null;
  in: { x: number; y: number } | null;
}

/** Value + spatial tangents of the keyframe at `t` on one scalar track. */
function kfAt(
  nodeId: string,
  prop: 'x' | 'y',
  t: number,
  engine: AnimationEngine,
): { value: number; si?: number; so?: number } | null {
  const kf = (engine.getTrackKeyframes(nodeId, prop) ?? []).find((k) => k.t === t);
  return kf ? { value: kf.value, si: kf.si, so: kf.so } : null;
}

/**
 * The selected layer's motion-path keyframes with their tangent handles, for
 * the canvas overlay (draw + hit-test). Uses the path sampler for positions so
 * it matches the drawn trajectory even when one axis lacks a keyframe at `t`.
 */
export function motionPathTangents(
  node: SceneNode,
  engine: AnimationEngine = defaultAnimation,
): PathTangents[] {
  const times = keyframeTimes(node.id, engine);
  const sampler = positionSamplerFor(node, engine);
  return times.map((t, i) => {
    const p = sampler(t);
    const kx = kfAt(node.id, 'x', t, engine);
    const ky = kfAt(node.id, 'y', t, engine);
    let out: { x: number; y: number } | null = null;
    let inn: { x: number; y: number } | null = null;
    if (i < times.length - 1) {
      const n = sampler(times[i + 1]!);
      out = {
        x: p.x + (kx?.so ?? (n.x - p.x) / 3),
        y: p.y + (ky?.so ?? (n.y - p.y) / 3),
      };
    }
    if (i > 0) {
      const q = sampler(times[i - 1]!);
      inn = {
        x: p.x + (kx?.si ?? (q.x - p.x) / 3),
        y: p.y + (ky?.si ?? (q.y - p.y) / 3),
      };
    }
    return { t, x: p.x, y: p.y, out, in: inn };
  });
}

/**
 * Write one tangent handle of the keyframe at `t` from an absolute comp-space
 * handle position. `mirror` reflects the opposite handle (smooth point,
 * AE-default); without it the point is "broken". Callers wrap in runAnimEdit.
 */
export function setPathTangent(
  nodeId: string,
  t: number,
  which: 'in' | 'out',
  handle: { x: number; y: number },
  mirror: boolean,
  engine: AnimationEngine = defaultAnimation,
): void {
  const kx = kfAt(nodeId, 'x', t, engine);
  const ky = kfAt(nodeId, 'y', t, engine);
  if (!kx || !ky) return;
  const dx = handle.x - kx.value;
  const dy = handle.y - ky.value;
  const key = which === 'out' ? 'so' : 'si';
  const opp = which === 'out' ? 'si' : 'so';
  engine.setSpatialTangent(nodeId, 'x', t, { [key]: dx });
  engine.setSpatialTangent(nodeId, 'y', t, { [key]: dy });
  if (mirror) {
    engine.setSpatialTangent(nodeId, 'x', t, { [opp]: -dx });
    engine.setSpatialTangent(nodeId, 'y', t, { [opp]: -dy });
  }
}

/** Auto-bezier the position path (smooth curve through every keyframe). */
export function smoothMotionPath(nodeId: string, engine: AnimationEngine = defaultAnimation): void {
  engine.smoothSpatialTangents(nodeId, 'x');
  engine.smoothSpatialTangents(nodeId, 'y');
}

/** Remove all spatial tangents from the position path (straight segments). */
export function straightenMotionPath(nodeId: string, engine: AnimationEngine = defaultAnimation): void {
  engine.clearSpatialTangents(nodeId, 'x');
  engine.clearSpatialTangents(nodeId, 'y');
}

/** True when any position keyframe carries an explicit spatial tangent. */
export function hasPathTangents(nodeId: string, engine: AnimationEngine = defaultAnimation): boolean {
  for (const prop of ['x', 'y'] as const) {
    const kfs = engine.getTrackKeyframes(nodeId, prop) ?? [];
    if (kfs.some((k) => k.si !== undefined || k.so !== undefined)) return true;
  }
  return false;
}

/** Direction of travel (degrees) at time `t`, or null when not moving. */
export function autoOrientAngleDeg(
  node: SceneNode,
  t: number,
  engine: AnimationEngine = defaultAnimation,
  eps = 1 / 120,
): number | null {
  const sampler = positionSamplerFor(node, engine);
  const p0 = sampler(t);
  const p1 = sampler(t + eps);
  return velocityAngleDeg(p1.x - p0.x, p1.y - p0.y);
}
