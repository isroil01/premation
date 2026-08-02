/**
 * Layer styles must actually reach the renderer.
 *
 * They used to compile to a CSS `filter` string on `RenderLayer.filter`, and
 * nothing reads that field — it fed the deleted Canvas2D backend. The Drop
 * Shadow and Outer Glow controls therefore produced no pixels, and nine of the
 * sixteen style presets (Glass, Neon, Sticker, Long Shadow…) shipped their
 * fills and strokes but not their depth.
 *
 * The proof is stronger than "a shadow appears somewhere": a layer WITH a style
 * and the same layer WITHOUT one must not produce identical renderables. If
 * they do, the GPU has nothing to draw from, whatever the panel says.
 */

import { layerToRenderable } from '@core/rendering/snapshotToFrameScene';
import type { RenderLayer } from '@core/rendering/RenderBackend';
import { layerStylesToEffects, type LayerStyles } from './layerStyles';

function layer(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 'n1', kind: 'shape', x: 100, y: 200, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 220, height: 220, fill: '#ff0000', visible: true, primitive: 'rect',
    ...over,
  };
}

const DROP_SHADOW: LayerStyles = {
  dropShadow: { enabled: true, color: '#000000', opacity: 0.5, distance: 8, angle: 90, blur: 8 },
};
const OUTER_GLOW: LayerStyles = {
  outerGlow: { enabled: true, color: '#78b4ff', opacity: 0.9, size: 16 },
};

describe('layerStylesToEffects', () => {
  it('turns a drop shadow into a structured, GPU-drawable effect', () => {
    const fx = layerStylesToEffects(DROP_SHADOW);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.type).toBe('drop-shadow');
    // The renderer needs numbers it can act on, not a CSS string it cannot.
    expect(typeof fx[0]!.params!.softness).toBe('number');
    expect(typeof fx[0]!.params!.distance).toBe('number');
    expect(typeof fx[0]!.params!.angle).toBe('number');
  });

  it('turns an outer glow into a glow effect', () => {
    const fx = layerStylesToEffects(OUTER_GLOW);
    expect(fx.map((e) => e.type)).toEqual(['glow']);
  });

  it('emits both, shadow first so the glow sits above it', () => {
    expect(layerStylesToEffects({ ...DROP_SHADOW, ...OUTER_GLOW }).map((e) => e.type)).toEqual([
      'drop-shadow',
      'glow',
    ]);
  });

  it('emits nothing for absent, disabled or zero-strength styles', () => {
    expect(layerStylesToEffects(undefined)).toEqual([]);
    expect(layerStylesToEffects({})).toEqual([]);
    expect(layerStylesToEffects({ dropShadow: { ...DROP_SHADOW.dropShadow!, enabled: false } })).toEqual([]);
    expect(layerStylesToEffects({ outerGlow: { ...OUTER_GLOW.outerGlow!, size: 0 } })).toEqual([]);
    // A shadow with no offset AND no blur has nothing to draw.
    expect(
      layerStylesToEffects({ dropShadow: { ...DROP_SHADOW.dropShadow!, distance: 0, blur: 0 } }),
    ).toEqual([]);
  });

  /**
   * Opacity rides the effect's own `opacity` param, NOT a pre-multiplied
   * 8-digit colour.
   *
   * It used to be folded into the colour, which rendered identically but could
   * not be keyframed: `withAlpha` (effects.ts) only matches 6-digit hex, so it
   * handed the pre-alpha'd colour straight through and ignored whatever the
   * opacity param — animated or not — said.
   */
  it('carries style opacity on the effect param, keyframeable', () => {
    const [shadow] = layerStylesToEffects(DROP_SHADOW);
    // Plain 6-digit colour, so withAlpha() can apply the opacity param to it.
    expect(String(shadow!.params!.color).toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
    // 0.5 → 50%.
    expect(shadow!.params!.opacity).toBe(50);
  });

  /**
   * A zero-strength style still emits when it is ANIMATED — otherwise keyframing
   * opacity 0 → 100 could never start, because the frame whose stored value is 0
   * would emit no effect for the sampler to raise.
   */
  it('emits a zero-strength style when it carries keyframes', () => {
    const flat = { dropShadow: { ...DROP_SHADOW.dropShadow!, distance: 0, blur: 0 } };
    expect(layerStylesToEffects(flat)).toEqual([]);
    const animated = layerStylesToEffects(flat, undefined, undefined, (k) => k === 'dropShadow');
    expect(animated).toHaveLength(1);
    expect(animated[0]!.id).toBe('layerstyle:dropShadow');
  });
});

describe('a styled layer reaches the renderer differently from an unstyled one', () => {
  it('the layer effects list carries the style', () => {
    const styled = layer({ effects: layerStylesToEffects(DROP_SHADOW) });
    const plain = layer();
    // THE regression test: identical renderables mean the style is invisible.
    expect(layerToRenderable(styled)).not.toEqual(layerToRenderable(plain));
    expect(layerToRenderable(styled).effects?.some((e) => e.type === 'drop-shadow')).toBe(true);
    expect(layerToRenderable(plain).effects ?? []).toEqual([]);
  });

  it('a CSS filter string alone changes nothing — the old, dead path', () => {
    // Pinning why the bug was invisible in code review: `filter` is accepted by
    // the type and ignored by every backend.
    const withFilter = layer({ filter: 'drop-shadow(0px 8px 8px rgba(0,0,0,0.5))' });
    expect(layerToRenderable(withFilter)).toEqual(layerToRenderable(layer()));
  });

  it('a glow style produces a glow renderable effect', () => {
    const r = layerToRenderable(layer({ effects: layerStylesToEffects(OUTER_GLOW) }));
    expect(r.effects?.some((e) => e.type === 'glow')).toBe(true);
  });
});

