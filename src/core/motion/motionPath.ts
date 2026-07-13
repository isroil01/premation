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
