import {
  isMatteMode,
  isLegacyMatteType,
  readMatte,
  readNodeMatte,
  matteLabel,
  MATTE_MODES,
} from './matte';
import {
  MATTE_OPTIONS,
  matteOptionId,
  applyMatteOption,
  setMatteSource,
} from '@components/MatteControl/matteMenu';
import type { SceneNode } from '@core/types';

function nodeWithFx(props?: Record<string, unknown>): SceneNode {
  const components = props ? [{ type: 'fx', props }] : [];
  return { components } as unknown as SceneNode;
}

describe('matte model — two fields, not four enum values', () => {
  it('exposes exactly the two kinds', () => {
    expect(MATTE_MODES.map((m) => m.mode)).toEqual(['alpha', 'luma']);
    expect(isMatteMode('alpha')).toBe(true);
    expect(isMatteMode('luma')).toBe(true);
    expect(isMatteMode('alpha-inv')).toBe(false); // an inverted alpha, not a kind
  });

  it('reads the current object shape', () => {
    expect(readMatte({ mode: 'luma', inverted: true })).toEqual({ mode: 'luma', inverted: true });
    expect(readMatte({ mode: 'alpha', inverted: false, sourceId: 'n7' }))
      .toEqual({ mode: 'alpha', inverted: false, sourceId: 'n7' });
  });

  it('treats a missing `inverted` as false rather than undefined', () => {
    // A half-written object must not yield `inverted: undefined`, which is falsy
    // at the shader boundary but not equal to `false` in a snapshot comparison.
    expect(readMatte({ mode: 'alpha' })).toEqual({ mode: 'alpha', inverted: false });
  });

  it('returns undefined for every spelling of "no matte"', () => {
    for (const v of [undefined, null, '', 'none', {}, { mode: 'bogus' }, 42]) {
      expect(readMatte(v)).toBeUndefined();
    }
  });
});

describe('reading legacy documents (the rollback story)', () => {
  it.each([
    ['alpha', { mode: 'alpha', inverted: false }],
    ['alpha-inv', { mode: 'alpha', inverted: true }],
    ['luma', { mode: 'luma', inverted: false }],
    ['luma-inv', { mode: 'luma', inverted: true }],
  ] as const)('legacy string %s', (legacy, expected) => {
    expect(isLegacyMatteType(legacy)).toBe(true);
    expect(readMatte(legacy)).toEqual(expected);
  });

  it('legacy OBJECT form, preserving sourceId', () => {
    // The shape that loses the explicit source if only strings are handled: the
    // layer stays matted and is cut to the wrong mask.
    expect(readMatte({ mode: 'luma-inv', sourceId: 'src1' }))
      .toEqual({ mode: 'luma', inverted: true, sourceId: 'src1' });
  });

  it('reads a node carrying either shape', () => {
    expect(readNodeMatte(nodeWithFx({ matte: 'alpha-inv' })))
      .toEqual({ mode: 'alpha', inverted: true });
    expect(readNodeMatte(nodeWithFx({ matte: { mode: 'luma', inverted: false } })))
      .toEqual({ mode: 'luma', inverted: false });
    expect(readNodeMatte(nodeWithFx())).toBeUndefined();
  });
});

describe('matteLabel', () => {
  it('uses AE wording', () => {
    expect(matteLabel(undefined)).toBe('No matte');
    expect(matteLabel({ mode: 'alpha', inverted: false })).toBe('Alpha');
    expect(matteLabel({ mode: 'luma', inverted: true })).toBe('Luma Inverted');
  });
});

describe('the shared matte menu (one definition, two hosts)', () => {
  it('offers the four combinations plus none', () => {
    expect(MATTE_OPTIONS.map((o) => o.id)).toEqual(['none', 'alpha', 'alpha-inv', 'luma', 'luma-inv']);
  });

  it('round-trips every option through matteOptionId', () => {
    for (const o of MATTE_OPTIONS) expect(matteOptionId(o.value)).toBe(o.id);
  });

  it('identifies legacy stored values too', () => {
    expect(matteOptionId('luma-inv')).toBe('luma-inv');
    expect(matteOptionId({ mode: 'alpha-inv', sourceId: 'x' })).toBe('alpha-inv');
    expect(matteOptionId(undefined)).toBe('none');
  });

  it('PRESERVES an explicit source across a mode change', () => {
    // The failure this prevents: switching Alpha -> Luma silently re-points the
    // matte at whatever layer sits above. Still matted, still looks plausible,
    // cut to the wrong shape.
    const stored = { mode: 'alpha', inverted: false, sourceId: 'src9' };
    expect(applyMatteOption(stored, 'luma-inv'))
      .toEqual({ mode: 'luma', inverted: true, sourceId: 'src9' });
  });

  it('preserves the source when coming from a LEGACY stored value', () => {
    expect(applyMatteOption({ mode: 'luma-inv', sourceId: 'src9' }, 'alpha'))
      .toEqual({ mode: 'alpha', inverted: false, sourceId: 'src9' });
  });

  it('clears the matte entirely for "none"', () => {
    expect(applyMatteOption({ mode: 'alpha', inverted: true, sourceId: 'z' }, 'none')).toBeUndefined();
  });

  it('setMatteSource changes only the source', () => {
    const m = { mode: 'luma' as const, inverted: true, sourceId: 'old' };
    expect(setMatteSource(m, 'new')).toEqual({ mode: 'luma', inverted: true, sourceId: 'new' });
    expect(setMatteSource(m, undefined)).toEqual({ mode: 'luma', inverted: true });
    expect(setMatteSource(undefined, 'new')).toBeUndefined();
  });
});
