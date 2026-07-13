/**
 * Trim Paths (Prompt 11 / MG Phase C) — reveal only a portion of a shape's
 * outline, animatable to draw the stroke on/off. Start/End/Offset are percents
 * of the path length; Offset rotates the visible window around the path (and
 * wraps). Keyframe Offset for a snake-around-the-shape; keyframe End 0→100 to
 * "write on" the stroke.
 *
 * The geometry is pure and sampler-driven so it unit-tests without a canvas:
 * {@link trimSegments} turns the percents into 0..2 normalized arcs, and
 * {@link trimPolyline} slices an outline polyline by those arcs. The render
 * backend samples the layer's outline to a polyline and strokes the result.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export interface TrimPath {
  /** Start of the visible range, percent 0..100. */
  start: number;
  /** End of the visible range, percent 0..100. */
  end: number;
  /** Rotate the window around the path, percent (wraps). */
  offset: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const TRIM_PARAMS = ['start', 'end', 'offset'] as const;
export type TrimParam = (typeof TRIM_PARAMS)[number];

export function trimPropPath(param: TrimParam): string {
  return `trim.${param}`;
}

export function defaultTrim(): TrimPath {
  return { start: 0, end: 100, offset: 0 };
}

// ── Pure geometry (tested) ───────────────────────────────────────────

/**
 * Normalized visible arcs [lo,hi] (each in [0,1]) for a start/end/offset in
 * percent. Returns [] when the window is empty, one arc normally, or two when
 * the offset makes it wrap past the end of the path. Pure.
 */
export function trimSegments(startPct: number, endPct: number, offsetPct: number): Array<[number, number]> {
  const s = startPct / 100;
  const e = endPct / 100;
  const o = offsetPct / 100;
  const len = e - s;
  if (len <= 0) return [];
  if (len >= 1) return [[0, 1]];
  const a = (((s + o) % 1) + 1) % 1; // window start, wrapped into [0,1)
  const b = a + len;
  if (b <= 1) return [[a, b]];
  return [
    [a, 1],
    [0, b - 1],
  ];
}

function segLengths(pts: readonly Pt[], closed: boolean): { lens: number[]; total: number } {
  const n = pts.length;
  const count = closed ? n : n - 1;
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    lens.push(d);
    total += d;
  }
  return { lens, total };
}

/** Point at arc-length `len` along the polyline (clamped to the ends). */
export function pointAtLength(pts: readonly Pt[], closed: boolean, len: number): Pt {
  const n = pts.length;
  const count = closed ? n : n - 1;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + d >= len) {
      const t = d > 0 ? (len - acc) / d : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += d;
  }
  return pts[closed ? 0 : n - 1]!;
}

/**
 * Slice an outline polyline into the visible sub-polylines for `segments`.
 * Each sub-polyline starts/ends at the exact arc-length boundary and includes
 * the original vertices in between. Pure.
 */
export function trimPolyline(
  pts: readonly Pt[],
  closed: boolean,
  segments: ReadonlyArray<readonly [number, number]>,
): Pt[][] {
  if (pts.length < 2) return [];
  const { total } = segLengths(pts, closed);
  if (total <= 0) return [];
  const n = pts.length;
  const count = closed ? n : n - 1;

  const out: Pt[][] = [];
  for (const [lo, hi] of segments) {
    const startLen = lo * total;
    const endLen = hi * total;
    if (endLen <= startLen) continue;
    const sub: Pt[] = [pointAtLength(pts, closed, startLen)];
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const b = pts[(i + 1) % n]!;
      acc += Math.hypot(b.x - pts[i]!.x, b.y - pts[i]!.y);
      if (acc > startLen && acc < endLen) sub.push({ x: b.x, y: b.y });
    }
    sub.push(pointAtLength(pts, closed, endLen));
    out.push(sub);
  }
  return out;
}

// ── Scene integration ────────────────────────────────────────────────

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

function fxProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

/** Static trim config on a node, or null when none. */
export function readTrimConfig(node: SceneNode): TrimPath | null {
  const raw = fxProps(node)?.trim;
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<TrimPath>;
  const d = defaultTrim();
  return { start: num(t.start, d.start), end: num(t.end, d.end), offset: num(t.offset, d.offset) };
}

/** True when the layer has an active trim (not the full 0→100 range). */
export function hasTrim(node: SceneNode): boolean {
  const t = readTrimConfig(node);
  return !!t && !(t.start === 0 && t.end === 100 && t.offset === 0);
}

/** Resolve the trim for a frame, overriding params with animated values. */
export function resolveTrim(node: SceneNode, av: Map<string, number> | undefined): TrimPath | null {
  const base = readTrimConfig(node);
  if (!base) return null;
  const v = (p: TrimParam, fb: number): number => av?.get(trimPropPath(p)) ?? fb;
  return { start: v('start', base.start), end: v('end', base.end), offset: v('offset', base.offset) };
}

/** Add / update / clear the trim config on a layer. */
export function setTrim(nodeId: string, trim: TrimPath | null): void {
  defaultSceneGraph.setTrimPath(nodeId, trim ?? undefined);
  bumpScene();
}

export function updateTrim(nodeId: string, patch: Partial<TrimPath>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const base = readTrimConfig(node) ?? defaultTrim();
  setTrim(nodeId, { ...base, ...patch });
}
