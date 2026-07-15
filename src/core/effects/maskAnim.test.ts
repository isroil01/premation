import { interpolateMask, type MaskKeyframe } from './mask';
import type { LayerMask, MaskPoint } from './mask';

const corner = (x: number, y: number): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const path = (points: MaskPoint[]) => ({ id: 'm', mode: 'add' as const, closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false, points });
const square = (s: number): LayerMask => ({
  paths: [path([corner(-s, -s), corner(s, -s), corner(s, s), corner(-s, s)])],
});

describe('interpolateMask', () => {
  const kfs: MaskKeyframe[] = [
    { t: 0, mask: square(10) },
    { t: 1, mask: square(30) },
  ];

  it('returns the endpoint shapes at/beyond the ends', () => {
    expect(interpolateMask(kfs, 0)!.paths[0]!.points[0]!.x).toBe(-10);
    expect(interpolateMask(kfs, 1)!.paths[0]!.points[2]!.x).toBe(30);
    expect(interpolateMask(kfs, 5)!.paths[0]!.points[2]!.x).toBe(30); // clamped
  });

  it('lerps every point coordinate at the midpoint', () => {
    const m = interpolateMask(kfs, 0.5)!;
    // square 10 → 30 at f=0.5 → 20
    expect(m.paths[0]!.points[0]!.x).toBeCloseTo(-20);
    expect(m.paths[0]!.points[2]!.x).toBeCloseTo(20);
    expect(m.paths[0]!.points[2]!.y).toBeCloseTo(20);
  });

  it('snaps to the nearer keyframe when point counts differ', () => {
    const tri: LayerMask = { paths: [path([corner(0, 0), corner(10, 0), corner(5, 10)])] };
    const mixed: MaskKeyframe[] = [{ t: 0, mask: square(10) }, { t: 1, mask: tri }];
    expect(interpolateMask(mixed, 0.3)!.paths[0]!.points).toHaveLength(4); // nearer = square
    expect(interpolateMask(mixed, 0.7)!.paths[0]!.points).toHaveLength(3); // nearer = triangle
  });

  it('is undefined for no keyframes, identity for one', () => {
    expect(interpolateMask([], 0.5)).toBeUndefined();
    expect(interpolateMask([{ t: 0, mask: square(10) }], 9)!.paths[0]!.points[0]!.x).toBe(-10);
  });
});
