/**
 * `contributes.audioEffects` — a plugin that processes sound.
 *
 * The declaration is a CHAIN of WebAudio primitives rather than AE's sample
 * callback, and every rule below follows from the one guarantee that made that
 * choice: `audioEffects.ts` has exactly one function that turns effects into
 * nodes, and both live playback and offline mixdown call it. A validator that
 * let through a chain the builder cannot build would break the parity that
 * rule exists to protect — and the symptom is a mix that sounds right while
 * scrubbing and renders differently, which you only discover by exporting and
 * listening.
 *
 * So the refusals here are all of one kind: a declaration that would BUILD but
 * do nothing. A setting on a node that has no such setting. A parameter
 * reference that resolves to no parameter. An empty chain. Each of those
 * silently produces a control the user can move that reaches nothing.
 */

import {
  AUDIO_EFFECTS_SINCE,
  MAX_AUDIO_CHAIN_NODES,
  MAX_AUDIO_EFFECTS_PER_PLUGIN,
  MAX_AUDIO_PARAMS_PER_EFFECT,
  MAX_DELAY_SECONDS,
  MAX_WAVESHAPER_CURVE,
  parseAudioEffects,
} from './audioEffectSchema';

const CUTOFF = { key: 'cutoff', label: 'Cutoff', unit: 'Hz', min: 20, max: 20000, default: 1000 };

const effect = (over: Record<string, unknown> = {}) => ({
  id: 'sweep',
  label: 'Sweep',
  params: [CUTOFF],
  chain: [{ kind: 'biquad', type: 'lowpass', set: { frequency: { param: 'cutoff' } } }],
  ...over,
});

const parse = (entries: unknown, apiVersion = AUDIO_EFFECTS_SINCE) => {
  const errors: string[] = [];
  const out = parseAudioEffects(entries, errors, apiVersion);
  return { out, errors };
};

describe('a declared effect', () => {
  it('accepts a plain one and keeps its chain', () => {
    const { out, errors } = parse([effect()]);
    expect(errors).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]!.chain).toEqual([
      { kind: 'biquad', type: 'lowpass', set: { frequency: { param: 'cutoff' } } },
    ]);
  });

  it('keeps an optional category and drops an empty one', () => {
    expect(parse([effect({ category: 'Filters' })]).out[0]!.category).toBe('Filters');
    expect(parse([effect({ category: '   ' })]).out[0]!.category).toBeUndefined();
  });

  it('refuses a duplicate id', () => {
    expect(parse([effect(), effect()]).errors.join()).toMatch(/duplicates an earlier audio effect/);
  });

  it('refuses more than the cap', () => {
    const many = Array.from({ length: MAX_AUDIO_EFFECTS_PER_PLUGIN + 1 }, (_, i) => effect({ id: `a${i}` }));
    expect(parse(many).errors.join()).toMatch(new RegExp(`the limit is ${MAX_AUDIO_EFFECTS_PER_PLUGIN}`));
  });

  it('needs the grammar it was added in', () => {
    expect(parse([effect()], AUDIO_EFFECTS_SINCE - 1).errors.join())
      .toMatch(new RegExp(`"apiVersion": ${AUDIO_EFFECTS_SINCE}`));
  });

  it('accepts an EMPTY block at any version', () => {
    // Refusing one would break a package that spelled out a block it does not
    // use; only a non-empty block is using the feature.
    expect(parse([], AUDIO_EFFECTS_SINCE - 1).errors).toEqual([]);
  });
});

describe('parameters', () => {
  it('refuses a default outside its own range', () => {
    // A control that jumps the first time it is touched reads as the plugin
    // losing the user's value.
    const { errors } = parse([effect({ params: [{ ...CUTOFF, default: 30000 }] })]);
    expect(errors.join()).toMatch(/is outside its own 20–20000 range/);
  });

  it('refuses min at or above max', () => {
    expect(parse([effect({ params: [{ ...CUTOFF, min: 100, max: 100 }] })]).errors.join())
      .toMatch(/"min" must be below "max"/);
  });

  it('refuses a key that is not camelCase', () => {
    expect(parse([effect({ params: [{ ...CUTOFF, key: 'Cut-Off' }] })]).errors.join())
      .toMatch(/must be camelCase/);
  });

  it('refuses a duplicate key', () => {
    expect(parse([effect({ params: [CUTOFF, CUTOFF] })]).errors.join())
      .toMatch(/declares "cutoff" twice/);
  });

  it('refuses more than the cap', () => {
    const many = Array.from({ length: MAX_AUDIO_PARAMS_PER_EFFECT + 1 }, (_, i) => ({ ...CUTOFF, key: `p${i}` }));
    expect(parse([effect({ params: many })]).errors.join())
      .toMatch(new RegExp(`the limit is ${MAX_AUDIO_PARAMS_PER_EFFECT}`));
  });

  it('allows an effect with no parameters at all', () => {
    // A fixed shelf or a hard-coded shaper is a real effect; it just has no
    // controls.
    const { out, errors } = parse([effect({
      params: [],
      chain: [{ kind: 'gain', set: { gain: 0.5 } }],
    })]);
    expect(errors).toEqual([]);
    expect(out[0]!.params).toEqual([]);
  });
});

