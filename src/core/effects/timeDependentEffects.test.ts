/**
 * Time-dependent effects: the clock reaches them, and it costs what it should.
 *
 * Two things are worth protecting here and they pull in opposite directions.
 *
 * The clock must ACTUALLY reach the effect — the previous shape had Timecode
 * taking a hand-keyframed value precisely because it could not.
 *
 * And membership in `TIME_DEPENDENT` must stay expensive-by-design and rare.
 * Every type in that set opts its layers out of raster caching by construction:
 * the resolved time lands in the effect's params, the params are digested by the
 * content hash, so the hash differs every frame. Correct for a timecode burn-in.
 * Ruinous for anything whose pixels are usually static.
 */

import {
  resolveEffectParams,
  isTimeDependentEffect,
  isTemporalEffect,
  timeParamFor,
  paramsOf,
  EFFECT_DEFS,
  type Effect,
} from './effects';

const noSample = (): number | undefined => undefined;

const timecode = (over: Record<string, unknown> = {}): Effect => ({
  id: 'tc1',
  type: 'timecode',
  params: { followCompTime: true, time: 0, fps: 24, ...over } as never,
});

describe('the TIME_DEPENDENT set', () => {
  it('contains timecode', () => {
    expect(isTimeDependentEffect('timecode')).toBe(true);
    expect(timeParamFor('timecode')).toBe('time');
  });

  it('is NOT the same thing as the temporal set', () => {
    // Echo changes WHEN the layer is sampled; Timecode draws something that
    // differs frame to frame at a fixed sample. Conflating them would route
    // each through the other's machinery, where both do nothing.
    expect(isTemporalEffect('echo')).toBe(true);
    expect(isTimeDependentEffect('echo')).toBe(false);
    expect(isTimeDependentEffect('timecode')).toBe(true);
    expect(isTemporalEffect('timecode')).toBe(false);
  });

  it('stays SMALL — membership opts a layer out of raster caching', () => {
    // Not a style preference. A type in this set re-bakes every frame by
    // construction, so this test is a deliberate speed bump: if you are adding
    // one, you are accepting that cost for every layer that uses it.
    const members = EFFECT_DEFS.filter((d) => isTimeDependentEffect(d.type)).map((d) => d.type);
    expect(members).toEqual(['timecode']);
  });

  it('names a real param on a real effect for every member', () => {
    // A typo'd param name would resolve the clock into a key nothing reads —
    // the control would look wired and do nothing.
    for (const def of EFFECT_DEFS) {
      const key = timeParamFor(def.type);
      if (key === undefined) continue;
      expect(def.params.map((p) => p.key)).toContain(key);
    }
  });
});

describe('resolveEffectParams — the clock', () => {
  it('writes the layer time into the effect when following', () => {
    const [out] = resolveEffectParams([timecode()], noSample, 12.5);
    expect(paramsOf(out!).time).toBe(12.5);
  });

  it('leaves the stored value alone when the follow is OFF', () => {
    const [out] = resolveEffectParams([timecode({ followCompTime: false, time: 3 })], noSample, 99);
    expect(paramsOf(out!).time).toBe(3);
  });

  it('does nothing when no clock is supplied', () => {
    // The many callers with no time — tests, the effect clipboard, presets —
    // must be unaffected rather than silently receiving 0.
    const [out] = resolveEffectParams([timecode({ time: 7 })], noSample);
    expect(paramsOf(out!).time).toBe(7);
  });

  it('lets an explicit KEYFRAME beat the clock', () => {
    // Resolution order: clock first, keyframe second. Someone who keyframed the
    // readout overrode the follow on purpose, and the sampled value must win.
    const sample = (path: string): number | undefined =>
      path === 'effect.tc1.time' ? 42 : undefined;
    const [out] = resolveEffectParams([timecode()], sample, 12.5);
    expect(paramsOf(out!).time).toBe(42);
  });

  it('does not touch effects that are not time-dependent', () => {
    const blur: Effect = { id: 'b1', type: 'blur', params: { amount: 5 } };
    const [out] = resolveEffectParams([blur], noSample, 88);
    expect(paramsOf(out!)).toEqual({ amount: 5 });
  });

  it('resolves each effect in a stack independently', () => {
    const stack = [
      { id: 'b1', type: 'blur', params: { amount: 5 } } as Effect,
      timecode(),
    ];
    const out = resolveEffectParams(stack, noSample, 4.25);
    expect(paramsOf(out[0]!).amount).toBe(5);
    expect(paramsOf(out[1]!).time).toBe(4.25);
  });
});

describe('the caching consequence, stated as a test', () => {
  it('produces DIFFERENT params at different times — so the content hash differs', () => {
    // This is the mechanism, asserted rather than described. The content hash
    // digests the effect stack; because the clock lands in the params, a
    // Timecode layer re-bakes each frame without the hash needing to know that
    // time exists.
    const a = paramsOf(resolveEffectParams([timecode()], noSample, 1)[0]!);
    const b = paramsOf(resolveEffectParams([timecode()], noSample, 2)[0]!);
    expect(a.time).not.toBe(b.time);
  });

  it('produces IDENTICAL params at the same time — so scrubbing back is a cache hit', () => {
    const a = paramsOf(resolveEffectParams([timecode()], noSample, 3.5)[0]!);
    const b = paramsOf(resolveEffectParams([timecode()], noSample, 3.5)[0]!);
    expect(a).toEqual(b);
  });

  it('leaves a non-time-dependent stack byte-identical across times', () => {
    // The other half, and the one that matters for everything else in the app:
    // an ordinary layer must not start busting its cache because this feature
    // exists.
    const blur: Effect = { id: 'b1', type: 'blur', params: { amount: 5 } };
    const a = resolveEffectParams([blur], noSample, 1);
    const b = resolveEffectParams([blur], noSample, 900);
    expect(a).toEqual(b);
  });
});
