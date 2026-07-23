/**
 * SVG importer — robust parsing of real logos into editable vector paths.
 * Covers basic shape elements, the full path command set (A/Q/T/S + relative),
 * transforms / viewBox, tree traversal, and determinism.
 */

import { parseSvgPath, parseSvgPathEx, parseSvgToShapes, type ParsedShape } from './svgParser';
import type { BezierPoint } from '@motion/workspace';

/** Absolute bounding box over anchors + handles. */
function bounds(points: BezierPoint[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x, p.inX, p.outX);
    minY = Math.min(minY, p.y, p.inY, p.outY);
    maxX = Math.max(maxX, p.x, p.inX, p.outX);
    maxY = Math.max(maxY, p.y, p.inY, p.outY);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function byName(shapes: ParsedShape[], name: string): ParsedShape {
  const s = shapes.find((x) => x.name === name);
  if (!s) throw new Error(`shape "${name}" not found (have: ${shapes.map((x) => x.name).join(', ')})`);
  return s;
}

function svg(inner: string, attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"'): string {
  return `<svg ${attrs}>${inner}</svg>`;
}

describe('basic shape elements', () => {
  it('rect → 4 corner anchors, closed, correct bounds', () => {
    const shapes = parseSvgToShapes(svg('<rect id="r" x="10" y="20" width="30" height="40" fill="#f00"/>'));
    const r = byName(shapes, 'r');
    expect(r.points).toHaveLength(4);
    expect(r.closed).toBe(true);
    expect(r.width).toBeCloseTo(30, 5);
    expect(r.height).toBeCloseTo(40, 5);
    expect(r.centerX).toBeCloseTo(25, 5);
    expect(r.centerY).toBeCloseTo(40, 5);
    expect(r.fill).toBe('#f00');
  });

  it('rounded rect → 8 anchors, bounds preserved', () => {
    const shapes = parseSvgToShapes(svg('<rect id="rr" x="0" y="0" width="40" height="40" rx="10" ry="10"/>'));
    const rr = byName(shapes, 'rr');
    expect(rr.points).toHaveLength(8);
    expect(rr.closed).toBe(true);
    expect(rr.width).toBeCloseTo(40, 3);
    expect(rr.height).toBeCloseTo(40, 3);
  });

  it('circle → 4 cubic-arc anchors spanning the diameter', () => {
    const shapes = parseSvgToShapes(svg('<circle id="c" cx="50" cy="50" r="20"/>'));
    const c = byName(shapes, 'c');
    expect(c.points).toHaveLength(4);
    expect(c.closed).toBe(true);
    // Handles extend to the full bounding box of the circle.
    expect(c.width).toBeCloseTo(40, 3);
    expect(c.height).toBeCloseTo(40, 3);
    expect(c.centerX).toBeCloseTo(50, 3);
    expect(c.centerY).toBeCloseTo(50, 3);
  });

  it('ellipse → 4 anchors with distinct rx/ry bounds', () => {
    const shapes = parseSvgToShapes(svg('<ellipse id="e" cx="50" cy="50" rx="30" ry="10"/>'));
    const e = byName(shapes, 'e');
    expect(e.points).toHaveLength(4);
    expect(e.width).toBeCloseTo(60, 3);
    expect(e.height).toBeCloseTo(20, 3);
  });

  it('polygon → closed, one anchor per vertex', () => {
    const shapes = parseSvgToShapes(svg('<polygon id="p" points="10,10 90,10 50,90"/>'));
    const p = byName(shapes, 'p');
    expect(p.points).toHaveLength(3);
    expect(p.closed).toBe(true);
  });

  it('polyline → open, one anchor per vertex', () => {
    const shapes = parseSvgToShapes(svg('<polyline id="pl" points="10,10 40,40 90,10"/>'));
    const pl = byName(shapes, 'pl');
    expect(pl.points).toHaveLength(3);
    expect(pl.closed).toBe(false);
  });

  it('line → open, 2 anchors', () => {
    const shapes = parseSvgToShapes(svg('<line id="ln" x1="0" y1="0" x2="80" y2="60"/>'));
    const ln = byName(shapes, 'ln');
    expect(ln.points).toHaveLength(2);
    expect(ln.closed).toBe(false);
    expect(ln.width).toBeCloseTo(80, 3);
    expect(ln.height).toBeCloseTo(60, 3);
  });
});

describe('full path command set (no truncation)', () => {
  it('arc A produces multiple vertices spanning a semicircle', () => {
    // Semicircle from (10,50) to (90,50), radius 40 → bounds span 80 wide, 40 tall.
    const { points, closed } = parseSvgPathEx('M10 50 A40 40 0 0 1 90 50');
    // Pre-fix (A hit `else { break }`) would leave just the single M anchor.
    expect(points.length).toBeGreaterThan(1);
    expect(closed).toBe(false);
    const b = bounds(points);
    expect(b.w).toBeCloseTo(80, 0);
    // Semicircle bulges to one side of the chord (~40 units of sagitta).
    expect(b.h).toBeGreaterThan(35);
  });

  it('quadratic Q is elevated to a cubic (control pulls the curve out)', () => {
    const { points } = parseSvgPathEx('M0 0 Q50 100 100 0');
    expect(points.length).toBe(2);
    const b = bounds(points);
    // Handles reach toward the quadratic control point (2/3 * 100 ≈ 66).
    expect(b.maxY).toBeGreaterThan(60);
  });

  it('smooth cubic S reflects the previous control point', () => {
    const abs = parseSvgPath('M0 0 C0 50 50 50 50 0 S100 -50 100 0');
    // 3 anchors: start + 2 curve endpoints, none dropped.
    expect(abs.length).toBe(3);
    // Reflected in-handle of the S segment mirrors the prior out control.
    const last = abs[2]!;
    expect(last.inY).toBeLessThan(0);
  });

  it('smooth quadratic T reflects the previous quadratic control', () => {
    const { points } = parseSvgPathEx('M0 0 Q25 -50 50 0 T100 0');
    expect(points.length).toBe(3);
  });

  it('a real multi-command path is not truncated at the first arc', () => {
    const d = 'M10 10 L30 10 A10 10 0 0 1 40 20 L40 40 Q40 50 30 50 Z';
    const { points, closed } = parseSvgPathEx(d);
    expect(points.length).toBeGreaterThanOrEqual(5);
    expect(closed).toBe(true);
  });
});

describe('relative commands equal absolute equivalents', () => {
  it('relative line matches absolute', () => {
    const a = parseSvgPath('M10 10 L40 10 L40 40');
    const rel = parseSvgPath('M10 10 l30 0 l0 30');
    expect(rel.map((p) => [p.x, p.y])).toEqual(a.map((p) => [p.x, p.y]));
  });

  it('relative cubic matches absolute', () => {
    const a = parseSvgPath('M0 0 C10 10 20 10 30 0');
    const rel = parseSvgPath('M0 0 c10 10 20 10 30 0');
    const round = (pts: BezierPoint[]) => pts.map((p) => [p.x, p.y, p.inX, p.inY, p.outX, p.outY].map((n) => +n.toFixed(6)));
    expect(round(rel)).toEqual(round(a));
  });

  it('relative arc matches absolute', () => {
    const a = parseSvgPathEx('M10 50 A40 40 0 0 1 90 50').points;
    const rel = parseSvgPathEx('M10 50 a40 40 0 0 1 80 0').points;
    const round = (pts: BezierPoint[]) => pts.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)]);
    expect(round(rel)).toEqual(round(a));
  });
});

