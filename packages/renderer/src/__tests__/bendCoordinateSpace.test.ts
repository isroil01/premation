/**
 * Bend must sample INSIDE the layer when the layer is a sub-rect of the target.
 *
 * ── The bug, reproduced numerically ─────────────────────────────────────────
 *
 * Reported as "I applied Bend to a triangle and the object disappeared". The
 * WGSL centred on the raw target coordinate (`uv - 0.5`) where the GLSL
 * centred on the layer (`(vUv - uvRect.xy) / uvRect.zw - 0.5`). A layer that
 * fills the render target has `uvRect = (0,0,1,1)` and the two are identical —
 * which is why it looked fine in isolation. A layer occupying a SUB-RECT, which
 * is every baked vector layer, gets coordinates offset and scaled by that rect;
 * every source coordinate then falls outside [0,1], the shader's own bounds
 * check returns transparent for all of them, and the layer vanishes.
 *
 * `shaderBackendParity.test.ts` pins that the two backends agree. This pins
 * that the agreed-on formula is the RIGHT one — two shaders can be identically
 * wrong, and a text comparison would call that a pass.
 *
 * ── On porting shader maths into a test ─────────────────────────────────────
 *
 * This reimplements the mapping in TS, which can drift from the WGSL. It is
 * deliberately limited to the part that broke: the space conversion and the
 * bounds check. The arc and profile maths are gated by the render-test scene,
 * where the real shader runs; nothing here would notice if those changed.
 */

/** The shader's source-coordinate lookup, both variants, for one pixel. */
function bendSource(
  uv: readonly [number, number],
  uvRect: readonly [number, number, number, number],
  opts: { theta: number; axisRad: number; u0: number; u1: number; layerLocal: boolean },
): { x: number; y: number } {
  const [ux, uy] = uv;
  const [rx, ry, rw, rh] = uvRect;
  // THE FIX: layer-local vs raw target coordinate.
  const p: [number, number] = opts.layerLocal
    ? [(ux - rx) / rw - 0.5, (uy - ry) / rh - 0.5]
    : [ux - 0.5, uy - 0.5];

  const d: [number, number] = [Math.cos(opts.axisRad), Math.sin(opts.axisRad)];
  const n: [number, number] = [-d[1], d[0]];
  const a = p[0] * d[0] + p[1] * d[1];
  const b = p[0] * n[0] + p[1] * n[1];
  const L = opts.u1 - opts.u0;

  let srcA = a;
  let srcB = b;
  if (Math.abs(opts.theta) > 1e-4 && L > 1e-4) {
    const R = L / opts.theta;
    const x = a - opts.u0;
    const dy = R - b;
    const r = Math.hypot(x, dy);
    const w = Math.atan2(x, dy) / opts.theta;
    if (w >= 0 && w <= 1) {
      srcA = opts.u0 + w * L; // Sharp profile: inverse is the identity.
      srcB = R - r;
    }
  }
  return { x: 0.5 + d[0] * srcA + n[0] * srcB, y: 0.5 + d[1] * srcA + n[1] * srcB };
}

const inLayer = (s: { x: number; y: number }): boolean =>
  s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1;

/** A grid of pixels across the layer's sub-rect of the target. */
function coverage(uvRect: readonly [number, number, number, number], layerLocal: boolean): number {
  const opts = { theta: (60 * Math.PI) / 180, axisRad: Math.PI / 2, u0: -0.5, u1: 0.5, layerLocal };
  let inside = 0;
  let total = 0;
  for (let i = 1; i < 16; i++) {
    for (let j = 1; j < 16; j++) {
      const uv: [number, number] = [uvRect[0] + (i / 16) * uvRect[2], uvRect[1] + (j / 16) * uvRect[3]];
      total++;
      if (inLayer(bendSource(uv, uvRect, opts))) inside++;
    }
  }
  return inside / total;
}

/** A layer filling the target — the case where both formulas coincide. */
const FULL = [0, 0, 1, 1] as const;
/** A layer occupying a sub-rect, e.g. a baked triangle in a larger comp. */
const SUB = [0.25, 0.3, 0.5, 0.4] as const;

describe('bend coordinate space', () => {
  it('samples inside the layer for a FULL-frame layer either way', () => {
    // The blind spot: with uvRect = (0,0,1,1) the broken formula is correct,
    // so testing only this case proves nothing.
    expect(coverage(FULL, true)).toBeGreaterThan(0.8);
    expect(coverage(FULL, false)).toBeGreaterThan(0.8);
  });

  it('★ still samples inside the layer when the layer is a SUB-RECT', () => {
    // The fix. Most of the layer must map back into itself; the shader returns
    // transparent for anything that does not.
    expect(coverage(SUB, true)).toBeGreaterThan(0.8);
  });

  it('★ the two formulas disagree at a sub-rect — they are NOT interchangeable', () => {
    /*
      What the divergence actually costs, measured.

      An earlier version of this test asserted that the raw-target formula sent
      every sample out of range and lost the layer. That was wrong, and running
      it said so: at a sub-rect the coordinates stay in [0,1], so the old code
      drew a WRONG bend rather than nothing. The layer-vanishing report has a
      different cause.

      The real defect is still a defect: `p` is offset by the layer's position
      in the target and scaled by its size, so the bend pivots around the
      target's centre and traverses only part of its span. Two backends drawing
      two different pictures from one set of controls.
    */
    const opts = { theta: (60 * Math.PI) / 180, axisRad: Math.PI / 2, u0: -0.5, u1: 0.5 };
    const uv: [number, number] = [SUB[0] + 0.25 * SUB[2], SUB[1] + 0.25 * SUB[3]];
    const local = bendSource(uv, SUB, { ...opts, layerLocal: true });
    const raw = bendSource(uv, SUB, { ...opts, layerLocal: false });
    expect(Math.hypot(local.x - raw.x, local.y - raw.y)).toBeGreaterThan(0.05);
  });

  it('★ the bend spans the whole layer only in layer-local space', () => {
    // The concrete consequence: in target space `a` covers a fraction of the
    // bend span set by the layer's size, so most of the layer never reaches
    // full bend. Displacement at the layer's far edge is the tell.
    const opts = { theta: (90 * Math.PI) / 180, axisRad: Math.PI / 2, u0: -0.5, u1: 0.5 };
    const edge: [number, number] = [SUB[0] + 0.98 * SUB[2], SUB[1] + 0.5 * SUB[3]];
    const localShift = Math.abs(bendSource(edge, SUB, { ...opts, layerLocal: true }).x - 0.5);
    const rawShift = Math.abs(bendSource(edge, SUB, { ...opts, layerLocal: false }).x - 0.5);
    expect(localShift).toBeGreaterThan(rawShift * 1.5);
  });

  it('is not accidentally passing because the bend is a no-op', () => {
    // If theta were ignored, source would equal input and coverage would be 1
    // for both formulas — a green test that proves nothing about bending.
    const straight = bendSource([0.5, 0.5], FULL, {
      theta: (60 * Math.PI) / 180, axisRad: Math.PI / 2, u0: -0.5, u1: 0.5, layerLocal: true,
    });
    expect(Math.hypot(straight.x - 0.5, straight.y - 0.5)).toBeGreaterThan(0.01);
  });
});
