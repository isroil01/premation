import {
  resolvePropertyMeta,
  propertyLabel,
  propertyUnit,
  propertyOrder,
  hasPropertyMeta,
  staticPropertyPaths,
  groupPlaceholderPath,
  ORDER,
} from './propertyMeta';
import { POSITION_PSEUDO_PROP } from '@motion/animation';
import { EFFECT_DEFS } from '@core/effects/effects';

describe('propertyMeta — static entries', () => {
  it('describes the transform group with AE labels and units', () => {
    expect(propertyLabel('x')).toBe('Position X');
    expect(propertyLabel('anchorY')).toBe('Anchor Point Y');
    expect(propertyLabel('scaleX')).toBe('Scale X');
    expect(propertyUnit('x')).toBe('px');
    expect(propertyUnit('rotation')).toBe('°');
    expect(propertyUnit('scaleX')).toBe('x');
    expect(propertyUnit('opacity')).toBe('%');
  });

  it('gives scale a fractional step — a 1-per-pixel scrub is unusable', () => {
    expect(resolvePropertyMeta('scaleX').step).toBeLessThan(1);
    expect(resolvePropertyMeta('scaleX').defaultValue).toBe(1);
  });

  it('leaves scale unbounded below — a negative scale is how you flip a layer', () => {
    for (const p of ['scale', 'scaleX', 'scaleY', 'scaleZ']) {
      expect(resolvePropertyMeta(p).min).toBeUndefined();
    }
  });

  it('leaves rotation unbounded — a wrapped angle cannot express "spin 3×"', () => {
    const m = resolvePropertyMeta('rotation');
    expect(m.min).toBeUndefined();
    expect(m.max).toBeUndefined();
  });

  it('clamps opacity to 0..100, the range the Style component stores', () => {
    const m = resolvePropertyMeta('opacity');
    expect(m.min).toBe(0);
    expect(m.max).toBe(100);
    expect(m.defaultValue).toBe(100);
  });

  it('marks size non-resettable — "reset" would mean 0x0', () => {
    expect(resolvePropertyMeta('width').resettable).toBe(false);
    expect(resolvePropertyMeta('height').resettable).toBe(false);
  });

  it('keeps gradient geometry in STORED units with a display scale', () => {
    const m = resolvePropertyMeta('fillCenterX');
    // Stored 0..1 (renderer units), shown as a percentage.
    expect(m.min).toBe(0);
    expect(m.max).toBe(1);
    expect(m.displayScale).toBe(100);
    expect(m.unit).toBe('%');
  });

  it('labels the merged Position pseudo-track off the engine constant', () => {
    expect(propertyLabel(POSITION_PSEUDO_PROP)).toBe('Position');
    expect(propertyUnit(POSITION_PSEUDO_PROP)).toBe('px');
  });

  it('covers trim, repeater, time, text and data-track paths', () => {
    for (const p of ['trim.start', 'rep.copies', 'timeRemap', 'text.source', 'fill.stops', 'path.points']) {
      expect(hasPropertyMeta(p)).toBe(true);
      expect(propertyLabel(p)).not.toBe(p);
    }
  });
});

describe('propertyMeta — AE property order', () => {
  it('sorts Anchor → Position → Scale → Rotation → Orientation → Opacity', () => {
    const paths = ['opacity', 'rotation', 'x', 'anchorX', 'orientationX', 'scaleX'];
    const sorted = [...paths].sort((a, b) => propertyOrder(a) - propertyOrder(b));
    expect(sorted).toEqual(['anchorX', 'x', 'scaleX', 'rotation', 'orientationX', 'opacity']);
  });

  it('places a placeholder row at the same slot as its real props', () => {
    expect(propertyOrder(groupPlaceholderPath('position'))).toBe(propertyOrder('x'));
    expect(propertyOrder(groupPlaceholderPath('scale'))).toBe(propertyOrder('scaleX'));
  });

  it('sorts non-transform properties after the transform group', () => {
    expect(propertyOrder('trim.start')).toBeGreaterThan(propertyOrder('opacity'));
    expect(propertyOrder('effect.fx_1.radius')).toBeGreaterThan(propertyOrder('opacity'));
  });
});

