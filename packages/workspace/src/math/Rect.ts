/**
 * Axis-aligned rectangle helpers. `{ x, y }` is the top-left corner; width/height
 * are non-negative by convention. Used for viewport bounds, node AABBs, marquee
 * regions, and spatial-index queries.
 */

import type { Vec2 } from './Vec2';
import type { Mat2D } from './Mat2D';
import { apply } from './Mat2D';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rect(x = 0, y = 0, width = 0, height = 0): Rect {
  return { x, y, width, height };
}

export function fromPoints(a: Vec2, b: Vec2): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function fromCenter(center: Vec2, width: number, height: number): Rect {
  return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

export function left(r: Rect): number {
  return r.x;
}
export function right(r: Rect): number {
  return r.x + r.width;
}
export function top(r: Rect): number {
  return r.y;
}
export function bottom(r: Rect): number {
  return r.y + r.height;
}

export function center(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function area(r: Rect): number {
  return r.width * r.height;
}

/** The four corners, clockwise from top-left. */
export function corners(r: Rect): [Vec2, Vec2, Vec2, Vec2] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

export function containsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** True when `outer` fully contains `inner`. */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** True when the two rects overlap (edge touch counts as intersecting). */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r < x || btm < y) return null;
  return { x, y, width: r - x, height: btm - y };
}

/** Smallest rect containing both. */
export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.width, b.x + b.width);
  const btm = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: r - x, height: btm - y };
}

/** Union of many rects; null when the list is empty. */
export function bounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let out = rects[0]!;
  for (let i = 1; i < rects.length; i++) out = union(out, rects[i]!);
  return { ...out };
}

export function inflate(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: r.width + dx * 2, height: r.height + dy * 2 };
}

export function translate(r: Rect, delta: Vec2): Rect {
  return { x: r.x + delta.x, y: r.y + delta.y, width: r.width, height: r.height };
}

/** AABB of `r` after applying an affine transform (handles rotation/skew). */
export function transform(r: Rect, m: Mat2D): Rect {
  const pts = corners(r).map((c) => apply(m, c));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function equals(a: Rect, b: Rect, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.width - b.width) < epsilon &&
    Math.abs(a.height - b.height) < epsilon
  );
}
