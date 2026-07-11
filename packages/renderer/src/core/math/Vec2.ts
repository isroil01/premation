/** Immutable-friendly 2D vector helpers (plain objects, no allocation churn). */
export interface Vec2 {
  x: number;
  y: number;
}

export const Vec2 = {
  of(x: number, y: number): Vec2 {
    return { x, y };
  },
  zero(): Vec2 {
    return { x: 0, y: 0 };
  },
  add(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x + b.x, y: a.y + b.y };
  },
  sub(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x - b.x, y: a.y - b.y };
  },
  scale(a: Vec2, s: number): Vec2 {
    return { x: a.x * s, y: a.y * s };
  },
  mul(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x * b.x, y: a.y * b.y };
  },
  dot(a: Vec2, b: Vec2): number {
    return a.x * b.x + a.y * b.y;
  },
  length(a: Vec2): number {
    return Math.hypot(a.x, a.y);
  },
  equals(a: Vec2, b: Vec2, eps = 1e-6): boolean {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  },
};
