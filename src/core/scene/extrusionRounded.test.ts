/**
 * A rounded rectangle must extrude as a ROUNDED solid.
 *
 * The walls were four full-width planes on the raw w×h box while the front cap
 * drew rounded — a rounded face stuck on a square block, with the bounding-box
 * corners poking out past the curve. Corner radius had no effect on any 3D body.
 */

import { extrusionFaces, ROUNDED_CORNER_SEGMENTS } from './extrusion';

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
