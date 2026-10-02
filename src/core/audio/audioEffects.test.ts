/**
 * Audio effects — the preview graph.
 *
 * The page's export mixdown (`audioMixdown`) is gone — the C++ engine renders
 * the exported audio — so the guard that kept the preview and export paths
 * building through one function went with it. What is left is ordinary unit
 * testing of the chain the preview builds.
 *
 * The thing pinned hardest is that an empty chain returns the input node
 * untouched. Existing projects must produce the identical audio graph they did
 * before this file existed; "no effects" has to mean no nodes, not a
 * pass-through gain that quietly changes nothing except the graph shape.
 */

import { readSource } from '@/__testHelpers__/readSource';
import {
  fakeAudioContext, fakeSource, paramValue, type FakeNode,
} from '@/__testHelpers__/fakeAudioContext';
import {
  connectAudioEffects,
  hasActiveAudioEffects,
  audioEffectPropPath,
  readAudioEffects,
  AUDIO_EFFECT_DEFS,
  type AudioEffect,
} from './audioEffects';

/*
 * The recording fake lives in `__testHelpers__` because a second test file
 * needed it. See that file for why the topology — not the parameter values —
 * is the thing worth asserting about an audio graph.
 */
const fakeCtx = fakeAudioContext;
const val = paramValue;
const src = fakeSource;

const fx = (type: AudioEffect['type'], params: Record<string, number> = {}, over: Partial<AudioEffect> = {}): AudioEffect =>
  ({ id: `${type}-1`, type, params, ...over });

describe('an empty chain changes nothing', () => {
  it.each([
    ['undefined', undefined],
    ['an empty list', [] as AudioEffect[]],
  ])('%s returns the input node and creates no nodes', (_why, effects) => {
    const { ctx, created } = fakeCtx();
    const input = src();
    expect(connectAudioEffects(ctx, input as unknown as AudioNode, effects).node).toBe(input);
    expect(created).toHaveLength(0);
  });

  it('a disabled effect creates no nodes either', () => {
    const { ctx, created } = fakeCtx();
    const input = src();
    const out = connectAudioEffects(ctx, input as unknown as AudioNode, [fx('parametric-eq', {}, { enabled: false })]).node;
    expect(out).toBe(input);
    expect(created).toHaveLength(0);
  });

  it('hasActiveAudioEffects agrees', () => {
    expect(hasActiveAudioEffects(undefined)).toBe(false);
    expect(hasActiveAudioEffects([])).toBe(false);
    expect(hasActiveAudioEffects([fx('delay', {}, { enabled: false })])).toBe(false);
    expect(hasActiveAudioEffects([fx('delay')])).toBe(true);
  });
});

describe('the biquad family', () => {
  it('parametric EQ is a peaking filter carrying its three params', () => {
    const { ctx, created } = fakeCtx();
    connectAudioEffects(ctx, src() as unknown as AudioNode, [fx('parametric-eq', { frequency: 800, gain: -6, q: 2 })]);
    const f = created[0]!;
    expect(f.kind).toBe('biquad');
    expect(f.type).toBe('peaking');
    expect(val(f, 'frequency')).toBe(800);
    expect(val(f, 'gain')).toBe(-6);
    expect(val(f, 'Q')).toBe(2);
  });

  it('bass & treble is TWO shelves, low then high — one node cannot do both', () => {
    const { ctx, created } = fakeCtx();
    connectAudioEffects(ctx, src() as unknown as AudioNode, [fx('bass-treble', { bass: 5, treble: -3 })]);
    expect(created.map((n) => n.type)).toEqual(['lowshelf', 'highshelf']);
    expect(val(created[0]!, 'gain')).toBe(5);
    expect(val(created[1]!, 'gain')).toBe(-3);
    // Chained, not parallel.
    expect(created[0]!.out).toContain(created[1]);
  });

  it('high-low pass honours the mode, defaulting to highpass', () => {
    for (const [mode, expected] of [['lowpass', 'lowpass'], ['highpass', 'highpass'], [undefined, 'highpass']] as const) {
      const { ctx, created } = fakeCtx();
      connectAudioEffects(ctx, src() as unknown as AudioNode, [fx('high-low-pass', { cutoff: 500 }, { mode: mode as never })]);
      expect(created[0]!.type).toBe(expected);
    }
  });

  it('clamps Q above zero — the spec rejects Q <= 0 and would throw mid-render', () => {
    const { ctx, created } = fakeCtx();
    connectAudioEffects(ctx, src() as unknown as AudioNode, [fx('parametric-eq', { q: 0 })]);
    expect(val(created[0]!, 'Q')).toBeGreaterThan(0);
  });

  it('falls back to the declared default when a param is missing or garbage', () => {
    const { ctx, created } = fakeCtx();
    connectAudioEffects(ctx, src() as unknown as AudioNode, [fx('parametric-eq', { frequency: NaN })]);
    const expected = AUDIO_EFFECT_DEFS['parametric-eq'].params.find((p) => p.key === 'frequency')!.default;
    expect(val(created[0]!, 'frequency')).toBe(expected);
  });
});

