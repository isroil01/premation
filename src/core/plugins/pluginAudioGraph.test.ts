/**
 * A plugin's audio effect, built into a real WebAudio chain.
 *
 * `audioEffectSchema.test.ts` pins the declaration; this pins that the
 * declaration turns into NODES — and that it does so through the caller's
 * `bind`, which is the seam that makes a plugin parameter schedule exactly
 * like a built-in one.
 *
 * The other half of what is pinned here is the degradation. A document can
 * name an audio effect whose plugin is uninstalled, disabled, or a version
 * that no longer declares it. Every one of those has to pass the signal
 * through untouched, because the alternative is a project that falls silent
 * when a plugin is toggled — and silence is the one failure nobody notices
 * until they have exported.
 */

import {
  connectPluginAudioEffect,
  isPluginAudioEffect,
  setPluginAudioEffects,
} from './pluginAudioGraph';
import type { AudioEffectContribution } from './audioEffectSchema';

/** A minimal stand-in for the node types the builder creates. jsdom has no
 *  WebAudio, and what is under test is WHICH nodes get made and how they are
 *  connected — not what the browser does with them afterwards. */
interface FakeParam { value: number }
interface FakeNode {
  kind: string;
  connectedTo: FakeNode[];
  /** The same objects the builder reaches as `node.frequency` — a real
   *  AudioNode exposes its AudioParams as properties, so the fake must too. */
  params: Record<string, FakeParam>;
}

function node(kind: string, names: string[]): FakeNode {
  const params: Record<string, FakeParam> = {};
  const self = { kind, connectedTo: [] as FakeNode[], params } as FakeNode & Record<string, unknown>;
  for (const n of names) {
    const p: FakeParam = { value: 0 };
    params[n] = p;
    self[n] = p;
  }
  self.connect = (n: FakeNode) => { self.connectedTo.push(n); };
  return self as FakeNode;
}

function fakeCtx() {
  const made: FakeNode[] = [];
  const track = (n: FakeNode): FakeNode => { made.push(n); return n; };
  const ctx = {
    createBiquadFilter: () => track(node('biquad', ['frequency', 'Q', 'gain', 'detune'])),
    createGain: () => track(node('gain', ['gain'])),
    createDelay: (max: number) => {
      const n = track(node('delay', ['delayTime'])) as FakeNode & { maxDelay: number };
      n.maxDelay = max;
      return n;
    },
    createStereoPanner: () => track(node('panner', ['pan'])),
    createDynamicsCompressor: () =>
      track(node('compressor', ['threshold', 'knee', 'ratio', 'attack', 'release'])),
    createWaveShaper: () => track(node('waveshaper', [])),
  };
  return { ctx: ctx as unknown as BaseAudioContext, made };
}

const contribution = (over: Partial<AudioEffectContribution> = {}): AudioEffectContribution => ({
  id: 'sweep',
  label: 'Sweep',
  params: [{ key: 'cutoff', label: 'Cutoff', min: 20, max: 20000, default: 800 }],
  chain: [{ kind: 'biquad', type: 'lowpass', set: { frequency: { param: 'cutoff' } } }],
  ...over,
});

/** Record what the caller was asked to schedule. */
function recorder() {
  const bound: Array<{ keys: readonly string[]; value: number }> = [];
  const bind = (target: AudioParam, keys: readonly string[], derive: (r: (k: string) => number) => number): void => {
    const value = derive(() => 1234);
    bound.push({ keys, value });
    (target as unknown as FakeParam).value = value;
  };
  return { bound, bind };
}

const install = (...entries: Array<[string, AudioEffectContribution]>): void => {
  const map = new Map(entries);
  setPluginAudioEffects((type) => map.get(type));
};

afterEach(() => setPluginAudioEffects(() => undefined));

describe('building the chain', () => {
  it('creates the declared node and connects the source into it', () => {
    install(['acme.sweep', contribution()]);
    const { ctx, made } = fakeCtx();
    const source = node('source', []);
    const { bind } = recorder();

    const end = connectPluginAudioEffect(ctx, source as unknown as AudioNode, 'acme.sweep', bind);

    expect(made.map((n) => n.kind)).toEqual(['biquad']);
    expect(source.connectedTo).toEqual([made[0]]);
    expect(end).toBe(made[0]);
  });

  it('chains several nodes in declared order', () => {
    install(['acme.big', contribution({
      params: [],
      chain: [
        { kind: 'biquad', type: 'highpass' },
        { kind: 'delay', set: { delayTime: 0.25 } },
        { kind: 'gain', set: { gain: 0.5 } },
      ],
    })]);
    const { ctx, made } = fakeCtx();
    const source = node('source', []);
    const { bind } = recorder();

    const end = connectPluginAudioEffect(ctx, source as unknown as AudioNode, 'acme.big', bind);

    expect(made.map((n) => n.kind)).toEqual(['biquad', 'delay', 'gain']);
    // source → biquad → delay → gain, and the gain is what the caller carries on from.
    expect(source.connectedTo).toEqual([made[0]]);
    expect(made[0]!.connectedTo).toEqual([made[1]]);
    expect(made[1]!.connectedTo).toEqual([made[2]]);
    expect(end).toBe(made[2]);
  });

  it('sets the biquad type the declaration asked for', () => {
    install(['acme.hp', contribution({ params: [], chain: [{ kind: 'biquad', type: 'notch' }] })]);
    const { ctx, made } = fakeCtx();
    const { bind } = recorder();
    connectPluginAudioEffect(ctx, node('source', []) as unknown as AudioNode, 'acme.hp', bind);
    expect((made[0] as unknown as { type: string }).type).toBe('notch');
  });
});

