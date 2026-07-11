import {
  isBlendMode,
  readNodeBlend,
  blendToComposite,
  BLEND_MODES,
  type LayerBlendMode,
} from './blendMode';
import type { SceneNode } from '@core/types';

/** Minimal node with just the components readNodeBlend inspects. */
function nodeWithFx(props?: Record<string, unknown>): SceneNode {
  const components = props ? [{ type: 'fx', props }] : [];
  return { components } as unknown as SceneNode;
}

describe('isBlendMode', () => {
  test('accepts the supported modes, rejects others', () => {
    expect(isBlendMode('multiply')).toBe(true);
    expect(isBlendMode('normal')).toBe(true);
    expect(isBlendMode('color-dodge')).toBe(false); // not in the dual-backend set
    expect(isBlendMode(undefined)).toBe(false);
    expect(isBlendMode(42)).toBe(false);
  });
});

describe('readNodeBlend', () => {
  test('defaults to normal when no fx component / no blendMode', () => {
    expect(readNodeBlend(nodeWithFx())).toBe('normal');
    expect(readNodeBlend(nodeWithFx({ effects: [] }))).toBe('normal');
  });

  test('reads a valid stored blend mode', () => {
    expect(readNodeBlend(nodeWithFx({ blendMode: 'screen' }))).toBe('screen');
  });

  test('falls back to normal for an invalid stored value', () => {
    expect(readNodeBlend(nodeWithFx({ blendMode: 'bogus' }))).toBe('normal');
  });
});

describe('blendToComposite', () => {
  const cases: Array<[LayerBlendMode, GlobalCompositeOperation]> = [
    ['normal', 'source-over'],
    ['multiply', 'multiply'],
    ['screen', 'screen'],
    ['overlay', 'overlay'],
    ['darken', 'darken'],
    ['lighten', 'lighten'],
    ['add', 'lighter'],
  ];
  test.each(cases)('%s → %s', (mode, op) => {
    expect(blendToComposite(mode)).toBe(op);
  });

  test('every listed mode maps to a composite op', () => {
    for (const { mode } of BLEND_MODES) {
      expect(typeof blendToComposite(mode)).toBe('string');
    }
  });
});
