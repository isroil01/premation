/**
 * 2D vector helpers over the plain `{ x, y }` value type. Pure functions, no
 * allocations beyond the returned object. Shared by every workspace subsystem so
 * points from the Scene Graph and the renderer interop without conversion.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const ZERO: Readonly<Vec2> = { x: 0, y: 0 };

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function clone(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

export function mul(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x * b.x, y: a.y * b.y };
}

export function negate(v: Vec2): Vec2 {
  return { x: -v.x, y: -v.y };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function lengthSq(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function equals(a: Vec2, b: Vec2, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

export function round(v: Vec2): Vec2 {
  return { x: Math.round(v.x), y: Math.round(v.y) };
}

export function min(a: Vec2, b: Vec2): Vec2 {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
}

export function max(a: Vec2, b: Vec2): Vec2 {
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
}
