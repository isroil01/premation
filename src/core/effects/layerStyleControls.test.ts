/**
 * Every control on every layer style has to reach the renderer.
 *
 * The defects found in this area were never missing wiring — a static sweep of
 * the effect registry and the style interfaces turns up no unread field. They
 * were controls that ARRIVED and were then ignored downstream: the Gradient
 * Overlay's angle reached the pass, which threw it away for a hardcoded
 * diagonal; every colour reached the adapter, which parsed it to black.
 *
 * So these assert on VALUES, not on presence: change a control, and the number
 * the renderer receives must change with it.
 */

import {
  layerStylesToEffects,
  DEFAULT_DROP_SHADOW, DEFAULT_OUTER_GLOW, DEFAULT_INNER_SHADOW, DEFAULT_INNER_GLOW,
  DEFAULT_SATIN, DEFAULT_BEVEL, DEFAULT_COLOR_OVERLAY, DEFAULT_GRADIENT_OVERLAY,
  DEFAULT_STROKE_STYLE,
} from './layerStyles';
import { effectNumber, effectParam } from './effects';
import type { Effect } from './effects';

const byId = (fx: Effect[], id: string): Effect => {
  const e = fx.find((x) => x.id === id);
  if (!e) throw new Error(`no effect ${id} in [${fx.map((x) => x.id).join(', ')}]`);
  return e;
};

describe('every layer style compiles all ten of its kinds', () => {
  it('emits one effect per enabled style, in Photoshop stacking order', () => {
    const fx = layerStylesToEffects({
      dropShadow: { ...DEFAULT_DROP_SHADOW },
      innerShadow: { ...DEFAULT_INNER_SHADOW },
      outerGlow: { ...DEFAULT_OUTER_GLOW },
      innerGlow: { ...DEFAULT_INNER_GLOW },
      satin: { ...DEFAULT_SATIN },
      bevel: { ...DEFAULT_BEVEL },
      colorOverlay: { ...DEFAULT_COLOR_OVERLAY },
      gradientOverlay: { ...DEFAULT_GRADIENT_OVERLAY },
      stroke: { ...DEFAULT_STROKE_STYLE },
    });
    expect(fx.map((e) => e.id)).toEqual([
      'layerstyle:dropShadow', 'layerstyle:innerShadow', 'layerstyle:outerGlow',
      'layerstyle:innerGlow', 'layerstyle:satin', 'layerstyle:bevel',
      'layerstyle:colorOverlay', 'layerstyle:gradientOverlay', 'layerstyle:stroke',
    ]);
    // Ids must be STABLE — keyframe prop paths and the renderer's per-effect
    // cache are both keyed by them.
    expect(new Set(fx.map((e) => e.id)).size).toBe(fx.length);
  });

  it('a disabled style emits nothing', () => {
    expect(layerStylesToEffects({ dropShadow: { ...DEFAULT_DROP_SHADOW, enabled: false } })).toEqual([]);
  });
});

describe('the behavioural toggles actually change the output', () => {
  it('satin invert', () => {
    const off = byId(layerStylesToEffects({ satin: { ...DEFAULT_SATIN, invert: false } }), 'layerstyle:satin');
    const on = byId(layerStylesToEffects({ satin: { ...DEFAULT_SATIN, invert: true } }), 'layerstyle:satin');
    expect(effectParam(off, 'invert')).toBe(false);
    expect(effectParam(on, 'invert')).toBe(true);
  });

  it('bevel direction', () => {
    const up = byId(layerStylesToEffects({ bevel: { ...DEFAULT_BEVEL, direction: 'up' } }), 'layerstyle:bevel');
    const down = byId(layerStylesToEffects({ bevel: { ...DEFAULT_BEVEL, direction: 'down' } }), 'layerstyle:bevel');
    expect(effectParam(up, 'direction')).toBe('up');
    expect(effectParam(down, 'direction')).toBe('down');
  });

  it('gradient overlay carries BOTH endpoints and its angle', () => {
    const go = byId(
      layerStylesToEffects({ gradientOverlay: { ...DEFAULT_GRADIENT_OVERLAY, from: '#112233', to: '#445566', angle: 30 } }),
      'layerstyle:gradientOverlay',
    );
    expect(effectParam(go, 'colorA')).toBe('#112233');
    expect(effectParam(go, 'colorB')).toBe('#445566');
    // The angle used to stop at the pass, which hardcoded the box diagonal.
    expect(effectNumber(go, 'angle')).toBe(30);
  });
});

