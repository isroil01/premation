/**
 * SMIL → keyframes.
 *
 * The translator samples the element's animated matrix and compares it against
 * the static matrix baked into the shape's points, so these tests mostly check
 * that the DELTA comes out right — including the cases the delta model exists
 * for: rotation about a point, animation inherited from a `<g>`, and an element
 * that already carries a static transform.
 */

import { parseSvgToShapes } from './svgParser';

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

/** The single shape of a one-shape document. */
function only(svg: string) {
  const shapes = parseSvgToShapes(svg);
  expect(shapes).toHaveLength(1);
  return shapes[0]!;
}

function valueAt(kfs: ReadonlyArray<{ time: number; value: number }> | undefined, t: number): number {
  if (!kfs) throw new Error('track missing');
  const exact = kfs.find((k) => Math.abs(k.time - t) < 1e-6);
  if (!exact) throw new Error(`no keyframe at ${t}: ${kfs.map((k) => k.time).join(',')}`);
  return exact.value;
}

describe('SMIL translation', () => {
  it('leaves a static SVG with no animation at all', () => {
    const s = only(wrap('<rect x="10" y="10" width="20" height="20"/>'));
    expect(s.animation).toBeUndefined();
  });

  it('translates animateTransform translate into x/y offsets', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="40 20" dur="2s" fill="freeze"/>
      </rect>`));
    expect(s.animation).toBeDefined();
    expect(s.animation!.duration).toBeCloseTo(2, 5);
    expect(valueAt(s.animation!.x, 0)).toBeCloseTo(0, 5);
    expect(valueAt(s.animation!.x, 2)).toBeCloseTo(40, 5);
    expect(valueAt(s.animation!.y, 2)).toBeCloseTo(20, 5);
  });

  it('reads opacity animation as a percentage track', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animate attributeName="opacity" from="1" to="0" dur="1s" fill="freeze"/>
      </rect>`));
    expect(valueAt(s.animation!.opacity, 0)).toBeCloseTo(100, 5);
    expect(valueAt(s.animation!.opacity, 1)).toBeCloseTo(0, 5);
  });

  it('turns scale into multipliers, not pixel sizes', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animateTransform attributeName="transform" type="scale"
          from="1" to="3" dur="1s" fill="freeze"/>
      </rect>`));
    expect(valueAt(s.animation!.scaleX, 0)).toBeCloseTo(1, 5);
    expect(valueAt(s.animation!.scaleX, 1)).toBeCloseTo(3, 5);
    expect(valueAt(s.animation!.scaleY, 1)).toBeCloseTo(3, 5);
  });

  it('records rotation in degrees', () => {
    const s = only(wrap(`
      <rect x="40" y="40" width="20" height="20">
        <animateTransform attributeName="transform" type="rotate"
          from="0" to="90" dur="1s" fill="freeze"/>
      </rect>`));
    expect(Math.abs(valueAt(s.animation!.rotation, 1))).toBeCloseTo(90, 4);
  });

  it('turns rotation ABOUT A POINT into rotation plus a position offset', () => {
    // Rotating about the origin swings a shape centred at (50,50) away from its
    // own centre. A property-by-property mapping would keep it in place and only
    // spin it — the delta model is what catches the swing.
    const s = only(wrap(`
      <rect x="40" y="40" width="20" height="20">
        <animateTransform attributeName="transform" type="rotate"
          from="0 0 0" to="180 0 0" dur="1s" fill="freeze"/>
      </rect>`));
    // 180° about the origin sends the centre (50,50) to (-50,-50).
    expect(valueAt(s.animation!.x, 1)).toBeCloseTo(-100, 3);
    expect(valueAt(s.animation!.y, 1)).toBeCloseTo(-100, 3);
  });

  it('applies a <g>-level animation to the shapes inside it', () => {
    const shapes = parseSvgToShapes(wrap(`
      <g>
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="10 0" dur="1s" fill="freeze"/>
        <rect x="0" y="0" width="10" height="10"/>
        <rect x="20" y="0" width="10" height="10"/>
      </g>`));
    expect(shapes).toHaveLength(2);
    for (const s of shapes) {
      expect(valueAt(s.animation!.x, 1)).toBeCloseTo(10, 5);
    }
  });

  it('measures the delta against an element that already has a static transform', () => {
    // The static translate is baked into the points; the animation REPLACES the
    // transform attribute, so at t=0 (animated value 0 0) the shape must sit
    // 30px LEFT of where it was baked — not at zero offset.
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10" transform="translate(30 0)">
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="0 0" dur="1s" fill="freeze"/>
      </rect>`));
    expect(valueAt(s.animation!.x, 0)).toBeCloseTo(-30, 5);
  });

  it('holds <set> values as steps', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <set attributeName="opacity" to="0" begin="1s" dur="1s"/>
      </rect>`));
    expect(s.animation!.opacity).toBeDefined();
    expect(s.animation!.opacity!.every((k) => k.hold === true)).toBe(true);
  });

  it('starts an animation at its begin offset', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="10 0" begin="2s" dur="1s" fill="freeze"/>
      </rect>`));
    expect(valueAt(s.animation!.x, 2)).toBeCloseTo(0, 5);
    expect(valueAt(s.animation!.x, 3)).toBeCloseTo(10, 5);
    expect(s.animation!.duration).toBeCloseTo(3, 5);
  });

  it('unrolls a repeatCount instead of animating once', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="10 0" dur="1s" repeatCount="3" fill="freeze"/>
      </rect>`));
    expect(s.animation!.duration).toBeCloseTo(3, 5);
    // Each iteration restarts at 0 — proving it repeated rather than ramping on.
    expect(valueAt(s.animation!.x, 1)).toBeCloseTo(0, 5);
    expect(valueAt(s.animation!.x, 2)).toBeCloseTo(0, 5);
  });

  it('completes each iteration of a repeat instead of only its restart', () => {
    // Landing samples only ON the repeat boundary reads the RESTART value, so
    // the ramp within each iteration vanishes and a 2× 2s move imports as
    // "still for 2s, then one slow move". Verified against the real importer:
    // this was exactly the symptom.
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="60 0" dur="2s" repeatCount="2" fill="freeze"/>
      </rect>`));
    const xs = s.animation!.x!;
    // Just before the boundary the first iteration must have arrived at 60.
    const nearBoundary = xs.filter((k) => k.time > 1.9 && k.time < 2);
    expect(nearBoundary.length).toBeGreaterThan(0);
    // Sampled a millisecond short of the boundary, so it is 60 all but exactly.
    expect(nearBoundary[nearBoundary.length - 1]!.value).toBeGreaterThan(59.5);
    // …and the boundary itself restarts at 0.
    expect(valueAt(xs, 2)).toBeCloseTo(0, 3);
  });

  it('keeps a full spin monotonic instead of wrapping at ±180', () => {
    // The matrix decomposition reads angles back through atan2, so a 360° spin
    // returns 0 → 180 → −180 → 0. Interpolating +179 → −179 rotates BACKWARDS
    // through zero — the spin visibly stutters.
    const s = only(wrap(`
      <circle cx="50" cy="50" r="10">
        <animateTransform attributeName="transform" type="rotate"
          from="0 50 50" to="360 50 50" dur="2s" fill="freeze"/>
      </circle>`));
    const rot = s.animation!.rotation!;
    for (let i = 1; i < rot.length; i++) {
      expect(rot[i]!.value).toBeGreaterThanOrEqual(rot[i - 1]!.value - 1e-6);
    }
    expect(rot[rot.length - 1]!.value).toBeCloseTo(360, 2);
  });

  it('follows a values list through its intermediate stops', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animateTransform attributeName="transform" type="translate"
          values="0 0; 10 0; 0 0" dur="2s"/>
      </rect>`));
    expect(valueAt(s.animation!.x, 0)).toBeCloseTo(0, 5);
    expect(valueAt(s.animation!.x, 1)).toBeCloseTo(10, 5);
    expect(valueAt(s.animation!.x, 2)).toBeCloseTo(0, 5);
  });

  it('drops a track whose value never changes', () => {
    // Animating opacity from 1 to 1 is not animation; it should not create a
    // track that pins the property and blocks later editing.
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animate attributeName="opacity" from="1" to="1" dur="1s"/>
      </rect>`));
    expect(s.animation).toBeUndefined();
  });

  it('ignores an animation whose begin depends on an event', () => {
    const s = only(wrap(`
      <rect x="0" y="0" width="10" height="10">
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="10 0" begin="click" dur="1s"/>
      </rect>`));
    expect(s.animation).toBeUndefined();
  });
});
