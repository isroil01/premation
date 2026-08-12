/**
 * A rounded rectangle must extrude as a ROUNDED solid.
 *
 * The walls were four full-width planes on the raw w×h box while the front cap
 * drew rounded — a rounded face stuck on a square block, with the bounding-box
 * corners poking out past the curve. Corner radius had no effect on any 3D body.
 */

import { extrusionFaces, extrusionGeometry, ROUNDED_CORNER_SEGMENTS } from './extrusion';

const W = 200;
const H = 120;
const D = 40;

/** Every wall face's centre, in the layer's local plane. */
function wallCentres(faces: ReturnType<typeof extrusionFaces>) {
  return faces.filter((f) => f.role === 'wall').map((f) => ({ x: f.m[12], y: f.m[13] }));
}

describe('rounded-rect extrusion', () => {
  it('still emits the plain 4-wall box when there is no radius', () => {
    const faces = extrusionFaces(W, H, D, 'rect');
    expect(faces.filter((f) => f.role === 'wall')).toHaveLength(4);
    expect(faces.filter((f) => f.role === 'back')).toHaveLength(1);
  });

  it('follows the outline with one wall per outline segment when rounded', () => {
    const faces = extrusionFaces(W, H, D, 'rect', undefined, { cornerRadius: 30 });
    // 4 corners × segments, plus the straight run between each pair.
    expect(faces.filter((f) => f.role === 'wall').length).toBeGreaterThan(4 * ROUNDED_CORNER_SEGMENTS);
    expect(faces.filter((f) => f.role === 'back')).toHaveLength(1);
  });

  it('keeps every wall inside the bounding box — no corner poking out', () => {
    const r = 40;
    const faces = extrusionFaces(W, H, D, 'rect', undefined, { cornerRadius: r });
    for (const c of wallCentres(faces)) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(W / 2 + 1e-6);
      expect(Math.abs(c.y)).toBeLessThanOrEqual(H / 2 + 1e-6);
    }
  });

  it('pulls the corners in — no wall centre sits in the square corner region', () => {
    const r = 40;
    const faces = extrusionFaces(W, H, D, 'rect', undefined, { cornerRadius: r });
    // The square corner is (±100, ±60). With a 40px radius nothing on the
    // outline may reach further than the arc, i.e. no point is beyond BOTH
    // (a−r) and (b−r) by the full radius.
    const a = W / 2;
    const b = H / 2;
    for (const c of wallCentres(faces)) {
      const dx = Math.max(0, Math.abs(c.x) - (a - r));
      const dy = Math.max(0, Math.abs(c.y) - (b - r));
      // Inside the rounded outline: the corner offset never exceeds the radius.
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(r + 1e-6);
    }
  });

  it('clamps a radius larger than the shape to half the short side', () => {
    // A 500px radius on a 200×120 box must not invert the outline.
    const faces = extrusionFaces(W, H, D, 'rect', undefined, { cornerRadius: 500 });
    for (const c of wallCentres(faces)) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(W / 2 + 1e-6);
      expect(Math.abs(c.y)).toBeLessThanOrEqual(H / 2 + 1e-6);
    }
  });

  it('leaves the ellipse path alone', () => {
    const faces = extrusionFaces(W, H, D, 'ellipse', undefined, { cornerRadius: 30 });
    // Ellipses have no corners; the radius must not change their segmentation.
    const plain = extrusionFaces(W, H, D, 'ellipse');
    expect(faces.length).toBe(plain.length);
  });
});

/**
 * The bevel a shape actually GOT, and the front-face inset that must match it.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `buildSnapshot` computed its front-face inset as `clampBevel(w, h, d, req)`
 * for any rect, and shrank the emitted front face by it. But the rounded branch
 * returns before the bevel path and emits no chamfer ring — so a rounded card
 * with a bevel set had its front face shrunk to meet a ring that was never
 * drawn. The result was a rounded front face floating ~12 px inside the
 * outline, with the darker back cap showing through the ring-shaped gap.
 *
 * The root cause was a contract, not arithmetic: `extrusion.ts` recorded the
 * deliberate choice to ignore a bevel on a rounded outline, and never told the
 * caller. So the assertions below are about what the geometry REPORTS, which is
 * the thing `buildSnapshot` now reads — checking the face list instead would
 * pass just as well against a caller that went on guessing.
 */
describe('extrusionGeometry — the emitted bevel is reported, not inferred', () => {
  it('a square-cornered rect reports the bevel it emitted, clamped', () => {
    const g = extrusionGeometry(W, H, D, 'rect', undefined, { bevel: 8 });
    expect(g.bevel).toBe(8);
    expect(g.faces.some((f) => f.suffix.startsWith('cf'))).toBe(true);
  });

  it('a clamped request reports the CLAMPED value, so the inset matches the ring', () => {
    // d/2 is the binding limit here (D = 40), not w/2 or h/2.
    const g = extrusionGeometry(W, H, D, 'rect', undefined, { bevel: 999 });
    expect(g.bevel).toBe(D / 2);
  });

  it('a ROUNDED rect reports NO bevel even when one was requested', () => {
    const g = extrusionGeometry(W, H, D, 'rect', undefined, { bevel: 12, cornerRadius: 30 });
    expect(g.bevel).toBe(0);
    // …and the report is true: there is no chamfer ring to meet.
    expect(g.faces.some((f) => f.suffix.startsWith('cf') || f.suffix.startsWith('cb'))).toBe(false);
  });

  it('an ELLIPSE reports no bevel either (documented deferral)', () => {
    const g = extrusionGeometry(W, H, D, 'ellipse', undefined, { bevel: 12 });
    expect(g.bevel).toBe(0);
  });

  it('an unbevelled box reports none', () => {
    expect(extrusionGeometry(W, H, D, 'rect').bevel).toBe(0);
    expect(extrusionGeometry(W, H, D, 'rect', undefined, { bevel: 0 }).bevel).toBe(0);
  });

  it('a degenerate extrusion reports no faces and no bevel', () => {
    expect(extrusionGeometry(W, H, 0, 'rect', undefined, { bevel: 8 })).toEqual({ faces: [], bevel: 0 });
  });

  it('the report never claims a bevel the face list does not contain', () => {
    // The invariant the whole change exists to hold, over every branch: a
    // non-zero report means a chamfer ring was emitted, and a zero report means
    // none was. Stated as a loop so a NEW branch added below cannot quietly
    // return the wrong pair.
    const cases = [
      { shape: 'rect' as const, opts: { bevel: 8 } },
      { shape: 'rect' as const, opts: { bevel: 8, cornerRadius: 30 } },
      { shape: 'rect' as const, opts: { bevel: 0 } },
      { shape: 'rect' as const, opts: { bevel: 999 } },
      { shape: 'rect' as const, opts: { bevel: 8, wallSegments: 20 } },
      { shape: 'ellipse' as const, opts: { bevel: 8 } },
      { shape: 'ellipse' as const, opts: {} },
    ];
    for (const c of cases) {
      const g = extrusionGeometry(W, H, D, c.shape, undefined, c.opts);
      const hasRing = g.faces.some((f) => f.suffix.startsWith('cf') || f.suffix.startsWith('cb'));
      expect([JSON.stringify(c), g.bevel > 0]).toEqual([JSON.stringify(c), hasRing]);
    }
  });
});
