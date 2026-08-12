/**
 * Bend's editor params → the GPU effect the renderer draws.
 *
 * Bend is `gpuOnly` with no Canvas2D twin, so this conversion is its entire
 * CPU-side surface; after it the only code left is WGSL/GLSL.
 *
 * ── What this effect used to get wrong ──────────────────────────────────────
 *
 * The first version parameterised the bend as an ANGLE plus two percentages
 * along it. AE's CC Bender uses two POINT controls, Top and Base, and that is
 * not a cosmetic difference: an angle-plus-extent cannot place the bend line
 * off-centre at all, and ties the axis to the layer's middle. The rewrite
 * derives direction, position and span from the two points — strictly more
 * expressive, and two fewer controls.
 *
 * Two conversions happen here and both fail quietly: rest+offset resolution
 * (points are stored as offsets so they default to zero and survive a resize)
 * and the aspect correction that stops a diagonal bend line shearing on a
 * non-square layer.
 */

import { extractSpatialEffects } from './snapshotToFrameScene';
import type { RenderLayer } from './RenderBackend';

/** 200×100 — deliberately non-square, so aspect handling is observable. */
const layerWithBend = (params: Record<string, unknown>, w = 200, h = 100): RenderLayer =>
  ({ width: w, height: h, effects: [{ type: 'bend', params }] }) as unknown as RenderLayer;

function bendOf(params: Record<string, unknown>, w?: number, h?: number) {
  const spatial = extractSpatialEffects(layerWithBend(params, w, h)) ?? [];
  return spatial.find((e) => e.type === 'bend') as
    | {
        type: 'bend'; angleRad: number; style: number; aspect: number;
        holdOutside: boolean;
        topX: number; topY: number; baseX: number; baseY: number;
      }
    | undefined;
}

describe('bend → FrameScene', () => {
  it('is emitted at all', () => {
    // A registered EffectType with no emit branch renders NOTHING while tsc
    // stays clean and the suite stays green.
    expect(bendOf({ amount: 90 })).toBeDefined();
  });

  it('converts the bend amount from degrees to radians', () => {
    expect(bendOf({ amount: 180 })!.angleRad).toBeCloseTo(Math.PI, 6);
  });

  it('keeps a negative bend negative, so it curls the other way', () => {
    expect(bendOf({ amount: -90 })!.angleRad).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('allows multi-turn amounts rather than wrapping them', () => {
    // A keyframed curl through several turns must not hold still.
    expect(bendOf({ amount: 720 })!.angleRad).toBeCloseTo(4 * Math.PI, 6);
  });

  it('carries the style as an integer index the shader can branch on', () => {
    expect(bendOf({ style: 2 })!.style).toBe(2);
    // Keyframing an enum can land it fractionally between two modes; the
    // shader compares against fixed thresholds, so this must be whole.
    expect(Number.isInteger(bendOf({ style: 1.4 })!.style)).toBe(true);
  });
});

describe('the Top and Base points', () => {
  it('rest at the layer’s top-centre and bottom-centre, as in AE', () => {
    // With no offsets the bend line runs down the middle of the layer, so a
    // freshly applied Bend curls top to bottom.
    const b = bendOf({})!;
    // Aspect-corrected units: x is scaled by w/h, y is in units of h.
    expect(b.topX).toBeCloseTo(1, 6);      // (200/2 / 200) * 2
    expect(b.topY).toBeCloseTo(0, 6);
    expect(b.baseX).toBeCloseTo(1, 6);
    expect(b.baseY).toBeCloseTo(1, 6);
  });

  it('are OFFSETS from rest, not absolute positions', () => {
    // The convention every handled effect uses. Absolute params would make
    // each default depend on the layer size and break on resize.
    const b = bendOf({ topX: 50, baseY: -20 })!;
    expect(b.topX).toBeCloseTo(((100 + 50) / 200) * 2, 6);
    expect(b.baseY).toBeCloseTo((100 - 20) / 100, 6);
  });

  it('★ places the bend line ANYWHERE — the freedom the old params could not express', () => {
    // The point of the rewrite: an off-centre, diagonal bend line. The old
    // angle+extent form could only pivot about the layer's middle.
    const b = bendOf({ topX: -80, topY: 10, baseX: 60, baseY: -30 })!;
    expect(b.topX).not.toBeCloseTo(b.baseX, 3);
    expect(b.topY).not.toBeCloseTo(b.baseY, 3);
  });

  it('★ corrects for aspect, so a diagonal line does not shear', () => {
    /*
      A 45° line on a 200×100 layer is (100,100) px. In raw UV that is
      (0.5, 1.0) — not 45° at all, and the bend would skew. In aspect-corrected
      units the same offsets give equal x and y deltas.
    */
    const b = bendOf({ topX: -50, topY: 0, baseX: 50, baseY: 0 }, 200, 100)!;
    const dx = b.baseX - b.topX;   // 100px of width, in units of height
    const dy = b.baseY - b.topY;   // 100px of height
    expect(dx).toBeCloseTo(1, 6);
    expect(dy).toBeCloseTo(1, 6);
  });

  it('reports the layer aspect so the shader can undo the correction', () => {
    expect(bendOf({}, 200, 100)!.aspect).toBeCloseTo(2, 6);
    expect(bendOf({}, 100, 400)!.aspect).toBeCloseTo(0.25, 6);
  });

  it('★ can confine the bend to the band, instead of hinging the whole object', () => {
    /*
      The gap this closes. With Carry — AE's CC Bender, and the only behaviour
      this effect had — everything past Base swings with the hinge, so bending
      a band in the middle still MOVES the rest of the object. There was no way
      to put a kink in something and leave the remainder alone.

      Hold is not derivable from Carry by moving the points: wherever Base sits,
      Carry transforms what is beyond it.
    */
    expect(bendOf({ outside: 0 })!.holdOutside).toBe(false);
    expect(bendOf({ outside: 1 })!.holdOutside).toBe(true);
  });

  it('defaults to Carry, matching CC Bender', () => {
    expect(bendOf({})!.holdOutside).toBe(false);
  });

  it('tolerates Top and Base coinciding rather than dividing by zero', () => {
    // Degenerate but reachable by dragging; the shader guards on span length,
    // and this pins that the emit does not produce NaN before it gets there.
    const b = bendOf({ topY: 100 })!; // top dragged onto base
    expect(Number.isFinite(b.topY)).toBe(true);
    expect(Number.isFinite(b.baseY)).toBe(true);
  });
});
