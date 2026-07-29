/**
 * Inner shadow / inner glow — the INTERIOR compositing primitive.
 *
 * The defining property, and the one worth testing on real pixels rather than
 * on wiring: the band must land INSIDE the layer's own alpha and nowhere else.
 * A blur that bleeds outside the silhouette is an outer glow with extra steps,
 * and that failure looks almost right until you put the layer on a background.
 *
 * jsdom has no canvas, so these run only where a real 2D context exists; the
 * mapping tests below need no canvas and always run.
 */

import { layerStylesToEffects, DEFAULT_INNER_SHADOW, DEFAULT_INNER_GLOW, DEFAULT_SATIN, DEFAULT_BEVEL } from './layerStyles';
import { isCanvas2dOnlyEffect, applyCanvas2dEffect } from './canvas2dEffects';
import { EFFECT_DEFS, defaultParams, type Effect } from './effects';

describe('inner shadow / inner glow — style → effect mapping', () => {
  it('inner shadow maps to the interior effect with its geometry', () => {
    const fx = layerStylesToEffects({ innerShadow: { ...DEFAULT_INNER_SHADOW, useGlobalLight: false, angle: 45 } });
    expect(fx[0]!.type).toBe('inner-shadow');
    expect(fx[0]!.params!.angle).toBe(45);
    expect(fx[0]!.params!.distance).toBe(DEFAULT_INNER_SHADOW.distance);
  });

  it('inner shadow can bind to the global light like the drop shadow', () => {
    const fx = layerStylesToEffects({ innerShadow: { ...DEFAULT_INNER_SHADOW, useGlobalLight: true } }, 300);
    expect(fx[0]!.params!.angle).toBe(300);
  });

  it('inner glow has no angle — it comes from the whole contour', () => {
    const fx = layerStylesToEffects({ innerGlow: { ...DEFAULT_INNER_GLOW } });
    expect(fx[0]!.type).toBe('inner-glow');
    expect(fx[0]!.params!.angle).toBeUndefined();
  });

  it('emits Photoshop order: drop → inner shadow → outer glow → inner glow', () => {
    const types = layerStylesToEffects({
      dropShadow: { enabled: true, color: '#000', opacity: 0.5, distance: 8, angle: 90, blur: 8 },
      innerShadow: { ...DEFAULT_INNER_SHADOW },
      outerGlow: { enabled: true, color: '#fff', opacity: 1, size: 10 },
      innerGlow: { ...DEFAULT_INNER_GLOW },
    }, 90).map((e) => e.type);
    expect(types).toEqual(['drop-shadow', 'inner-shadow', 'glow', 'inner-glow']);
  });

  it('emits nothing when the style has no extent to draw', () => {
    expect(layerStylesToEffects({ innerShadow: { ...DEFAULT_INNER_SHADOW, size: 0, distance: 0 } })).toEqual([]);
    expect(layerStylesToEffects({ innerGlow: { ...DEFAULT_INNER_GLOW, size: 0 } })).toEqual([]);
  });

  it('satin maps to the interior effect with its set-algebra params', () => {
    const fx = layerStylesToEffects({ satin: { ...DEFAULT_SATIN, invert: true, angle: 20 } });
    expect(fx[0]!.type).toBe('satin');
    expect(fx[0]!.params!.invert).toBe(true);
    expect(fx[0]!.params!.angle).toBe(20);
  });

  it('satin emits nothing with no extent', () => {
    expect(layerStylesToEffects({ satin: { ...DEFAULT_SATIN, size: 0, distance: 0 } })).toEqual([]);
    expect(layerStylesToEffects({ satin: { ...DEFAULT_SATIN, opacity: 0 } })).toEqual([]);
  });

  it('bevel is the ONE style that consumes the light altitude', () => {
    // Every other bound style takes only the angle; a bevel needs to know how
    // steeply the light falls, because that decides how much of the ramp
    // catches it.
    const fx = layerStylesToEffects({ bevel: { ...DEFAULT_BEVEL, useGlobalLight: true } }, 200, 20);
    expect(fx[0]!.type).toBe('bevel');
    expect(fx[0]!.params!.angle).toBe(200);
    expect(fx[0]!.params!.altitude).toBe(20);
  });

  it('bevel angle and altitude bind TOGETHER — they are one light', () => {
    // Binding the angle but not the altitude would shade in a direction that
    // agrees with the comp and at a steepness that does not.
    const unbound = layerStylesToEffects(
      { bevel: { ...DEFAULT_BEVEL, useGlobalLight: false, angle: 10, altitude: 80 } }, 200, 20,
    );
    expect(unbound[0]!.params!.angle).toBe(10);
    expect(unbound[0]!.params!.altitude).toBe(80);
  });

  it('bevel emits nothing with no depth or no size', () => {
    expect(layerStylesToEffects({ bevel: { ...DEFAULT_BEVEL, depth: 0 } })).toEqual([]);
    expect(layerStylesToEffects({ bevel: { ...DEFAULT_BEVEL, size: 0 } })).toEqual([]);
  });

  it('all four interior styles are registered as real effects too', () => {
    for (const type of ['inner-shadow', 'inner-glow', 'satin', 'bevel']) {
      expect(EFFECT_DEFS.some((d) => d.type === type)).toBe(true);
      // No CSS form and no GPU shader — the chain must CPU-bake them, or they
      // would silently no-op on the GPU backend.
      expect(isCanvas2dOnlyEffect(type)).toBe(true);
    }
  });
});

