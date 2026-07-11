/** Basic geometry primitives shared across the renderer. */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const Rect = {
  of(x: number, y: number, width: number, height: number): Rect {
    return { x, y, width, height };
  },
  right(r: Rect): number {
    return r.x + r.width;
  },
  bottom(r: Rect): number {
    return r.y + r.height;
  },
  area(r: Rect): number {
    return r.width * r.height;
  },
  contains(r: Rect, px: number, py: number): boolean {
    return px >= r.x && py >= r.y && px <= r.x + r.width && py <= r.y + r.height;
  },
  intersects(a: Rect, b: Rect): boolean {
    return !(b.x > Rect.right(a) || Rect.right(b) < a.x || b.y > Rect.bottom(a) || Rect.bottom(b) < a.y);
  },
  intersection(a: Rect, b: Rect): Rect | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(Rect.right(a), Rect.right(b));
    const btm = Math.min(Rect.bottom(a), Rect.bottom(b));
    if (r <= x || btm <= y) return null;
    return { x, y, width: r - x, height: btm - y };
  },
  union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const r = Math.max(Rect.right(a), Rect.right(b));
    const btm = Math.max(Rect.bottom(a), Rect.bottom(b));
    return { x, y, width: r - x, height: btm - y };
  },
  equals(a: Rect, b: Rect, eps = 1e-6): boolean {
    return (
      Math.abs(a.x - b.x) <= eps &&
      Math.abs(a.y - b.y) <= eps &&
      Math.abs(a.width - b.width) <= eps &&
      Math.abs(a.height - b.height) <= eps
    );
  },
};
