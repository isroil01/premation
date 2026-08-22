/**
 * The Perspective family's editor params → the GPU effects the renderer draws.
 *
 * All three are `gpuOnly` with no Canvas2D twin, so this conversion is their
 * entire CPU-side surface. Three unit changes happen here and every one of them
 * fails quietly rather than loudly:
 *
 *   • degrees → radians (a missing factor rotates the light, it does not throw)
 *   • percent → 0..1 (a missing /100 makes intensity 100× and blows to white)
 *   • pixels → UV (a missing divide makes a 4px bevel span the whole layer)
 *
 * Spotlight's cone carries a fourth: the CONTROL is the full cone angle and the
 * SHADER compares against a half-angle from the axis, so the conversion halves
 * it. Getting that wrong doubles the cone, which looks plausible.
 */

import { extractSpatialEffects } from './snapshotToFrameScene';
import type { RenderLayer } from './RenderBackend';

/** A 200×100 layer, so the pixels→UV scale is observable and not square. */
const layerWith = (type: string, params: Record<string, unknown>): RenderLayer =>
  ({ width: 200, height: 100, effects: [{ type, params }] }) as unknown as RenderLayer;

function emit(type: string, params: Record<string, unknown> = {}) {
  const spatial = extractSpatialEffects(layerWith(type, params)) ?? [];
  return spatial.find((e) => e.type === type) as Record<string, number> | undefined;
}

describe('bevels', () => {
  it.each(['bevel-alpha', 'bevel-edges'])('%s is emitted at all', (type) => {
    // A registered EffectType with no emit branch renders NOTHING while tsc
    // stays clean and the suite stays green.
    expect(emit(type, { thickness: 4 })).toBeDefined();
  });

  it('scales thickness from PIXELS into UV by the layer’s short side', () => {
    // 4px on a 200×100 layer → 4/100. Dividing by the wrong axis, or not at
    // all, is invisible on a square layer — hence the 2:1 fixture.
    expect(emit('bevel-alpha', { thickness: 4 })!.thickness).toBeCloseTo(0.04, 6);
  });

  it('converts the light angle to radians and the intensity out of percent', () => {
    const b = emit('bevel-edges', { thickness: 2, lightAngle: 90, intensity: 50 })!;
    expect(b.lightRad).toBeCloseTo(Math.PI / 2, 6);
    expect(b.intensity).toBeCloseTo(0.5, 6);
  });

  it('keeps a negative light angle negative', () => {
    // AE's default light is upper-left, i.e. a negative angle. Taking an
    // absolute value here would light every bevel from the same side.
    expect(emit('bevel-alpha', { lightAngle: -135 })!.lightRad).toBeCloseTo(-(3 * Math.PI) / 4, 6);
  });

  it('falls back to registry defaults when nothing is set', () => {
    const b = emit('bevel-alpha')!;
    expect(b.thickness).toBeCloseTo(4 / 100, 6);
    expect(b.intensity).toBeCloseTo(0.5, 6);
    expect(b.lightRad).toBeCloseTo(-(3 * Math.PI) / 4, 6);
  });
});

describe('spotlight', () => {
  it('is emitted at all', () => {
    expect(emit('spotlight')).toBeDefined();
  });

  it('HALVES the cone angle, because the shader measures from the axis', () => {
    // The control says "60° cone"; the shader asks "how far off-axis before it
    // falls dark". Passing the full angle through would double the cone.
    expect(emit('spotlight', { coneAngle: 60 })!.coneHalfRad).toBeCloseTo(Math.PI / 6, 6);
    expect(emit('spotlight', { coneAngle: 180 })!.coneHalfRad).toBeCloseTo(Math.PI / 2, 6);
  });

  it('rests with the lamp on the top edge aiming at the layer’s middle', () => {
    // 200×100 layer, aspect-corrected: x scaled by 2, y in units of height.
    const s = emit('spotlight')!;
    expect(s.fromX).toBeCloseTo(1, 6);
    expect(s.fromY).toBeCloseTo(0, 6);
    expect(s.toX).toBeCloseTo(1, 6);
    expect(s.toY).toBeCloseTo(0.5, 6);
  });

  it('★ From and To are POINTS, so the light can come from anywhere off-frame', () => {
    // The gap this closes: a centre-plus-angle-plus-radius form cannot express
    // "shine in from beyond that corner" without the user solving for the
    // angle. Both points move independently and may leave the layer.
    const s = emit('spotlight', { fromX: -300, fromY: -120, toX: 60, toY: 30 })!;
    const fromX = Number(s.fromX); const fromY = Number(s.fromY);
    expect(fromX).toBeLessThan(0);
    expect(fromY).toBeLessThan(0);
    expect(Number(s.toX)).toBeGreaterThan(fromX);
    expect(Number(s.toY)).toBeGreaterThan(fromY);
  });

  it('carries ambient separately from intensity', () => {
    // Ambient is what survives OUTSIDE the cone. Folding it into intensity
    // would make the effect an on/off mask with no way back. Use a mid value
    // that is NOT a migrated shipping default (15 / 55).
    const s = emit('spotlight', { intensity: 120, ambient: 40 })!;
    expect(s.intensity).toBeCloseTo(1.2, 6);
    expect(s.ambient).toBeCloseTo(0.4, 6);
  });

  it('defaults to full ambient so applying Spotlight does not blank the plate', () => {
    expect(emit('spotlight')!.ambient).toBeCloseTo(1, 6);
  });

  it('migrates catastrophic ambient defaults that read as a deleted scene', () => {
    expect(emit('spotlight', { ambient: 15 })!.ambient).toBeCloseTo(1, 6);
    expect(emit('spotlight', { ambient: 55 })!.ambient).toBeCloseTo(1, 6);
  });

  it('carries edge softness and the Render mode', () => {
    expect(emit('spotlight', { edgeSoftness: 40 })!.softness).toBeCloseTo(0.4, 6);
    expect(emit('spotlight', { render: 0 })!.lightOnly).toBe(false);
    expect(emit('spotlight', { render: 1 })!.lightOnly).toBe(true);
  });

  it('reports the aspect, so the cone is a cone and not an ellipse', () => {
    expect(emit('spotlight')!.aspect).toBeCloseTo(2, 6);
  });
});