describe('delay is parallel, not in series', () => {
  // A DelayNode alone shifts the whole signal later — latency, not an echo.
  it('splits dry and wet into a summing node', () => {
    const { ctx, created } = fakeCtx();
    const input = src();
    const out = connectAudioEffects(ctx, input as unknown as AudioNode, [fx('delay', { time: 0.3, feedback: 40, mix: 25 })]).node;

    const delay = created.find((n) => n.kind === 'delay')!;
    expect(val(delay, 'delayTime')).toBeCloseTo(0.3, 10);

    // The input fans out to BOTH a dry gain and the delay line.
    expect(input.out).toHaveLength(2);
    expect(input.out.some((n) => n.kind === 'delay')).toBe(true);
    expect(input.out.some((n) => n.kind === 'gain')).toBe(true);

    // Dry and wet are complementary, and both reach the returned node.
    const gains = created.filter((n) => n.kind === 'gain');
    const values = gains.map((g) => val(g, 'gain'));
    expect(values).toContain(0.75); // dry = 1 - mix
    expect(values).toContain(0.25); // wet = mix
    expect((out as unknown as FakeNode).kind).toBe('gain');
  });

  it('feeds the delay line back into itself, capped below unity', () => {
    const { ctx, created } = fakeCtx();
    connectAudioEffects(ctx, src() as unknown as AudioNode, [fx('delay', { feedback: 100 })]);
    const delay = created.find((n) => n.kind === 'delay')!;
    const feedback = delay.out.find((n) => n.kind === 'gain')!;
    // The loop exists…
    expect(feedback.out).toContain(delay);
    // …and cannot have unity gain, which would ring forever in an offline
    // render — a file that never decays rather than an effect.
    expect(val(feedback, 'gain')).toBeLessThan(1);
  });

  it('clamps the delay time to the allocated line length', () => {
    const { ctx, created } = fakeCtx();
    connectAudioEffects(ctx, src() as unknown as AudioNode, [fx('delay', { time: 999 })]);
    const delay = created.find((n) => n.kind === 'delay')!;
    expect(val(delay, 'delayTime'))
      .toBeLessThanOrEqual(delay.maxDelay as number);
  });
});

describe('chain semantics', () => {
  it('applies in list order', () => {
    const { ctx, created } = fakeCtx();
    connectAudioEffects(ctx, src() as unknown as AudioNode, [
      fx('high-low-pass', { cutoff: 200 }),
      fx('parametric-eq', { frequency: 900 }),
    ]);
    expect(created[0]!.type).toBe('highpass');
    expect(created[1]!.type).toBe('peaking');
    expect(created[0]!.out).toContain(created[1]);
  });

  it('an unknown type passes the signal through rather than silencing it', () => {
    const { ctx, created } = fakeCtx();
    const input = src();
    const out = connectAudioEffects(ctx, input as unknown as AudioNode, [fx('rotary-klaxon' as never)]).node;
    expect(out).toBe(input);
    expect(created).toHaveLength(0);
  });

  it('scopes keyframes by effect id, so reordering cannot steal automation', () => {
    expect(audioEffectPropPath('abc', 'gain')).toBe('audiofx.abc.gain');
    expect(audioEffectPropPath('abc', 'gain')).not.toBe(audioEffectPropPath('def', 'gain'));
  });
});

describe('the chain is readable, writable and reachable', () => {
  const node = (props: unknown): Parameters<typeof readAudioEffects>[0] =>
    ({ components: [{ type: 'fx', props: { audioEffects: props } }] });

  it('reads a stored chain', () => {
    const out = readAudioEffects(node([{ id: 'a', type: 'delay', params: { time: 0.2 } }]))!;
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('delay');
    expect(out[0]!.params!.time).toBe(0.2);
  });

  it('returns undefined — not [] — when there is nothing, so no nodes are built', () => {
    expect(readAudioEffects(node(undefined))).toBeUndefined();
    expect(readAudioEffects(node([]))).toBeUndefined();
    expect(readAudioEffects({ components: [] })).toBeUndefined();
  });

  it.each([
    ['a missing id', [{ type: 'delay' }]],
    ['an unknown type', [{ id: 'a', type: 'rotary-klaxon' }]],
    ['a non-object entry', ['delay']],
  ])('drops %s rather than trusting the document', (_why, raw) => {
    expect(readAudioEffects(node(raw))).toBeUndefined();
  });

  it('drops non-finite params instead of passing NaN to the audio thread', () => {
    const out = readAudioEffects(node([{ id: 'a', type: 'delay', params: { time: NaN, mix: 50 } }]))!;
    expect(out[0]!.params).toEqual({ mix: 50 });
  });

  it('the inspector section writes the key the reader reads (through the engine: the audio/effects field)', () => {
    const ui = readSource('layout/Inspector/AudioEffectsSection.tsx');
    expect(ui).toMatch(/AUDIO_EFFECTS_PROP/);
    // B3: the whole chain as the `audio/effects` json field, which the engine
    // stores on fx[AUDIO_EFFECTS_PROP] (layerFieldSpecs.ts) — the key readAudioEffects reads.
    expect(ui).toMatch(/type: 'setProperty', prop: \{ layer: nodeId, path: 'audio\/effects' \}/);
    expect(readSource('core/engine/layerFieldSpecs.ts')).toMatch(/path: 'audio\/effects', key: 'audioEffects'/);
  });

  it('and that section is actually MOUNTED — otherwise this is unreachable code', () => {
    const ui = readSource('layout/Inspector/AudioControls.tsx');
    expect(ui).toMatch(/import \{ AudioEffectsSection \}/);
    expect(ui).toMatch(/<AudioEffectsSection nodeId=\{nodeId\} \/>/);
  });

  it('the scene read path attaches the chain to every voice', () => {
    expect(readSource('core/audio/audioScene.ts')).toMatch(/effects: readAudioEffects\(node\)/);
  });
});
