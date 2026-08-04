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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';

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

  // `rep.copies` was in this list until document 1.5.0 folded the repeater into
  // the path-operator chain. It moved to the id-scoped resolver alongside
  // trim's — see the repeater case in the `pathop.<id>.<param>` block below.
  it('covers time, text and data-track paths', () => {
    for (const p of ['timeRemap', 'text.source', 'fill.stops', 'path.points']) {
      expect(hasPropertyMeta(p)).toBe(true);
      expect(propertyLabel(p)).not.toBe(p);
    }
  });

  /**
   * Path-operator params are id-scoped (`pathop.<opId>.<param>`), so no static
   * table can name them — they go through a resolver. Trim is why this exists:
   * it HAD literal `trim.start` / `trim.end` / `trim.offset` entries with real
   * labels, and folding it into the chain (v1.4.0) would have silently
   * downgraded every trim row in the timeline and the graph editor to
   * "Pathop Trimop Rect End" if the resolver had not landed with it.
   */
  it('names path-operator params, including the trim that used to be static', () => {
    for (const p of ['pathop.abc.amount', 'pathop.abc.end', 'pathop.abc.offset']) {
      expect(hasPropertyMeta(p)).toBe(true);
      expect(propertyLabel(p)).not.toBe(p);
      expect(propertyLabel(p)).not.toMatch(/pathop/i);
    }
    // The retired path is genuinely gone. Asserting on its LABEL would prove
    // nothing — the generic fallback title-cases `trim.start` into "Trim Start",
    // which is indistinguishable from a real entry. `hasPropertyMeta` is the
    // question that actually has an answer: is any table or resolver claiming
    // to describe it?
    expect(hasPropertyMeta('trim.start')).toBe(false);
    expect(hasPropertyMeta('trim.end')).toBe(false);
  });

  /**
   * The repeater's rows, one version later and for the same reason.
   *
   * `rep.copies` / `rep.offsetScale` / `rep.offsetOpacity` were STATIC entries
   * with real labels, bounds and steps. Folding the repeater into the chain
   * (v1.5.0) moved them behind the same id-scoped resolver, and without a
   * repeater branch there every one of them would have degraded to a
   * title-cased id — "Path Operator Offsetscale", stepping by 1, so a Scale row
   * would jump from 1 straight to 2 and an Opacity row would drag past its own
   * range. The bounds are the half that a label-only check would miss.
   */
  describe('the repeater, which used to be static too', () => {
    const NODE = 'repmeta_node';
    beforeAll(() => {
      defaultSceneGraph.addChild(
        'comp_root',
        {
          id: NODE, name: NODE, parent: 'comp_root', children: [], visible: true, locked: false,
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [{ id: `${NODE}_fx`, type: 'fx', props: { pathOps: [{ id: 'rop', type: 'repeater' }] } }],
        } as unknown as Parameters<typeof defaultSceneGraph.addChild>[1],
      );
    });

    it('names the rows the way the inspector card does', () => {
      expect(propertyLabel('pathop.rop.offsetRotation', NODE)).toBe('Repeater Rotation');
      expect(propertyLabel('pathop.rop.offsetX', NODE)).toBe('Repeater Position X');
      expect(propertyLabel('pathop.rop.copies', NODE)).toBe('Repeater Copies');
      // Not the generic fallback, which is what a missing branch would give.
      expect(propertyLabel('pathop.rop.offsetScale', NODE)).not.toMatch(/offsetscale/i);
    });

    it('keeps the bounds and steps the rep.* entries carried', () => {
      const scale = resolvePropertyMeta('pathop.rop.offsetScale', NODE);
      expect(scale.step).toBeLessThan(1);
      expect(scale.min).toBe(0);
      // Reset lands on the NO-OP value. Defaulting to 0 would make "reset"
      // collapse every copy to nothing.
      expect(scale.defaultValue).toBe(1);

      const opacity = resolvePropertyMeta('pathop.rop.offsetOpacity', NODE);
      expect(opacity.min).toBe(0);
      expect(opacity.max).toBe(1);
      expect(opacity.defaultValue).toBe(1);

      const copies = resolvePropertyMeta('pathop.rop.copies', NODE);
      expect(copies.min).toBe(1);
      expect(copies.max).toBe(200);
      expect(copies.precision).toBe(0);

      expect(resolvePropertyMeta('pathop.rop.offsetX', NODE).unit).toBe('px');
      expect(resolvePropertyMeta('pathop.rop.offsetRotation', NODE).unit).toBe('°');
    });

    it('sorts into the repeater group, not the shape-geometry one', () => {
      expect(resolvePropertyMeta('pathop.rop.copies', NODE).group).toBe('repeater');
      expect(resolvePropertyMeta('pathop.rop.copies', NODE).order).toBe(ORDER.repeater);
    });

    it('the retired rep.* paths are genuinely gone', () => {
      expect(hasPropertyMeta('rep.copies')).toBe(false);
      expect(hasPropertyMeta('rep.offsetScale')).toBe(false);
    });
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

  it('ranges every channel 0..1 — the scale the tracks are stored in', () => {
    // This asserted 255 for RGB, which no writer and no reader ever used: the
    // tracks are written by `Color.fromHex` and read back in 0..1, so the row
    // described a range 255× wider than the values in it. See
    // core/effects/colorChannelUnits.test.ts for the end-to-end round-trip.
    for (const path of ['fill_r', 'fill_g', 'fill_b', 'fill_a', 'stroke_r']) {
      const m = resolvePropertyMeta(path);
      expect(m.min).toBe(0);
      expect(m.max).toBe(1);
      expect(m.step).toBeLessThan(1);
    }
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
