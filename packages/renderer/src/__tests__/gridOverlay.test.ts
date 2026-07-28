/**
 * Grid overlay geometry — After Effects' two grids.
 *
 * The absolute grid ("Gridline every N px" + "Subdivisions") is drawn in two
 * passes: minor lines first, then majors over them. The proportional grid
 * divides the comp instead, and is reference-only.
 */

import { gridLines, proportionalLines } from '../rendergraph/passes/OverlayPass';

const VIEW = { x: 0, y: 0, width: 400, height: 400 };
const T = 1; // 1px line thickness at zoom 1

/** X positions of the vertical lines in a result set. */
const verticals = (lines: { x: number; width: number; height: number }[]): number[] =>
  lines.filter((l) => l.height > l.width).map((l) => l.x).sort((a, b) => a - b);

describe('absolute grid', () => {
  it('draws a line at every multiple of the spacing', () => {
    expect(verticals(gridLines(VIEW, 100, T))).toEqual([0, 100, 200, 300, 400]);
  });

  it('subdivisions SKIP the major lines, so they are not painted twice', () => {
    // 4 subdivisions of a 100px cell = a line every 25px, minus the majors.
    const minor = verticals(gridLines(VIEW, 25, T, 400, 'lines', 100));
    expect(minor).toEqual([25, 50, 75, 125, 150, 175, 225, 250, 275, 325, 350, 375]);
    expect(minor).not.toContain(100);
    expect(minor).not.toContain(200);
  });

  it('subdivisions of 1 leave the majors alone', () => {
    expect(verticals(gridLines(VIEW, 100, T, 400, 'lines', 100))).toEqual([]);
  });

  it('dashed style emits segments instead of full-length lines', () => {
    const solid = gridLines(VIEW, 100, T, 4000, 'lines');
    const dashed = gridLines(VIEW, 100, T, 4000, 'dashed');
    expect(dashed.length).toBeGreaterThan(solid.length);
    // Every dash is shorter than the full span it replaces.
    for (const d of dashed) expect(Math.max(d.width, d.height)).toBeLessThan(VIEW.height);
  });

  it('dots style marks intersections only — no long lines at all', () => {
    const dots = gridLines(VIEW, 100, T, 4000, 'dots');
    for (const d of dots) {
      expect(d.width).toBeCloseTo(d.height, 6);
      expect(d.width).toBeLessThan(10);
    }
    // 5 × 5 crossings across a 400px view at 100px spacing.
    expect(dots.length).toBe(25);
  });

  it('respects the line cap when zoomed far out', () => {
    expect(gridLines(VIEW, 0.5, T, 40).length).toBeLessThanOrEqual(40);
  });
});

describe('proportional grid', () => {
  it('draws INTERIOR divisions only — 3 × 3 is a rule-of-thirds cross', () => {
    const lines = proportionalLines({ x: 0, y: 0, width: 1920, height: 1080 }, 3, 3, T);
    // 2 verticals + 2 horizontals, not 4 + 4: the outer lines would sit on the
    // comp edge, where the frame boundary already is.
    expect(lines.length).toBe(4);
    expect(verticals(lines)).toEqual([640, 1280]);
  });

  it('scales with the comp — that is what makes it "proportional"', () => {
    const small = proportionalLines({ x: 0, y: 0, width: 800, height: 600 }, 4, 4, T);
    const large = proportionalLines({ x: 0, y: 0, width: 1600, height: 1200 }, 4, 4, T);
    expect(verticals(small)).toEqual([200, 400, 600]);
    expect(verticals(large)).toEqual([400, 800, 1200]);
  });

  it('AE default 8 × 6 gives 7 + 5 interior lines', () => {
    expect(proportionalLines({ x: 0, y: 0, width: 1920, height: 1080 }, 8, 6, T).length).toBe(12);
  });

  it('a single cell draws nothing', () => {
    expect(proportionalLines({ x: 0, y: 0, width: 1920, height: 1080 }, 1, 1, T)).toEqual([]);
  });
});
