/**
 * Layer-style Spread (Drop Shadow / Outer Glow) and Stroke Position.
 *
 * Pins the compile → extract remapping that turns Photoshop's percent Spread
 * into dilate+blur footprints, and Position into the GPU/CPU stroke mode.
 */
import {
  layerStylesToEffects,
  DEFAULT_DROP_SHADOW,
  DEFAULT_OUTER_GLOW,
  DEFAULT_STROKE_STYLE,
  LAYER_STYLE_NUMBER_PARAMS,
} from './layerStyles';
import { effectCss } from './effects';
import { extractSpatialEffects } from '@core/rendering/snapshotToFrameScene';
import type { RenderLayer } from '@core/rendering/RenderBackend';

function layer(effects: RenderLayer['effects']): RenderLayer {
  return {
    id: 'L',
    kind: 'shape',
    visible: true,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    effects,
  } as RenderLayer;
}

describe('Spread compile + extract', () => {
  it('emits spread on drop shadow and remaps into radiusPx + spreadPx', () => {
    const fx = layerStylesToEffects({
      dropShadow: { ...DEFAULT_DROP_SHADOW, blur: 20, spread: 50, useGlobalLight: false },
    });
    expect(fx[0]!.params!.spread).toBe(50);
    expect(fx[0]!.params!.softness).toBe(20);

    const spatial = extractSpatialEffects(layer(fx))!;
    const ds = spatial.find((e) => e.type === 'drop-shadow')!;
    expect(ds.type).toBe('drop-shadow');
    if (ds.type !== 'drop-shadow') return;
    // Footprint-preserving: half dilate, half soft.
    expect(ds.radiusPx).toBeCloseTo(10, 5);
    expect(ds.spreadPx).toBeCloseTo(10, 5);
  });

  it('100% spread is a hard dilated edge (no soft blur)', () => {
    const fx = layerStylesToEffects({
      dropShadow: { ...DEFAULT_DROP_SHADOW, blur: 16, spread: 100, useGlobalLight: false },
    });
    const ds = extractSpatialEffects(layer(fx))!.find((e) => e.type === 'drop-shadow')!;
    if (ds.type !== 'drop-shadow') return;
    expect(ds.radiusPx).toBeCloseTo(0, 5);
    expect(ds.spreadPx).toBeCloseTo(16, 5);
  });

  it('outer glow spread remaps the same way against size/radius', () => {
    const fx = layerStylesToEffects({
      outerGlow: { ...DEFAULT_OUTER_GLOW, size: 40, spread: 25 },
    });
    expect(fx[0]!.params!.spread).toBe(25);
    const glow = extractSpatialEffects(layer(fx))!.find((e) => e.type === 'glow')!;
    if (glow.type !== 'glow') return;
    expect(glow.radiusPx).toBeCloseTo(30, 5);
    expect(glow.spreadPx).toBeCloseTo(10, 5);
  });

  it('CSS path hardens by shrinking blur when spread is set', () => {
    const css = effectCss({
      id: 'ds',
      type: 'drop-shadow',
      params: { distance: 0, angle: 0, softness: 20, spread: 50, color: '#000', opacity: 100 },
    });
    expect(css).toContain('10px'); // softness * (1 - 0.5)
    expect(css).not.toContain('20px');
  });

  it('binds Spread into LAYER_STYLE_NUMBER_PARAMS for stopwatches', () => {
    expect(LAYER_STYLE_NUMBER_PARAMS.dropShadow!.spread!.param).toBe('spread');
    expect(LAYER_STYLE_NUMBER_PARAMS.outerGlow!.spread!.param).toBe('spread');
  });
});

describe('Stroke Position', () => {
  it('defaults to Outside and omits position on the spatial effect', () => {
    const fx = layerStylesToEffects({ stroke: { ...DEFAULT_STROKE_STYLE } });
    expect(fx[0]!.params!.position).toBe('outside');
    const st = extractSpatialEffects(layer(fx))!.find((e) => e.type === 'stroke')!;
    if (st.type !== 'stroke') return;
    expect(st.position).toBeUndefined();
  });

  it('Inside and Center reach the spatial effect as numeric modes', () => {
    const inside = layerStylesToEffects({
      stroke: { ...DEFAULT_STROKE_STYLE, position: 'inside' },
    });
    const center = layerStylesToEffects({
      stroke: { ...DEFAULT_STROKE_STYLE, position: 'center' },
    });
    const si = extractSpatialEffects(layer(inside))!.find((e) => e.type === 'stroke')!;
    const sc = extractSpatialEffects(layer(center))!.find((e) => e.type === 'stroke')!;
    if (si.type !== 'stroke' || sc.type !== 'stroke') return;
    expect(si.position).toBe(1);
    expect(sc.position).toBe(2);
  });

  it('accepts numeric enum position from the effect inspector', () => {
    const spatial = extractSpatialEffects(layer([{
      id: 's', type: 'stroke',
      params: { width: 4, color: '#fff', opacity: 100, position: 1 },
    }]))!;
    const st = spatial.find((e) => e.type === 'stroke')!;
    if (st.type !== 'stroke') return;
    expect(st.position).toBe(1);
  });
});