// ── Pixel behaviour, where the compositor can be trusted ───────────
//
// Interior styles are alpha algebra (source-in / destination-in /
// destination-out) over a blurred silhouette, so they need a backend faithful on
// BOTH counts. The headless rasterizers are not: Skia doubles globalAlpha on
// those ops, node-canvas ignores ctx.filter. Either one renders wrong pixels
// that still satisfy the relational assertions below, so these skip rather than
// certify nothing. The real-Chromium coverage is packages/render-tests
// (scenes: interior-*).
import { canAssertLayerStylePixels } from './__testHelpers__/canvasFidelity';

const maybe = canAssertLayerStylePixels ? describe : describe.skip;

maybe('interior compositing stays inside the alpha', () => {
  const W = 80;
  const H = 80;

  /** A layer whose content is a centred opaque square, on transparent. */
  function layerCanvas(): CanvasRenderingContext2D {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#3080ff';
    g.fillRect(20, 20, 40, 40);
    return g;
  }

  const effect = (type: string, over: Record<string, string | number | boolean> = {}): Effect => {
    const def = EFFECT_DEFS.find((d) => d.type === type)!;
    return { id: `t_${type}`, type: type as Effect['type'], params: { ...defaultParams(def), ...over } };
  };

  const alphaAt = (g: CanvasRenderingContext2D, x: number, y: number): number =>
    g.getImageData(x, y, 1, 1).data[3]!;

  it('adds nothing outside the silhouette', () => {
    const g = layerCanvas();
    applyCanvas2dEffect(g, W, H, effect('inner-shadow', { distance: 6, softness: 10, opacity: 100 }));
    // Well outside the square — must still be fully transparent.
    for (const [x, y] of [[2, 2], [78, 2], [2, 78], [78, 78], [10, 40]]) {
      expect(alphaAt(g, x!, y!)).toBe(0);
    }
  });

  it('darkens the inside edge of the square', () => {
    const before = layerCanvas();
    const beforeEdge = before.getImageData(22, 22, 1, 1).data;
    const g = layerCanvas();
    applyCanvas2dEffect(g, W, H, effect('inner-shadow', { distance: 4, softness: 6, opacity: 100, color: '#000000' }));
    const afterEdge = g.getImageData(22, 22, 1, 1).data;
    // Same pixel, now darker, still opaque.
    expect(afterEdge[3]).toBeGreaterThan(0);
    expect(afterEdge[2]!).toBeLessThan(beforeEdge[2]!);
  });

  it('leaves the centre of a large shape essentially untouched', () => {
    const before = layerCanvas().getImageData(40, 40, 1, 1).data;
    const g = layerCanvas();
    applyCanvas2dEffect(g, W, H, effect('inner-shadow', { distance: 2, softness: 4, opacity: 100 }));
    const after = g.getImageData(40, 40, 1, 1).data;
    expect(Math.abs(after[2]! - before[2]!)).toBeLessThan(12);
  });

  it('inner glow LIGHTENS the inside edge rather than darkening it', () => {
    const before = layerCanvas().getImageData(22, 22, 1, 1).data;
    const g = layerCanvas();
    applyCanvas2dEffect(g, W, H, effect('inner-glow', { size: 8, opacity: 100, color: '#ffffff' }));
    const after = g.getImageData(22, 22, 1, 1).data;
    expect(after[0]!).toBeGreaterThan(before[0]!);
    expect(alphaAt(g, 2, 2)).toBe(0);
  });

  it('zero opacity is a no-op', () => {
    const before = layerCanvas().getImageData(0, 0, W, H).data;
    const g = layerCanvas();
    applyCanvas2dEffect(g, W, H, effect('inner-shadow', { opacity: 0 }));
    expect([...g.getImageData(0, 0, W, H).data]).toEqual([...before]);
  });
});