describe('settings', () => {
  it('assigns a fixed number directly, with no scheduling asked for', () => {
    install(['acme.g', contribution({ params: [], chain: [{ kind: 'gain', set: { gain: 0.25 } }] })]);
    const { ctx, made } = fakeCtx();
    const { bound, bind } = recorder();
    connectPluginAudioEffect(ctx, node('source', []) as unknown as AudioNode, 'acme.g', bind);

    // A constant costs no ramp at all — the same rule the built-in effects
    // follow for an unanimated parameter.
    expect(bound).toEqual([]);
    expect(made[0]!.params.gain!.value).toBe(0.25);
  });

  it('routes a param REFERENCE through the caller\'s bind, naming the key it watches', () => {
    install(['acme.sweep', contribution()]);
    const { ctx } = fakeCtx();
    const { bound, bind } = recorder();
    connectPluginAudioEffect(ctx, node('source', []) as unknown as AudioNode, 'acme.sweep', bind);

    // One binding, watching exactly the param it derives from — so a keyframe
    // on a DIFFERENT parameter does not re-schedule this one.
    expect(bound).toEqual([{ keys: ['cutoff'], value: 1234 }]);
  });

  it('leaves unset settings at the node\'s own sensible default', () => {
    install(['acme.c', contribution({ params: [], chain: [{ kind: 'compressor' }] })]);
    const { ctx, made } = fakeCtx();
    const { bind } = recorder();
    connectPluginAudioEffect(ctx, node('source', []) as unknown as AudioNode, 'acme.c', bind);
    expect(made[0]!.params.ratio!.value).toBe(12);
    expect(made[0]!.params.threshold!.value).toBe(-24);
  });

  it('reserves a delay line long enough for the value it will sweep to', () => {
    // `DelayNode` takes its ceiling at construction and cannot grow: a
    // delayTime driven by a param has to reserve against that param's range,
    // or an animated sweep is silently clamped.
    install(['acme.d', contribution({
      params: [{ key: 'ms', label: 'Time', min: 0, max: 2, default: 2 }],
      chain: [{ kind: 'delay', set: { delayTime: { param: 'ms' } } }],
    })]);
    const { ctx, made } = fakeCtx();
    const { bind } = recorder();
    connectPluginAudioEffect(ctx, node('source', []) as unknown as AudioNode, 'acme.d', bind);
    expect((made[0] as unknown as { maxDelay: number }).maxDelay).toBeGreaterThanOrEqual(2);
  });

  it('gives a waveshaper its curve', () => {
    install(['acme.w', contribution({
      params: [], chain: [{ kind: 'waveshaper', curve: [-1, 0, 1] }],
    })]);
    const { ctx, made } = fakeCtx();
    const { bind } = recorder();
    connectPluginAudioEffect(ctx, node('source', []) as unknown as AudioNode, 'acme.w', bind);
    const w = made[0] as unknown as { curve: Float32Array; oversample: string };
    expect(Array.from(w.curve)).toEqual([-1, 0, 1]);
    // Quality is the host's call, not the plugin's.
    expect(w.oversample).toBe('2x');
  });
});

describe('when the plugin is not there', () => {
  it('passes the signal through for a type nothing provides', () => {
    setPluginAudioEffects(() => undefined);
    const { ctx, made } = fakeCtx();
    const source = node('source', []);
    const { bind } = recorder();

    const end = connectPluginAudioEffect(ctx, source as unknown as AudioNode, 'gone.away', bind);

    // Untouched, and audible. A project must not fall silent because a plugin
    // was disabled — the same promise the builder's `default:` branch made
    // before plugin audio effects existed.
    expect(made).toEqual([]);
    expect(end).toBe(source);
    expect(source.connectedTo).toEqual([]);
  });

  it('answers whether a type is one at all', () => {
    install(['acme.sweep', contribution()]);
    expect(isPluginAudioEffect('acme.sweep')).toBe(true);
    expect(isPluginAudioEffect('acme.gone')).toBe(false);
    // A BUILT-IN type is not a plugin effect and must not be claimed as one.
    expect(isPluginAudioEffect('parametric-eq')).toBe(false);
  });
});