describe('global light — what makes a STYLE different from the equivalent effect', () => {
  const bound = (over = {}): LayerStyles => ({
    dropShadow: { ...DROP_SHADOW.dropShadow!, useGlobalLight: true, angle: 90, ...over },
  });

  it('a bound shadow takes the composition light angle, not its own', () => {
    const [fx] = layerStylesToEffects(bound(), 200);
    expect(fx!.params!.angle).toBe(200);
  });

  it('every bound shadow in a comp agrees — one light, one direction', () => {
    const a = layerStylesToEffects(bound({ distance: 4 }), 137)[0]!;
    const b = layerStylesToEffects(bound({ distance: 40, color: '#ff0000' }), 137)[0]!;
    expect(a.params!.angle).toBe(b.params!.angle);
  });

  it('an UNBOUND shadow keeps its own angle regardless of the light', () => {
    const [fx] = layerStylesToEffects(
      { dropShadow: { ...DROP_SHADOW.dropShadow!, useGlobalLight: false, angle: 45 } },
      200,
    );
    expect(fx!.params!.angle).toBe(45);
  });

  it('binding does not destroy the style’s own angle — unbinding restores it', () => {
    // The stored angle is untouched while bound, so toggling back is lossless.
    const styles = bound({ angle: 33 });
    expect(layerStylesToEffects(styles, 200)[0]!.params!.angle).toBe(200);
    const unbound: LayerStyles = { dropShadow: { ...styles.dropShadow!, useGlobalLight: false } };
    expect(layerStylesToEffects(unbound, 200)[0]!.params!.angle).toBe(33);
  });

  it('falls back to the style angle when no light is supplied', () => {
    // A caller with no composition context (a thumbnail, a test) still renders.
    expect(layerStylesToEffects(bound({ angle: 77 }))[0]!.params!.angle).toBe(77);
    expect(layerStylesToEffects(bound({ angle: 77 }), NaN)[0]!.params!.angle).toBe(77);
  });

  it('accepts an unbounded light angle, so a sweep can cross 0 and keep going', () => {
    expect(layerStylesToEffects(bound(), 725)[0]!.params!.angle).toBe(725);
    expect(layerStylesToEffects(bound(), -90)[0]!.params!.angle).toBe(-90);
  });
});

describe('colour overlay, gradient overlay and stroke', () => {
  it('colour overlay maps to a fill, which composites INSIDE the layer alpha', () => {
    const fx = layerStylesToEffects({ colorOverlay: { enabled: true, color: '#ff2d55', opacity: 1 } });
    expect(fx.map((e) => e.type)).toEqual(['fill']);
    expect(fx[0]!.params!.color).toBe('#ff2d55');
    expect(fx[0]!.params!.opacity).toBe(100);
  });

  it('gradient overlay carries both stops and an angle', () => {
    const fx = layerStylesToEffects({
      gradientOverlay: { enabled: true, from: '#000000', to: '#ffffff', opacity: 0.5, angle: 30 },
    });
    expect(fx[0]!.type).toBe('gradient-ramp');
    expect(fx[0]!.params!.colorA).toBe('#000000');
    expect(fx[0]!.params!.colorB).toBe('#ffffff');
    expect(fx[0]!.params!.angle).toBe(30);
    expect(fx[0]!.params!.blend).toBe(50);
  });

  it('a gradient overlay can bind to the global light too', () => {
    const styles: LayerStyles = {
      gradientOverlay: { enabled: true, from: '#000', to: '#fff', opacity: 1, angle: 10, useGlobalLight: true },
    };
    expect(layerStylesToEffects(styles, 250)[0]!.params!.angle).toBe(250);
  });

  it('stroke maps to the silhouette-following stroke effect', () => {
    const fx = layerStylesToEffects({ stroke: { enabled: true, color: '#fff', opacity: 1, size: 6 } });
    expect(fx[0]!.type).toBe('stroke');
    expect(fx[0]!.params!.width).toBe(6);
  });

  it('stacks in Photoshop order: behind → recolour → on top', () => {
    const all: LayerStyles = {
      ...DROP_SHADOW,
      ...OUTER_GLOW,
      colorOverlay: { enabled: true, color: '#f00', opacity: 1 },
      gradientOverlay: { enabled: true, from: '#000', to: '#fff', opacity: 1, angle: 0 },
      stroke: { enabled: true, color: '#fff', opacity: 1, size: 3 },
    };
    expect(layerStylesToEffects(all, 90).map((e) => e.type)).toEqual([
      'drop-shadow', 'glow', 'fill', 'gradient-ramp', 'stroke',
    ]);
  });

  it('emits nothing for disabled or zero-strength variants', () => {
    expect(layerStylesToEffects({ colorOverlay: { enabled: false, color: '#f00', opacity: 1 } })).toEqual([]);
    expect(layerStylesToEffects({ colorOverlay: { enabled: true, color: '#f00', opacity: 0 } })).toEqual([]);
    expect(layerStylesToEffects({ stroke: { enabled: true, color: '#f00', opacity: 1, size: 0 } })).toEqual([]);
  });

  it('gives every style a STABLE id, so keyframes and caching hold', () => {
    const all: LayerStyles = {
      colorOverlay: { enabled: true, color: '#f00', opacity: 1 },
      stroke: { enabled: true, color: '#fff', opacity: 1, size: 3 },
    };
    const ids = layerStylesToEffects(all).map((e) => e.id);
    expect(ids).toEqual(['layerstyle:colorOverlay', 'layerstyle:stroke']);
    expect(layerStylesToEffects(all).map((e) => e.id)).toEqual(ids);
  });
});
