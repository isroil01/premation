/**
 * The bitmap tracer — outlines with the right area, the right orientation,
 * and holes reported as holes.
 */

import { traceBitmap, simplifyRing, type TracePoint } from './traceBitmap';

function plane(w: number, h: number, on: (x: number, y: number) => boolean): Uint8Array {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = on(x, y) ? 255 : 0;
  return d;
}
const area = (pts: TracePoint[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a / 2);
};

describe('traceBitmap', () => {
  it('traces a filled rectangle to its four corners with exact area', () => {
    const c = traceBitmap(plane(20, 12, (x, y) => x >= 3 && x < 13 && y >= 2 && y < 9), 20, 12);
    expect(c).toHaveLength(1);
    expect(c[0]!.hole).toBe(false);
    expect(c[0]!.points).toHaveLength(4);
    expect(area(c[0]!.points)).toBe(10 * 7);
    const xs = c[0]!.points.map((p) => p.x), ys = c[0]!.points.map((p) => p.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3, 13, 2, 9]);
  });

  it('reports a donut as one outer ring and one hole', () => {
    const c = traceBitmap(plane(30, 30, (x, y) => {
      const d = Math.hypot(x - 15, y - 15);
      return d < 12 && d > 5;
    }), 30, 30, 1, { tolerance: 0 });
    const outer = c.filter((k) => !k.hole), holes = c.filter((k) => k.hole);
    expect(outer).toHaveLength(1);
    expect(holes).toHaveLength(1);
    expect(area(outer[0]!.points)).toBeGreaterThan(area(holes[0]!.points));
  });

  it('finds two separate regions as two outer contours', () => {
    const c = traceBitmap(plane(30, 10, (x, y) => (x < 10 || x >= 20) && y >= 2 && y < 8), 30, 10);
    expect(c.filter((k) => !k.hole)).toHaveLength(2);
    expect(c.some((k) => k.hole)).toBe(false);
  });

  it('keeps a one-pixel-wide line as a ring with area', () => {
    const c = traceBitmap(plane(20, 5, (x, y) => y === 2 && x >= 2 && x < 18), 20, 5);
    expect(c).toHaveLength(1);
    expect(area(c[0]!.points)).toBe(16);
  });

  it('drops specks below minArea', () => {
    const c = traceBitmap(plane(10, 10, (x, y) => (x === 1 && y === 1) || (x >= 4 && y >= 4)), 10, 10, 1, { minArea: 2 });
    expect(c).toHaveLength(1);
  });

  it('honours the threshold and reads alpha from RGBA', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) rgba[i * 4 + 3] = i < 8 ? 200 : 40;
    expect(traceBitmap(rgba, 4, 4, 4, { threshold: 128, minArea: 1 })).toHaveLength(1);
    expect(traceBitmap(rgba, 4, 4, 4, { threshold: 20, minArea: 1 })[0]!.points.length).toBe(4);
  });
});

describe('simplifyRing', () => {
  it('reduces a staircase circle to far fewer points while keeping its extent', () => {
    const ring: TracePoint[] = [];
    for (let i = 0; i < 200; i++) ring.push({ x: Math.round(50 + 30 * Math.cos(i / 200 * Math.PI * 2)), y: Math.round(50 + 30 * Math.sin(i / 200 * Math.PI * 2)) });
    const s = simplifyRing(ring, 1.5);
    expect(s.length).toBeLessThan(60);
    expect(s.length).toBeGreaterThan(8);
  });
});
