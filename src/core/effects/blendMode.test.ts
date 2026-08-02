import {
  isBlendMode,
  readNodeBlend,
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
    expect(isBlendMode('color-dodge')).toBe(true);
    expect(isBlendMode('luminosity')).toBe(true);
    expect(isBlendMode('vivid-light')).toBe(true);
    expect(isBlendMode('darker-color')).toBe(true);
    expect(isBlendMode('bogus')).toBe(false);
    expect(isBlendMode(undefined)).toBe(false);
    expect(isBlendMode(42)).toBe(false);
  });

  test('rejects modes that are named in the plan but not yet implemented', () => {
    // These are real AE modes we deliberately do NOT ship yet (M4/M5/M8c). If
    // one starts validating without its shader branch, a document could store a
    // mode that renders as Normal with no signal.
    for (const notYet of [
      'dissolve', 'dancing-dissolve',
      'stencil-alpha', 'stencil-luma', 'silhouette-alpha', 'silhouette-luma',
    ]) {
      expect(isBlendMode(notYet)).toBe(false);
    }
  });
});

describe('readNodeBlend', () => {
  test('defaults to normal when no fx component / no blendMode', () => {
    expect(readNodeBlend(nodeWithFx())).toBe('normal');
    expect(readNodeBlend(nodeWithFx({ effects: [] }))).toBe('normal');
  });

  test('reads a valid stored blend mode', () => {
    expect(readNodeBlend(nodeWithFx({ blendMode: 'screen' }))).toBe('screen');
    expect(readNodeBlend(nodeWithFx({ blendMode: 'hard-mix' }))).toBe('hard-mix');
  });

  test('falls back to normal for an invalid stored value', () => {
    // This is also the forward-compat story: a document saved by a NEWER build
    // that has more modes degrades to Normal here rather than failing to open.
    expect(readNodeBlend(nodeWithFx({ blendMode: 'bogus' }))).toBe('normal');
  });
});

describe('BLEND_MODES table', () => {
  test('ships 32 of AE\'s 38, with the 6 absentees accounted for', () => {
    // 38 - 32 = 6: Dissolve, Dancing Dissolve (M5) and Stencil/Silhouette x4
    // (M8c). If this number moves without a milestone landing, something was
    // added without a shader branch behind it.
    expect(BLEND_MODES).toHaveLength(32);
  });

  test('normal leads, and every mode is unique', () => {
    expect(BLEND_MODES[0]!.mode).toBe('normal');
    const modes = BLEND_MODES.map((b) => b.mode);
    expect(new Set(modes).size).toBe(modes.length);
  });

  test('labels are unique — two rows reading the same is a picker bug', () => {
    const labels = BLEND_MODES.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('uses AE\'s own group names, in AE\'s order', () => {
    const seen: string[] = [];
    for (const { group } of BLEND_MODES) if (seen[seen.length - 1] !== group) seen.push(group);
    expect(seen).toEqual(['Normal', 'Subtractive', 'Additive', 'Complex', 'Difference', 'HSL', 'Utility']);
  });

  test('groups are contiguous — a mode cannot appear outside its section', () => {
    const seen = new Set<string>();
    let prev = '';
    for (const { group } of BLEND_MODES) {
      if (group !== prev) {
        expect(seen.has(group)).toBe(false); // group resumed after being left
        seen.add(group);
        prev = group;
      }
    }
  });

  test('group sizes match AE', () => {
    const count = (g: string): number => BLEND_MODES.filter((b) => b.group === g).length;
    expect(count('Subtractive')).toBe(6);
    expect(count('Additive')).toBe(7);
    expect(count('Complex')).toBe(7);
    expect(count('Difference')).toBe(5);
    expect(count('HSL')).toBe(4);
    expect(count('Utility')).toBe(2);
  });

  test('every table entry passes its own validator', () => {
    for (const { mode } of BLEND_MODES) expect(isBlendMode(mode as LayerBlendMode)).toBe(true);
  });
});