describe('sphere and cylinder', () => {
  it.each(['sphere', 'cylinder'])('%s is emitted at all', (type) => {
    expect(emit(type)).toBeDefined();
  });

  it('converts rotations to radians, keeping multi-turn values intact', () => {
    // The range allows ±3600° so a spin can be keyframed across many turns.
    // Wrapping to ±180 here would make a 10-turn animation hold still.
    expect(emit('sphere', { rotateY: 720 })!.rotYRad).toBeCloseTo(4 * Math.PI, 6);
    expect(emit('cylinder', { rotation: -540 })!.rotRad).toBeCloseTo(-3 * Math.PI, 6);
  });

  it('sphere has all THREE rotation axes, as AE does', () => {
    // Z was missing. Without it a globe cannot be tilted off its pole, which
    // is most of what the effect gets used for.
    const s = emit('sphere', { rotateX: 30, rotateY: 60, rotateZ: 90 })!;
    expect(s.rotXRad).toBeCloseTo(Math.PI / 6, 6);
    expect(s.rotYRad).toBeCloseTo(Math.PI / 3, 6);
    expect(s.rotZRad).toBeCloseTo(Math.PI / 2, 6);
  });

  it('★ sphere reports aspect, so its silhouette is a CIRCLE not an ellipse', () => {
    // In raw UV a 200×100 layer compresses x by 2, so the silhouette test
    // describes an oval — the sphere was not a sphere on any non-square layer.
    expect(emit('sphere')!.aspect).toBeCloseTo(2, 6);
  });
});

describe('arithmetic (Channel)', () => {
  it('is emitted at all', () => {
    expect(emit('arithmetic')).toBeDefined();
  });

  it('normalises the 8-bit channel values to 0..1', () => {
    // Authored 0..255 because And/Or/Xor are only meaningful on integers —
    // AE's own controls are 8-bit for the same reason.
    const a = emit('arithmetic', { red: 255, green: 128, blue: 0 })!;
    expect(a.r).toBeCloseTo(1, 6);
    expect(a.g).toBeCloseTo(128 / 255, 6);
    expect(a.b).toBeCloseTo(0, 6);
  });

  it('carries every operator index as a whole number', () => {
    // The shader compares against fixed thresholds, so a keyframed enum landing
    // between two operators must resolve to one of them.
    expect(emit('arithmetic', { operator: 10 })!.operator).toBe(10);
    expect(Number.isInteger(emit('arithmetic', { operator: 3.6 })!.operator)).toBe(true);
  });

  it('★ reads Clip as a BOOLEAN, not through effectNumber', () => {
    /*
      `effectNumber` returns 0 for a checkbox param, so `n('clip') > 0.5` is
      unconditionally false — the control would persist, keyframe and do
      nothing. This codebase has shipped that exact dead control before (see
      set-matte's useLuminance/invert), which is why it is asserted rather
      than assumed.
    */
    expect(emit('arithmetic', {})!.clip).toBe(true);            // registry default
    expect(emit('arithmetic', { clip: false })!.clip).toBe(false);
    expect(emit('arithmetic', { clip: true })!.clip).toBe(true);
  });

  it('carries radius and shading as 0..1 fractions', () => {
    const s = emit('sphere', { radius: 150, shading: 70 })!;
    expect(s.radius).toBeCloseTo(1.5, 6);
    expect(s.shading).toBeCloseTo(0.7, 6);
  });

  it('keeps shading separate from the light colour', () => {
    // They answer different questions — how spherical it reads vs what lights
    // it — so an unlit sphere must still be tintable.
    const s = emit('sphere', { shading: 0 })!;
    expect(s.shading).toBe(0);
    expect(s.color).toBeDefined();
  });

  it('defaults to a sphere that touches the layer’s short edges', () => {
    expect(emit('sphere')!.radius).toBeCloseTo(1, 6);
    expect(emit('cylinder')!.radius).toBeCloseTo(1, 6);
  });
});