describe('propertyMeta — group placeholders', () => {
  it('borrows label and unit from a representative member', () => {
    expect(propertyLabel(groupPlaceholderPath('anchor'))).toBe('Anchor Point');
    expect(propertyUnit(groupPlaceholderPath('anchor'))).toBe('px');
    expect(propertyUnit(groupPlaceholderPath('scale'))).toBe('x');
    expect(propertyUnit(groupPlaceholderPath('opacity'))).toBe('%');
  });

  it('is typed as a group, not a real numeric track', () => {
    expect(resolvePropertyMeta(groupPlaceholderPath('rotation')).type).toBe('group');
  });
});

describe('propertyMeta — effect parameters', () => {
  it('resolves an effect param to its definition label, not the raw path', () => {
    // This is the #30 regression: the timeline used to print the whole path.
    const m = resolvePropertyMeta('effect.fx_3.radius');
    expect(m.path).toBe('effect.fx_3.radius');
    expect(m.label).not.toContain('fx_3');
    expect(m.label).toContain('Radius');
    expect(m.group).toBe('effects');
  });

  it('carries the definition’s unit and range through', () => {
    const glow = EFFECT_DEFS.find((d) => d.type === 'glow')!;
    const radius = glow.params.find((p) => p.key === 'radius')!;
    const m = resolvePropertyMeta('effect.anything.radius');
    expect(m.unit).toBe(radius.unit);
    expect(m.min).toBe(radius.min);
    expect(m.max).toBe(radius.max);
  });

  it('types colour and checkbox params correctly', () => {
    expect(resolvePropertyMeta('effect.e1.color').type).toBe('color');
    expect(resolvePropertyMeta('effect.e1.monochrome').type).toBe('boolean');
  });

  it('gives a narrow numeric range a fractional step', () => {
    // Gamma is 0.1..10 in Levels — a step of 1 would skip the whole useful band.
    expect(resolvePropertyMeta('effect.e1.gamma').step).toBeLessThan(1);
  });

  it('falls back to a readable label for an unknown effect key', () => {
    const m = resolvePropertyMeta('effect.e1.someUnknownKey');
    expect(m.label).toBe('Some Unknown Key');
    expect(m.group).toBe('effects');
  });
});

describe('propertyMeta — decomposed colour channels', () => {
  it('names fill/stroke channel tracks', () => {
    expect(propertyLabel('fill_r')).toBe('Fill Color Red');
    expect(propertyLabel('stroke_a')).toBe('Stroke Color Alpha');
  });

  it('ranges RGB 0..255 and alpha 0..1', () => {
    expect(resolvePropertyMeta('fill_g').max).toBe(255);
    const alpha = resolvePropertyMeta('fill_a');
    expect(alpha.max).toBe(1);
    expect(alpha.step).toBeLessThan(1);
  });

  it('resolves an effect colour channel through its effect', () => {
    const m = resolvePropertyMeta('effect.e1.color_r');
    expect(m.label).toContain('Red');
    expect(m.group).toBe('effects');
  });
});

describe('propertyMeta — expression controls', () => {
  it('labels a ctrl_ slider', () => {
    expect(propertyLabel('ctrl_speed')).toBe('Speed (Control)');
    expect(resolvePropertyMeta('ctrl_speed').group).toBe('controls');
  });
});

describe('propertyMeta — fallback', () => {
  it('always returns an entry, title-casing an unknown path', () => {
    const m = resolvePropertyMeta('someMysteryProp');
    expect(m.path).toBe('someMysteryProp');
    expect(m.label).toBe('Some Mystery Prop');
    expect(m.group).toBe('other');
    expect(m.order).toBe(ORDER.other);
    expect(hasPropertyMeta('someMysteryProp')).toBe(false);
  });

  it('never returns an empty label for any statically-described path', () => {
    for (const p of staticPropertyPaths()) {
      expect(propertyLabel(p).length).toBeGreaterThan(0);
    }
  });
});
