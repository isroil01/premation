import {
  layerStylesToFilter,
  layerStylesToEffects,
  readNodeLayerStyles,
  LAYER_STYLE_NUMBER_PARAMS,
  LAYER_STYLE_COLOR_PARAMS,
  LAYER_STYLE_EFFECT_TYPE,
  DEFAULT_DROP_SHADOW,
  DEFAULT_OUTER_GLOW,
  DEFAULT_INNER_SHADOW,
  DEFAULT_INNER_GLOW,
  DEFAULT_SATIN,
  DEFAULT_BEVEL,
  DEFAULT_COLOR_OVERLAY,
  DEFAULT_GRADIENT_OVERLAY,
  DEFAULT_STROKE_STYLE,
  type LayerStyles,
} from './layerStyles';
import type { SceneNode } from '@core/types';

describe('layerStylesToFilter', () => {
  test('undefined / empty → no filter', () => {
    expect(layerStylesToFilter(undefined)).toBe('');
    expect(layerStylesToFilter({})).toBe('');
  });

  test('drop shadow → a drop-shadow() with distance projected by angle', () => {
    const f = layerStylesToFilter({
      dropShadow: { enabled: true, color: '#000000', opacity: 0.5, distance: 10, angle: 0, blur: 4 },
    });
    // angle 0 ⇒ dx=10, dy=0; opacity 0.5 on opaque black.
    expect(f).toBe('drop-shadow(10px 0px 4px rgba(0, 0, 0, 0.500))');
  });

  test('angle 90 projects distance onto Y', () => {
    const f = layerStylesToFilter({
      dropShadow: { enabled: true, color: '#000000', opacity: 1, distance: 8, angle: 90, blur: 0 },
    });
    expect(f).toContain('drop-shadow(0px 8px 0px');
  });

  test('outer glow emits two drop-shadows for a fuller glow', () => {
    const f = layerStylesToFilter({
      outerGlow: { enabled: true, color: '#ffffff', opacity: 1, size: 20 },
    });
    expect(f.match(/drop-shadow/g)).toHaveLength(2);
    expect(f).toContain('0 0 20px');
    expect(f).toContain('0 0 10px');
  });

  test('disabled styles contribute nothing', () => {
    expect(layerStylesToFilter({ dropShadow: { ...DEFAULT_DROP_SHADOW, enabled: false } })).toBe('');
    expect(layerStylesToFilter({ outerGlow: { ...DEFAULT_OUTER_GLOW, enabled: false } })).toBe('');
  });

  test('combines drop shadow + outer glow', () => {
    const styles: LayerStyles = {
      dropShadow: { ...DEFAULT_DROP_SHADOW },
      outerGlow: { ...DEFAULT_OUTER_GLOW },
    };
    expect(layerStylesToFilter(styles).match(/drop-shadow/g)).toHaveLength(3); // 1 shadow + 2 glow
  });
});

describe('readNodeLayerStyles', () => {
  const node = (fxProps: Record<string, unknown> | null): SceneNode =>
    ({ id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
       transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
       components: fxProps ? [{ id: 'fx', type: 'fx', props: fxProps }] : [] } as unknown as SceneNode);

  test('returns styles when a style is enabled', () => {
    const s = readNodeLayerStyles(node({ layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW } } }));
    expect(s?.dropShadow?.enabled).toBe(true);
  });

  test('undefined when no fx / no enabled style', () => {
    expect(readNodeLayerStyles(node(null))).toBeUndefined();
    expect(readNodeLayerStyles(node({ layerStyles: {} }))).toBeUndefined();
  });
});

/**
 * The inspector puts keyframes on `effect.layerstyle:<style>.<param>` using
 * LAYER_STYLE_*_PARAMS, and the renderer samples whatever `layerStylesToEffects`
 * emitted. If those two disagree by so much as a param name, the stopwatch
 * writes a track nothing reads and the control silently stops animating — the
 * failure this whole feature exists to avoid.
 *
 * So: every mapped param must actually appear on the compiled effect.
 */
describe('style→effect param map matches what layerStylesToEffects emits', () => {
  // Every style enabled with non-zero values, so all nine compile.
  const ALL: LayerStyles = {
    dropShadow: { ...DEFAULT_DROP_SHADOW },
    outerGlow: { ...DEFAULT_OUTER_GLOW },
    innerShadow: { ...DEFAULT_INNER_SHADOW },
    innerGlow: { ...DEFAULT_INNER_GLOW },
    satin: { ...DEFAULT_SATIN },
    bevel: { ...DEFAULT_BEVEL },
    colorOverlay: { ...DEFAULT_COLOR_OVERLAY },
    gradientOverlay: { ...DEFAULT_GRADIENT_OVERLAY },
    stroke: { ...DEFAULT_STROKE_STYLE },
  };

  const compiled = new Map(
    layerStylesToEffects(ALL).map((e) => [e.id, e]),
  );

  const check = (styleKey: string, params: readonly string[]): void => {
    const fx = compiled.get(`layerstyle:${styleKey}`);
    expect(fx).toBeDefined();
    for (const p of params) {
      expect(Object.keys(fx!.params ?? {})).toContain(p);
    }
  };

  for (const [styleKey, fields] of Object.entries(LAYER_STYLE_NUMBER_PARAMS)) {
    test(`${styleKey} numeric params exist on the effect`, () => {
      check(styleKey, Object.values(fields).map((b) => b.param));
    });
  }

  for (const [styleKey, fields] of Object.entries(LAYER_STYLE_COLOR_PARAMS)) {
    test(`${styleKey} colour params exist on the effect`, () => {
      check(styleKey, Object.values(fields));
    });
  }

  test('LAYER_STYLE_EFFECT_TYPE names the type actually emitted', () => {
    // The timeline resolves a style track's label through this map. If it named
    // the wrong type, rows would show another effect's parameter descriptions.
    for (const [styleKey, type] of Object.entries(LAYER_STYLE_EFFECT_TYPE)) {
      expect(compiled.get(`layerstyle:${styleKey}`)?.type).toBe(type);
    }
  });

  test('every compiled style is covered by the map', () => {
    for (const id of compiled.keys()) {
      const styleKey = id.replace('layerstyle:', '');
      expect(
        LAYER_STYLE_NUMBER_PARAMS[styleKey] ?? LAYER_STYLE_COLOR_PARAMS[styleKey],
      ).toBeDefined();
    }
  });
});
