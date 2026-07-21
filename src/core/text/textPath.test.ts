import { applyTextPath, flattenMaskPath } from './textPath';
import { layoutText, type TextStyle } from './textLayout';
import { arcTable, pointAndTangentAtLength } from '@core/scene/trimPath';
import type { MaskPath, MaskPoint } from '@core/effects/mask';

const measure = (_c: string, s: TextStyle): number => s.fontSize;
const base = { fontSize: 10, fill: '#fff' };

/** A horizontal line from (0,0) to (100,0), as an open 2-point mask. */
const corner = (x: number, y: number): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const openLine = (): MaskPath => ({
  id: 'm1', mode: 'add', closed: false,
  points: [corner(0, 0), corner(100, 0)],
  feather: 0, opacity: 1, expansion: 0, inverted: false,
});

const table = () => arcTable(flattenMaskPath(openLine()).pts, false);

describe('pointAndTangentAtLength', () => {
  it('samples position and heading along a straight run', () => {
    const t = table();
    expect(t.total).toBeCloseTo(100);
    const p = pointAndTangentAtLength(t, 25);
    expect(p.x).toBeCloseTo(25);
    expect(p.y).toBeCloseTo(0);
    expect(p.angle).toBeCloseTo(0); // pointing +x
  });

  it('reports the heading of a vertical run', () => {
    const t = arcTable([{ x: 0, y: 0 }, { x: 0, y: 50 }], false);
    expect(pointAndTangentAtLength(t, 10).angle).toBeCloseTo(Math.PI / 2);
  });

  it('extrapolates past the end of an open path instead of clamping', () => {
    // Clamping would pile every overflowing glyph on the last vertex.
    const p = pointAndTangentAtLength(table(), 130);
    expect(p.x).toBeCloseTo(130);
    expect(p.angle).toBeCloseTo(0);
  });

  it('extrapolates before the start of an open path', () => {
    expect(pointAndTangentAtLength(table(), -20).x).toBeCloseTo(-20);
  });

  it('wraps around a closed path', () => {
    const t = arcTable([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true);
    expect(t.total).toBeCloseTo(40);
    const a = pointAndTangentAtLength(t, 5);
    const b = pointAndTangentAtLength(t, 45); // once around, plus 5
    expect(b.x).toBeCloseTo(a.x);
    expect(b.y).toBeCloseTo(a.y);
  });

  it('survives a degenerate path without producing NaN', () => {
    const p = pointAndTangentAtLength(arcTable([{ x: 3, y: 4 }], false), 10);
    expect(p).toEqual({ x: 3, y: 4, angle: 0 });
  });

  it('agrees with the binary search at every vertex boundary', () => {
    const t = arcTable([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }], false);
    for (const len of [0, 10, 20, 30]) {
      expect(pointAndTangentAtLength(t, len).x).toBeCloseTo(len);
    }
  });
});

describe('flattenMaskPath', () => {
  it('keeps a straight segment as two points rather than subdividing it', () => {
    expect(flattenMaskPath(openLine()).pts).toHaveLength(2);
  });

  it('subdivides a curved segment', () => {
    const curved: MaskPath = {
      ...openLine(),
      points: [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 30, outY: -40 },
        { x: 100, y: 0, inX: 70, inY: -40, outX: 100, outY: 0 },
      ],
    };
    const { pts } = flattenMaskPath(curved, 8);
    expect(pts.length).toBe(9); // start + 8 samples
    // The arc bulges upward, so it is longer than the 100px chord.
    expect(arcTable(pts, false).total).toBeGreaterThan(100);
  });

  it('does not duplicate the closing vertex of a closed path', () => {
    const closed: MaskPath = { ...openLine(), closed: true };
    const { pts, closed: isClosed } = flattenMaskPath(closed);
    expect(isClosed).toBe(true);
    // Two anchors, two segments (there and back) — the wrap point is implicit.
    expect(pts[0]).not.toEqual(pts[pts.length - 1]);
  });
});

describe('applyTextPath', () => {
  const geo = (over = {}) => ({
    table: table(),
    firstMargin: 0,
    reversed: false,
    perpendicular: true,
    align: 'left',
    ...over,
  });

  it('lays glyphs along the path in order', () => {
    const laid = layoutText('abc', base, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo());
    expect(out.map((g) => Math.round(g.x))).toEqual([5, 15, 25]);
    expect(out.every((g) => Math.abs(g.y) < 1e-6)).toBe(true);
  });

  it('rotates glyphs to the heading when perpendicular', () => {
    const t = arcTable([{ x: 0, y: 0 }, { x: 0, y: 100 }], false);
    const laid = layoutText('a', base, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo({ table: t }));
    expect(out[0]!.angle).toBeCloseTo(Math.PI / 2);
  });

  it('leaves glyphs upright when perpendicular is off', () => {
    const t = arcTable([{ x: 0, y: 0 }, { x: 0, y: 100 }], false);
    const laid = layoutText('a', base, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo({ table: t, perpendicular: false }));
    expect(out[0]!.angle).toBe(0);
  });

  it('shifts the text along the path by firstMargin', () => {
    const laid = layoutText('a', base, measure, { boxWidth: 100 });
    const at0 = applyTextPath(laid, geo())[0]!;
    const at20 = applyTextPath(laid, geo({ firstMargin: 20 }))[0]!;
    expect(at20.x - at0.x).toBeCloseTo(20);
  });

  it('walks backwards and flips the glyphs when reversed', () => {
    const laid = layoutText('a', base, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo({ reversed: true }))[0]!;
    expect(out.x).toBeCloseTo(95); // 100 - 5
    // Flipped, or every glyph would render mirrored.
    expect(Math.abs(out.angle! - Math.PI)).toBeCloseTo(0);
  });

  it('honours align: right ends the line at the path end', () => {
    const laid = layoutText('abc', { ...base, align: 'right' }, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo({ align: 'right' }));
    // 30px of text on a 100px path -> last glyph centre at 95.
    expect(Math.round(out[2]!.x)).toBe(95);
  });

  it('honours align: center straddles the path midpoint', () => {
    const laid = layoutText('abc', { ...base, align: 'center' }, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo({ align: 'center' }));
    const mid = (out[0]!.x + out[2]!.x) / 2;
    expect(mid).toBeCloseTo(50);
  });

  it('offsets a second line along the path normal', () => {
    // Multi-line text rides the curve in parallel rather than collapsing onto it.
    const laid = layoutText('a\nb', { ...base, lineHeight: 2 }, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo());
    // Path runs +x, so its normal is +y: the two lines separate vertically.
    expect(out[0]!.y).toBeCloseTo(-10);
    expect(out[1]!.y).toBeCloseTo(10);
  });

  it('returns the layout untouched when the path has no length', () => {
    const laid = layoutText('abc', base, measure, { boxWidth: 100 });
    const degenerate = arcTable([{ x: 0, y: 0 }, { x: 0, y: 0 }], false);
    expect(applyTextPath(laid, geo({ table: degenerate }))).toEqual(laid.glyphs);
  });
});
