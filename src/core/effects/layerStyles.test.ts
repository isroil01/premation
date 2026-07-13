import {
  layerStylesToFilter,
  readNodeLayerStyles,
  DEFAULT_DROP_SHADOW,
  DEFAULT_OUTER_GLOW,
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