describe('transforms + viewBox + traversal', () => {
  it('element transform="translate(...)" offsets geometry', () => {
    const base = byName(parseSvgToShapes(svg('<rect id="r" x="0" y="0" width="20" height="20"/>')), 'r');
    const moved = byName(
      parseSvgToShapes(svg('<rect id="r" x="0" y="0" width="20" height="20" transform="translate(30 40)"/>')),
      'r',
    );
    expect(moved.centerX - base.centerX).toBeCloseTo(30, 5);
    expect(moved.centerY - base.centerY).toBeCloseTo(40, 5);
  });

  it('ancestor <g transform> composes onto nested children', () => {
    const shapes = parseSvgToShapes(
      svg('<g transform="translate(10 10)"><g transform="scale(2)"><rect id="deep" x="5" y="5" width="10" height="10"/></g></g>'),
    );
    const r = byName(shapes, 'deep');
    // rect center (10,10) → scale 2 → (20,20) → translate(10,10) → (30,30)
    expect(r.centerX).toBeCloseTo(30, 5);
    expect(r.centerY).toBeCloseTo(30, 5);
    // size doubled by scale(2)
    expect(r.width).toBeCloseTo(20, 5);
    expect(r.height).toBeCloseTo(20, 5);
  });

  it('rotate transform moves geometry deterministically', () => {
    const shapes = parseSvgToShapes(svg('<rect id="r" x="-5" y="-5" width="10" height="10" transform="rotate(90)"/>'));
    const r = byName(shapes, 'r');
    // Symmetric square rotated about origin: still centered at origin.
    expect(r.centerX).toBeCloseTo(0, 5);
    expect(r.centerY).toBeCloseTo(0, 5);
    expect(r.width).toBeCloseTo(10, 5);
  });

  it('viewBox → width/height scales the whole logo uniformly', () => {
    const small = byName(
      parseSvgToShapes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="r" x="0" y="0" width="50" height="50"/></svg>'),
      'r',
    );
    const scaled = byName(
      parseSvgToShapes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200"><rect id="r" x="0" y="0" width="50" height="50"/></svg>'),
      'r',
    );
    // 200/100 = 2× scale.
    expect(scaled.width).toBeCloseTo(small.width * 2, 3);
  });

  it('traverses grouped/nested elements (collects all shapes)', () => {
    const shapes = parseSvgToShapes(
      svg('<g><rect id="a" x="0" y="0" width="10" height="10"/><g><circle id="b" cx="50" cy="50" r="5"/><path id="c" d="M0 0 L10 0 L10 10 Z"/></g></g>'),
    );
    expect(shapes.map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('inherits fill from ancestor <g> when the element sets none', () => {
    const shapes = parseSvgToShapes(svg('<g fill="#0a0"><rect id="r" x="0" y="0" width="10" height="10"/></g>'));
    expect(byName(shapes, 'r').fill).toBe('#0a0');
  });

  it('element fill overrides ancestor fill', () => {
    const shapes = parseSvgToShapes(svg('<g fill="#0a0"><rect id="r" x="0" y="0" width="10" height="10" fill="#00f"/></g>'));
    expect(byName(shapes, 'r').fill).toBe('#00f');
  });
});

describe('robustness', () => {
  it('unknown elements are skipped, not fatal', () => {
    const shapes = parseSvgToShapes(svg('<rect id="r" x="0" y="0" width="10" height="10"/><foreignObject/>'));
    expect(shapes.map((s) => s.name)).toEqual(['r']);
  });

  it('malformed XML returns empty (triggers image fallback in sceneInsert)', () => {
    expect(parseSvgToShapes('<svg><rect not closed')).toEqual([]);
  });

  it('a multi-shape logo yields one shape per drawable element', () => {
    const logo = svg(
      '<rect id="bg" x="0" y="0" width="100" height="100"/><circle id="dot" cx="50" cy="50" r="20"/><path id="mark" d="M20 80 Q50 20 80 80"/>',
    );
    const shapes = parseSvgToShapes(logo);
    expect(shapes).toHaveLength(3);
  });
});

describe('determinism', () => {
  it('same SVG → byte-identical output across runs', () => {
    const src = svg(
      '<g transform="rotate(15 50 50)"><path id="p" d="M10 50 A40 40 0 1 1 90 50 Q50 90 10 50 Z"/><circle id="c" cx="50" cy="50" r="10"/></g>',
    );
    const a = parseSvgToShapes(src);
    const b = parseSvgToShapes(src);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