describe('global light binds the styles that claim to follow it', () => {
  const LIGHT = 12;
  const ALT = 34;

  it('drop shadow, inner shadow and gradient overlay take the comp light when bound', () => {
    const fx = layerStylesToEffects({
      dropShadow: { ...DEFAULT_DROP_SHADOW, angle: 999, useGlobalLight: true },
      innerShadow: { ...DEFAULT_INNER_SHADOW, angle: 999, useGlobalLight: true },
      gradientOverlay: { ...DEFAULT_GRADIENT_OVERLAY, angle: 999, useGlobalLight: true },
    }, LIGHT, ALT);
    expect(effectNumber(byId(fx, 'layerstyle:dropShadow'), 'angle')).toBe(LIGHT);
    expect(effectNumber(byId(fx, 'layerstyle:innerShadow'), 'angle')).toBe(LIGHT);
    expect(effectNumber(byId(fx, 'layerstyle:gradientOverlay'), 'angle')).toBe(LIGHT);
  });

  it('bevel takes the light ALTITUDE too — they are one light', () => {
    const bv = byId(layerStylesToEffects({
      bevel: { ...DEFAULT_BEVEL, angle: 999, altitude: 999, useGlobalLight: true },
    }, LIGHT, ALT), 'layerstyle:bevel');
    expect(effectNumber(bv, 'angle')).toBe(LIGHT);
    expect(effectNumber(bv, 'altitude')).toBe(ALT);
  });

  it('an UNBOUND style keeps its own angle', () => {
    const ds = byId(layerStylesToEffects({
      dropShadow: { ...DEFAULT_DROP_SHADOW, angle: 42, useGlobalLight: false },
    }, LIGHT, ALT), 'layerstyle:dropShadow');
    expect(effectNumber(ds, 'angle')).toBe(42);
  });

  it('with no comp light delivered, a bound style falls back to its own angle', () => {
    // A thumbnail or a test has no composition context; it must still render.
    const ds = byId(layerStylesToEffects({
      dropShadow: { ...DEFAULT_DROP_SHADOW, angle: 42, useGlobalLight: true },
    }), 'layerstyle:dropShadow');
    expect(effectNumber(ds, 'angle')).toBe(42);
  });
});

describe('sizes and opacities survive the compile', () => {
  it('each style passes its own magnitude through', () => {
    const fx = layerStylesToEffects({
      dropShadow: { ...DEFAULT_DROP_SHADOW, distance: 11, blur: 13, useGlobalLight: false },
      outerGlow: { ...DEFAULT_OUTER_GLOW, size: 17 },
      innerGlow: { ...DEFAULT_INNER_GLOW, size: 19 },
      stroke: { ...DEFAULT_STROKE_STYLE, size: 23 },
      bevel: { ...DEFAULT_BEVEL, size: 29, depth: 31, useGlobalLight: false },
    });
    expect(effectNumber(byId(fx, 'layerstyle:dropShadow'), 'distance')).toBe(11);
    expect(effectNumber(byId(fx, 'layerstyle:dropShadow'), 'softness')).toBe(13);
    expect(effectNumber(byId(fx, 'layerstyle:outerGlow'), 'radius')).toBe(17);
    expect(effectNumber(byId(fx, 'layerstyle:innerGlow'), 'size')).toBe(19);
    expect(effectNumber(byId(fx, 'layerstyle:stroke'), 'width')).toBe(23);
    expect(effectNumber(byId(fx, 'layerstyle:bevel'), 'size')).toBe(29);
    expect(effectNumber(byId(fx, 'layerstyle:bevel'), 'depth')).toBe(31);
  });

  it('a zero-size style is dropped rather than emitted as a no-op pass', () => {
    expect(layerStylesToEffects({ outerGlow: { ...DEFAULT_OUTER_GLOW, size: 0 } })).toEqual([]);
    expect(layerStylesToEffects({ stroke: { ...DEFAULT_STROKE_STYLE, size: 0 } })).toEqual([]);
    expect(layerStylesToEffects({ innerGlow: { ...DEFAULT_INNER_GLOW, size: 0 } })).toEqual([]);
  });
});
