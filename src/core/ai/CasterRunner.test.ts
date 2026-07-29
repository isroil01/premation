/**
 * The caster host adapter.
 *
 * Two things are tested here and nowhere else, because they are the only parts
 * of the caster path that are not already covered inside `@motion/caster`:
 *
 *  1. **Response parsing.** A real model wraps JSON in prose, in fences, or
 *     both, and sometimes returns a bare array where an object was asked for.
 *     Every one of those is recoverable and none should cost a run.
 *  2. **The fallbacks.** A response that cannot be parsed at all must still
 *     produce a renderable piece, because the alternative is a blank composition
 *     and an apology.
 */

import { __testables } from './CasterRunner';

const { extractJson, coerceBrief, coercePicks } = __testables;

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips an unlabelled fence', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignores prose before and after', () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('stops at the object\'s own closing brace, not a later one in prose', () => {
    // A greedy `lastIndexOf('}')` swallows the trailing sentence and fails to
    // parse. The balance scan is what makes this work.
    expect(extractJson('{"a":1}\nNote: use {curly braces} carefully.')).toEqual({ a: 1 });
  });

  it('handles braces INSIDE strings', () => {
    expect(extractJson('{"a":"a } b","c":2}')).toEqual({ a: 'a } b', c: 2 });
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"a":"say \\"hi\\"","b":1}')).toEqual({ a: 'say "hi"', b: 1 });
  });

  it('reads a bare array', () => {
    expect(extractJson('[{"id":"x"}]')).toEqual([{ id: 'x' }]);
  });

  it('handles nesting', () => {
    expect(extractJson('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
  });

  it('returns undefined for prose with no JSON', () => {
    expect(extractJson('I am not sure what you want.')).toBeUndefined();
  });

  it('returns undefined for malformed JSON rather than throwing', () => {
    expect(extractJson('{"a":1,}')).toBeUndefined();
  });
});

describe('coerceBrief', () => {
  it('passes a well-formed brief through', () => {
    const b = coerceBrief({
      lookPackId: 'swiss_editorial',
      energy: 0.8,
      tone: 'loud',
      totalDurationMs: 9000,
      beats: [{ purpose: 'open', weight: 2, content: { headline: 'Hi' } }],
    }, 'prompt');
    expect(b.lookPackId).toBe('swiss_editorial');
    expect(b.energy).toBe(0.8);
    expect(b.beats).toHaveLength(1);
  });

  it('replaces an unknown pack id rather than failing', () => {
    expect(coerceBrief({ lookPackId: 'nope' }, 'p').lookPackId).toBe('apple_keynote');
  });

  it('clamps energy into range', () => {
    expect(coerceBrief({ energy: 7 }, 'p').energy).toBe(1);
    expect(coerceBrief({ energy: -3 }, 'p').energy).toBe(0);
    expect(coerceBrief({ energy: 'loud' }, 'p').energy).toBe(0.5);
  });

  it('survives a completely empty response', () => {
    // The alternative is a blank composition and an apology. A worse piece than
    // the model should have planned is a much better outcome.
    const b = coerceBrief(undefined, 'a bold product teaser');
    expect(b.beats.length).toBeGreaterThan(0);
    expect(b.beats[0]!.content.headline).toContain('bold product teaser');
    expect(b.totalDurationMs).toBeGreaterThan(0);
  });

  it('caps a runaway duration', () => {
    expect(coerceBrief({ totalDurationMs: 999_999_999 }, 'p').totalDurationMs).toBe(120_000);
  });

  it('defaults a missing beat weight rather than producing NaN timings', () => {
    const b = coerceBrief({ beats: [{ purpose: 'x', content: {} }] }, 'p');
    expect(b.beats[0]!.weight).toBe(1);
  });

  it('only carries accent and mode when they are actually present', () => {
    const bare = coerceBrief({ lookPackId: 'luxury_film' }, 'p');
    expect('accent' in bare).toBe(false);
    expect('mode' in bare).toBe(false);
    const full = coerceBrief({ lookPackId: 'luxury_film', accent: '#c8a862', mode: 'light' }, 'p');
    expect(full.accent).toBe('#c8a862');
    expect(full.mode).toBe('light');
  });
});

describe('coercePicks', () => {
  it('reads the wrapped form', () => {
    expect(coercePicks({ picks: [{ beatIndex: 1, id: 'x', seed: 4 }] }))
      .toEqual([{ beatIndex: 1, id: 'x', seed: 4 }]);
  });

  it('reads a bare array too — models return both', () => {
    expect(coercePicks([{ beatIndex: 0, id: 'y' }])).toEqual([{ beatIndex: 0, id: 'y' }]);
  });

  it('drops entries with no id instead of emitting a nameless cast', () => {
    expect(coercePicks({ picks: [{ beatIndex: 0 }, { beatIndex: 1, id: 'ok' }] }))
      .toEqual([{ beatIndex: 1, id: 'ok' }]);
  });

  it('defaults a missing beatIndex to 0', () => {
    expect(coercePicks({ picks: [{ id: 'x' }] })).toEqual([{ beatIndex: 0, id: 'x' }]);
  });

  it('returns an empty list for nonsense, so the validator supplies every pick', () => {
    expect(coercePicks(undefined)).toEqual([]);
    expect(coercePicks('no')).toEqual([]);
    expect(coercePicks({ picks: 'no' })).toEqual([]);
  });

  it('omits seed and params rather than passing undefined through', () => {
    const [p] = coercePicks({ picks: [{ id: 'x' }] });
    expect('seed' in p!).toBe(false);
    expect('params' in p!).toBe(false);
  });
});
