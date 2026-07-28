import { resolveGlass, glassPropPath } from './glassResolve';
import { defaultGlassStyle } from './layerStyles';

describe('resolveGlass', () => {
  it('is off when the style is absent or disabled', () => {
    expect(resolveGlass(undefined, undefined)).toBeUndefined();
    expect(resolveGlass({ ...defaultGlassStyle(), enabled: false }, undefined)).toBeUndefined();
  });

  it('passes the static values through', () => {
    const g = resolveGlass({ ...defaultGlassStyle(), blur: 40, refraction: 12 }, undefined)!;
    expect(g.blur).toBe(40);
    expect(g.refraction).toBe(12);
  });

  it('lets an animated track win over the static value', () => {
    // The point of keyframing glass: a panel that frosts in over time.
    const av = new Map<string, number>([['glass.blur', 5]]);
    const g = resolveGlass({ ...defaultGlassStyle(), blur: 40 }, av)!;
    expect(g.blur).toBe(5);
  });

  it('clamps the 0..1 parameters', () => {
    const av = new Map<string, number>([
      ['glass.tintOpacity', 3],
      ['glass.grain', -1],
    ]);
    const g = resolveGlass(defaultGlassStyle(), av)!;
    expect(g.tintOpacity).toBe(1);
    expect(g.grain).toBe(0);
  });

  it('never lets a negative blur or radius through to the shader', () => {
    const av = new Map<string, number>([
      ['glass.blur', -20],
      ['glass.edgeWidth', -4],
      ['glass.rimWidth', -8],
    ]);
    const g = resolveGlass(defaultGlassStyle(), av)!;
    expect(g.blur).toBe(0);
    expect(g.edgeWidth).toBe(0);
    expect(g.rimWidth).toBe(0);
  });

  it('keeps the specular falloff above zero — pow(x, 0) is a flat highlight', () => {
    const g = resolveGlass({ ...defaultGlassStyle(), specularFalloff: 0 }, undefined)!;
    expect(g.specularFalloff).toBeGreaterThan(0);
  });

  it('binds the rim AND the specular to the global light together', () => {
    // They are one light; letting them diverge gives a highlight that
    // disagrees with the edge it is meant to be catching on.
    const g = resolveGlass(
      { ...defaultGlassStyle(), useGlobalLight: true, rimAngle: 10, specularAngle: 200 },
      undefined,
      45,
    )!;
    expect(g.rimAngle).toBe(45);
    expect(g.specularAngle).toBe(45);
  });

  it('keeps its own angles when not bound', () => {
    const g = resolveGlass(
      { ...defaultGlassStyle(), useGlobalLight: false, rimAngle: 10, specularAngle: 200 },
      undefined,
      45,
    )!;
    expect(g.rimAngle).toBe(10);
    expect(g.specularAngle).toBe(200);
  });

  it('falls back to its own angle when there is no composition light', () => {
    const g = resolveGlass(
      { ...defaultGlassStyle(), useGlobalLight: true, rimAngle: 10 },
      undefined,
      undefined,
    )!;
    expect(g.rimAngle).toBe(10);
  });

  it('ships a usable default rather than an inert one', () => {
    // A style whose defaults render nothing makes the user tune four sliders
    // before they can tell whether it works at all.
    const g = resolveGlass(defaultGlassStyle(), undefined)!;
    expect(g.blur).toBeGreaterThan(0);
    expect(g.refraction).not.toBe(0);
    expect(g.chromaticAberration).not.toBe(0);
    expect(g.grain).toBeGreaterThan(0);
  });
});

describe('glassPropPath', () => {
  it('namespaces glass parameters', () => {
    expect(glassPropPath('blur')).toBe('glass.blur');
    expect(glassPropPath('chromaticAberration')).toBe('glass.chromaticAberration');
  });
});