describe('the chain', () => {
  it('refuses an empty one', () => {
    // A chain of nothing cannot change the sound; it is always a mistake
    // rather than a deliberate pass-through.
    expect(parse([effect({ chain: [] })]).errors.join()).toMatch(/non-empty array of nodes/);
  });

  it('refuses more nodes than the cap', () => {
    const many = Array.from({ length: MAX_AUDIO_CHAIN_NODES + 1 }, () => ({ kind: 'gain' }));
    expect(parse([effect({ chain: many })]).errors.join())
      .toMatch(new RegExp(`the limit is ${MAX_AUDIO_CHAIN_NODES}`));
  });

  it('refuses a node kind that is not a primitive the builder has', () => {
    expect(parse([effect({ chain: [{ kind: 'convolver' }] })]).errors.join())
      .toMatch(/must be one of: biquad, gain, delay, panner, compressor, waveshaper/);
  });

  it('accepts every kind it lists', () => {
    const { errors } = parse([effect({
      params: [],
      chain: [
        { kind: 'biquad', type: 'highshelf' },
        { kind: 'gain' },
        { kind: 'delay', set: { delayTime: 0.25 } },
        { kind: 'panner' },
        { kind: 'compressor' },
        { kind: 'waveshaper', curve: [-1, 0, 1] },
      ],
    })]);
    expect(errors).toEqual([]);
  });
});

describe('settings, and the ones that would silently do nothing', () => {
  it('refuses a setting the node kind does not have', () => {
    // `{ kind: 'gain', set: { frequency: 800 } }` would typecheck, build, and
    // do nothing at all — which is the failure this whole check is for.
    const { errors } = parse([effect({
      params: [], chain: [{ kind: 'gain', set: { frequency: 800 } }],
    })]);
    expect(errors.join()).toMatch(/not a setting of a "gain" node \(it has: gain\)/);
  });

  it('says a waveshaper has NO settings rather than listing an empty set', () => {
    const { errors } = parse([effect({
      params: [], chain: [{ kind: 'waveshaper', curve: [-1, 1], set: { gain: 2 } }],
    })]);
    expect(errors.join()).toMatch(/it has none/);
  });

  it('refuses a param reference that names no parameter', () => {
    // A slider the user can move that reaches no node.
    const { errors } = parse([effect({
      chain: [{ kind: 'biquad', type: 'lowpass', set: { frequency: { param: 'nope' } } }],
    })]);
    expect(errors.join()).toMatch(/refers to "nope", which this effect does not declare/);
  });

  it('accepts a fixed number as well as a reference', () => {
    const { out, errors } = parse([effect({
      chain: [{ kind: 'biquad', type: 'peaking', set: { frequency: 440, Q: { param: 'cutoff' } } }],
    })]);
    expect(errors).toEqual([]);
    expect(out[0]!.chain[0]!.set).toEqual({ frequency: 440, Q: { param: 'cutoff' } });
  });

  it('refuses a delay longer than the host will reserve', () => {
    // `DelayNode` takes its ceiling at construction and cannot grow past it.
    const { errors } = parse([effect({
      params: [], chain: [{ kind: 'delay', set: { delayTime: MAX_DELAY_SECONDS + 1 } }],
    })]);
    expect(errors.join()).toMatch(new RegExp(`between 0 and ${MAX_DELAY_SECONDS} seconds`));
  });
});

describe('the fields that belong to exactly one kind', () => {
  it('requires a biquad to say which filter it is', () => {
    expect(parse([effect({ chain: [{ kind: 'biquad' }] })]).errors.join())
      .toMatch(/must be one of: lowpass, highpass/);
  });

  it('refuses a type on a node that is not a biquad', () => {
    expect(parse([effect({ params: [], chain: [{ kind: 'gain', type: 'lowpass' }] })]).errors.join())
      .toMatch(/only meaningful on a "biquad" node/);
  });

  it('requires a waveshaper to carry a curve, and refuses one elsewhere', () => {
    expect(parse([effect({ params: [], chain: [{ kind: 'waveshaper' }] })]).errors.join())
      .toMatch(/at least two numbers/);
    expect(parse([effect({ params: [], chain: [{ kind: 'gain', curve: [-1, 1] }] })]).errors.join())
      .toMatch(/only meaningful on a "waveshaper" node/);
  });

  it('refuses a curve longer than the cap', () => {
    const curve = Array.from({ length: MAX_WAVESHAPER_CURVE + 1 }, (_, i) => i / MAX_WAVESHAPER_CURVE);
    expect(parse([effect({ params: [], chain: [{ kind: 'waveshaper', curve }] })]).errors.join())
      .toMatch(new RegExp(`the limit is ${MAX_WAVESHAPER_CURVE}`));
  });

  it('refuses a curve with a value that is not finite', () => {
    expect(parse([effect({ params: [], chain: [{ kind: 'waveshaper', curve: [0, null] }] })]).errors.join())
      .toMatch(/only finite numbers/);
  });
});

describe('reporting', () => {
  it('pushes messages rather than throwing, so an author sees them all at once', () => {
    const errors: string[] = [];
    expect(() => parseAudioEffects([{ id: 'BAD ID' }, 42], errors, AUDIO_EFFECTS_SINCE)).not.toThrow();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty list for an absent block', () => {
    expect(parse(undefined).out).toEqual([]);
  });
});
