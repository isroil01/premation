import {
  isBlendMode,
  isMatteBlend,
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

  test('accepts the Matte family (M8c)', () => {
    for (const m of ['stencil-alpha', 'stencil-luma', 'silhouette-alpha', 'silhouette-luma']) {
      expect(isBlendMode(m)).toBe(true);
    }
  });

  test('accepts the Dissolve pair (M5) — their shader branch shipped', () => {
    // These spent the project's whole life as the deliberately-rejected pair
    // (a mode validating without its shader branch would store fine and render
    // as Normal with no signal). Combine ids 35/36 landed 2026-08-20, so the
    // guard flips: rejecting them now would DROP the mode from any document
    // that stored it.
    for (const m of ['dissolve', 'dancing-dissolve']) {
      expect(isBlendMode(m)).toBe(true);
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
  test('ships all 38 of AE\'s 38', () => {
    // The last two, Dissolve and Dancing Dissolve (M5), landed 2026-08-20 with
    // shader ids 35/36 behind them. If this number moves again, something was
    // added without a shader branch behind it — check BLEND_COMBINE first.
    expect(BLEND_MODES).toHaveLength(38);
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
    expect(seen).toEqual(['Normal', 'Subtractive', 'Additive', 'Complex', 'Difference', 'HSL', 'Utility', 'Matte']);
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
    expect(count('Matte')).toBe(4);
  });

  test('the Matte family is exactly the four modes that scale the backdrop', () => {
    // isMatteBlend gates behaviour that must not apply to an ordinary blend, so
    // the set and the table have to agree — two lists of the same thing is a
    // §2·0 site if nothing checks them against each other.
    const fromTable = BLEND_MODES.filter((b) => b.group === 'Matte').map((b) => b.mode);
    expect(fromTable.filter(isMatteBlend)).toEqual(fromTable);
    expect(BLEND_MODES.filter((b) => b.group !== 'Matte').some((b) => isMatteBlend(b.mode))).toBe(false);
  });

  test('every table entry passes its own validator', () => {
    for (const { mode } of BLEND_MODES) expect(isBlendMode(mode as LayerBlendMode)).toBe(true);
  });
});
