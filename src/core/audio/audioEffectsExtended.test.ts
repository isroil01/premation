/**
 * The six audio effects that arrived after the first four.
 *
 * ## What makes these different from the biquad family
 *
 * The original four are pure filters: one node in, one node out, nothing to
 * schedule and nothing to allocate. These six each break that shape in a way
 * that has its own silent failure:
 *
 *   Reverb        — a CONVOLVER, which replaces the signal if wired in series
 *                   instead of parallel, and whose impulse must be identical in
 *                   preview and export or every render sounds different.
 *   Flange/Chorus — an LFO reaching an `AudioParam`. Reach a node INPUT instead
 *                   and you get an audible hum at the modulation rate.
 *   Tone          — a GENERATOR, so it is summed in. Put it in series and the
 *                   layer's own audio disappears.
 *   Modulator     — an LFO on a gain. Getting the base/depth split wrong turns
 *                   a modulation into a boost, or into silence at depth 0.
 *   Stereo Mixer  — channel routing. Two gains give per-channel LEVEL; only
 *                   four give panning.
 *   Backwards     — not a node at all, and the offset must be mirrored with the
 *                   buffer or a trimmed clip plays the wrong span, in time.
 *
 * So these tests assert TOPOLOGY, not parameter values. Every one of the
 * failures above produces nodes with perfectly correct numbers on them.
 */

import {
  fakeAudioContext, fakeSource, paramValue, FAKE_SAMPLE_RATE, type FakeNode,
} from '@/__testHelpers__/fakeAudioContext';
import { defaultAnimation } from '@motion/animation';
import { readSource } from '@/__testHelpers__/readSource';
import {
  audioEffectPropPath,
  connectAudioEffects,
  clearImpulseCacheForTests,
  hasBackwards,
  reverseBuffer,
  backwardsOffset,
  readAudioEffects,
  AUDIO_EFFECT_DEFS,
  WAVE_EFFECTS,
  type AudioEffect,
} from './audioEffects';

const fx = (
  type: AudioEffect['type'],
  params: Record<string, number> = {},
  over: Partial<AudioEffect> = {},
): AudioEffect => ({ id: `${type}-1`, type, params, ...over });

/** The buffer a convolver was handed, in the shape the assertions need. */
const irOf = (created: FakeNode[]): { getChannelData(c: number): Float32Array } =>
  created.find((n) => n.kind === 'convolver')!.buffer as { getChannelData(c: number): Float32Array };

describe('reverb', () => {
  beforeEach(() => clearImpulseCacheForTests());

  it('runs dry and wet in PARALLEL, so the layer is not replaced by its tail', () => {
    const { ctx, created } = fakeAudioContext();
    const input = fakeSource();
    connectAudioEffects(ctx, input as unknown as AudioNode, [fx('reverb', { mix: 30 })]);
    const conv = created.find((n) => n.kind === 'convolver')!;
    expect(conv).toBeTruthy();
    // The input fans out to a dry gain AND the convolver.
    expect(input.out).toHaveLength(2);
    expect(input.out).toContain(conv);
  });

  it('disables normalize, so Decay Time does not double as a level control', () => {
    // With normalisation on, a longer tail comes back quieter — sweeping Decay
    // would change loudness as a side effect.
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('reverb', {})]);
    expect(created.find((n) => n.kind === 'convolver')!.normalize).toBe(false);
  });

  it('generates a DETERMINISTIC impulse — two builds give identical samples', () => {
    // The whole reason the noise is a seeded hash rather than Math.random. A
    // tail that differed per render would make every export of one project
    // sound slightly different, with nothing in the UI able to explain it.
    const read = (): number[] => {
      clearImpulseCacheForTests();
      const { ctx, created } = fakeAudioContext();
      connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('reverb', { decay: 0.05 })]);
      return Array.from(irOf(created).getChannelData(0).slice(0, 64));
    };
    expect(read()).toEqual(read());
  });

  it('decorrelates the two channels, so the tail is not dead centre', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('reverb', { decay: 0.05, preDelay: 0 })]);
    const ir = irOf(created);
    expect(Array.from(ir.getChannelData(0).slice(0, 32)))
      .not.toEqual(Array.from(ir.getChannelData(1).slice(0, 32)));
  });

  it('leaves silence in front of the decay for pre-delay', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('reverb', { decay: 0.05, preDelay: 10 })]);
    const ch = irOf(created).getChannelData(0);
    const preSamples = Math.round((10 / 1000) * FAKE_SAMPLE_RATE);
    expect(Array.from(ch.slice(0, preSamples)).every((v) => v === 0)).toBe(true);
    // ...and it is silence BEFORE something, not silence all the way down.
    expect(Array.from(ch.slice(preSamples)).some((v) => v !== 0)).toBe(true);
  });

  it('decays rather than holding level — a tail, not a gate', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('reverb', { decay: 0.1, preDelay: 0 })]);
    const ch = irOf(created).getChannelData(0);
    const energy = (from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += ch[i]! * ch[i]!;
      return sum;
    };
    const q = Math.floor(ch.length / 4);
    expect(energy(0, q)).toBeGreaterThan(energy(3 * q, 4 * q) * 10);
  });
});

describe('flange and chorus', () => {
  it('modulates the delay TIME rather than summing the LFO into the audio', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [
      fx('flange-chorus', { separation: 4, depth: 100, rate: 2 }),
    ]);
    const lfo = created.find((n) => n.kind === 'osc')!;
    const delay = created.find((n) => n.kind === 'delay')!;
    expect(paramValue(lfo, 'frequency')).toBeCloseTo(2, 10);
    // The LFO reaches an AudioParam, not a node input. Wired into the signal it
    // would be an audible hum at the modulation rate.
    const depthGain = lfo.out[0] as FakeNode;
    expect(depthGain.out).toContain(delay.delayTime);
  });

  it('never lets the sweep reach zero delay', () => {
    // A delay line crossing zero clicks, and at exactly zero the feedback loop
    // becomes a direct connection — instant runaway rather than resonance.
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [
      fx('flange-chorus', { separation: 4, depth: 100 }),
    ]);
    const delay = created.find((n) => n.kind === 'delay')!;
    const lfo = created.find((n) => n.kind === 'osc')!;
    expect(paramValue(lfo.out[0] as FakeNode, 'gain')).toBeLessThan(paramValue(delay, 'delayTime'));
  });

  it('hands the LFO back as a source for the caller to schedule', () => {
    const { ctx } = fakeAudioContext();
    const chain = connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('flange-chorus', {})]);
    expect(chain.sources).toHaveLength(1);
  });

  it('allows NEGATIVE feedback, which is half of what a flanger does', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('flange-chorus', { feedback: -60 })]);
    const gains = created.filter((n) => n.kind === 'gain').map((n) => paramValue(n, 'gain'));
    expect(gains.some((g) => g < 0)).toBe(true);
  });
});

describe('tone', () => {
  it('SUMS a generator in rather than filtering what arrives', () => {
    const { ctx, created } = fakeAudioContext();
    const input = fakeSource();
    const chain = connectAudioEffects(ctx, input as unknown as AudioNode, [
      fx('tone', { frequency: 440, level: -6 }),
    ]);
    const osc = created.find((n) => n.kind === 'osc')!;
    expect(paramValue(osc, 'frequency')).toBeCloseTo(440, 10);
    // The input still reaches the output — a generator must not replace the
    // layer's own audio — and the oscillator joins it at the same node.
    expect(input.out).toContain(chain.node);
    expect((osc.out[0] as FakeNode).out).toContain(chain.node);
  });

  it('converts its Level from dB, so -6 dB is about half amplitude', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('tone', { level: -6 })]);
    const osc = created.find((n) => n.kind === 'osc')!;
    expect(paramValue(osc.out[0] as FakeNode, 'gain')).toBeCloseTo(0.501, 3);
  });

  it('is scheduled by the caller, not started inside the builder', () => {
    const { ctx } = fakeAudioContext();
    const chain = connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('tone', {})]);
    expect(chain.sources).toHaveLength(1);
  });
});

describe('modulator', () => {
  /** The gain the LFO drives, as opposed to the gain that scales the LFO. */
  const vcaOf = (created: FakeNode[]): { vca: FakeNode; depthGain: FakeNode } => {
    const lfo = created.find((n) => n.kind === 'osc')!;
    const depthGain = lfo.out[0] as FakeNode;
    const vca = created.find((n) => n.kind === 'gain' && n !== depthGain)!;
    return { vca, depthGain };
  };

  it('drives a GAIN with the LFO — amplitude modulation, not a mixed-in tone', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('modulator', { rate: 40, depth: 60 })]);
    const lfo = created.find((n) => n.kind === 'osc')!;
    expect(paramValue(lfo, 'frequency')).toBeCloseTo(40, 10);
    const { vca, depthGain } = vcaOf(created);
    // Into an AudioParam (`vca.gain`), which is what makes it modulation.
    expect(depthGain.out).toContain(vca.gain);
  });

  it('keeps the peak at unity — depth modulates, it does not boost', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('modulator', { depth: 60 })]);
    const { vca, depthGain } = vcaOf(created);
    expect(paramValue(vca, 'gain') + paramValue(depthGain, 'gain')).toBeCloseTo(1, 10);
  });

  it('at depth 0 is inaudible rather than silent', () => {
    // The two are easy to swap and only one is right: a depth-0 modulator must
    // pass the signal, not mute it.
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('modulator', { depth: 0 })]);
    expect(paramValue(vcaOf(created).vca, 'gain')).toBeCloseTo(1, 10);
  });
});

describe('stereo mixer', () => {
  it('routes each input channel to BOTH outputs — which is what panning is', () => {
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('stereo-mixer', {})]);
    const split = created.find((n) => n.kind === 'splitter')!;
    const merge = created.find((n) => n.kind === 'merger')!;
    // Four legs: L→L, L→R, R→L, R→R. Two would only be per-channel level.
    expect(split.wires).toHaveLength(4);
    const toMerger = created
      .filter((n) => n.kind === 'gain')
      .flatMap((n) => n.wires)
      .filter((w) => w.to === merge);
    expect(toMerger).toHaveLength(4);
    expect(toMerger.filter((w) => w.toCh === 0)).toHaveLength(2);
    expect(toMerger.filter((w) => w.toCh === 1)).toHaveLength(2);
  });

  it('takes each leg from the RIGHT input channel', () => {
    // Both left legs read channel 0 and both right legs channel 1. Reading one
    // channel twice would silently drop the other side of the mix.
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('stereo-mixer', {})]);
    const split = created.find((n) => n.kind === 'splitter')!;
    expect(split.wires.filter((w) => w.fromCh === 0)).toHaveLength(2);
    expect(split.wires.filter((w) => w.fromCh === 1)).toHaveLength(2);
  });

  it('pans with EQUAL POWER, so a sweep does not dip in the middle', () => {
    const { ctx, created } = fakeAudioContext();
    // Left channel dead centre, right muted: the two surviving legs are its
    // own, and each must be 1/√2. A linear pan would put 0.5 in each and lose
    // 3 dB in the middle of every sweep.
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [
      fx('stereo-mixer', { leftPan: 0, rightPan: 0, leftLevel: 100, rightLevel: 0 }),
    ]);
    const nonZero = created
      .filter((n) => n.kind === 'gain')
      .map((n) => paramValue(n, 'gain'))
      .filter((g) => g > 0.0001);
    expect(nonZero).toHaveLength(2);
    for (const g of nonZero) expect(g).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('defaults to the identity image — hard left stays left', () => {
    // The default must be a no-op, or adding the effect would move the mix
    // before the user touched a control.
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('stereo-mixer', {})]);
    const gains = created.filter((n) => n.kind === 'gain').map((n) => paramValue(n, 'gain'));
    expect(gains.filter((g) => Math.abs(g - 1) < 1e-9)).toHaveLength(2);
    expect(gains.filter((g) => g < 1e-9)).toHaveLength(2);
  });
});

describe('backwards', () => {
  it('builds NO nodes — it is a buffer transform, not a filter', () => {
    const { ctx, created } = fakeAudioContext();
    const input = fakeSource();
    const chain = connectAudioEffects(ctx, input as unknown as AudioNode, [fx('backwards', {})]);
    expect(chain.node).toBe(input);
    expect(created).toHaveLength(0);
    expect(chain.sources).toHaveLength(0);
  });

  it('is detected regardless of its position in the stack', () => {
    // Order-independent by nature: it happens before any node exists, so a
    // reader must not conclude from stack order that it applies late.
    expect(hasBackwards([fx('backwards', {}), fx('delay', {})])).toBe(true);
    expect(hasBackwards([fx('delay', {}), fx('backwards', {})])).toBe(true);
    expect(hasBackwards([fx('backwards', {}, { enabled: false })])).toBe(false);
    expect(hasBackwards([fx('delay', {})])).toBe(false);
  });

  it('reverses every channel, and caches so a scrub does not redo it', () => {
    const { ctx } = fakeAudioContext();
    const buffer = ctx.createBuffer(2, 4, FAKE_SAMPLE_RATE);
    buffer.getChannelData(0).set([1, 2, 3, 4]);
    buffer.getChannelData(1).set([5, 6, 7, 8]);
    const out = reverseBuffer(ctx, buffer);
    expect(Array.from(out.getChannelData(0))).toEqual([4, 3, 2, 1]);
    expect(Array.from(out.getChannelData(1))).toEqual([8, 7, 6, 5]);
    // Same input gives the same object back: `startVoice` runs on every seek,
    // and reversing a decoded file per frame would stall a scrub.
    expect(reverseBuffer(ctx, buffer)).toBe(out);
  });

  it('MIRRORS the read offset, so a trimmed clip plays its own span', () => {
    // The half that is silent when wrong. Seconds 2–4 of a ten-second file,
    // played backwards, live at 6–8 s of the reversed buffer. Get this wrong
    // and audio plays, in time, from entirely the wrong part of the file.
    expect(backwardsOffset(10, 2, 2)).toBeCloseTo(6, 10);
    // A whole-file clip starts at the beginning either way.
    expect(backwardsOffset(10, 0, 10)).toBeCloseTo(0, 10);
    // The tail of the file is the head of the reverse.
    expect(backwardsOffset(10, 8, 2)).toBeCloseTo(0, 10);
    // Never negative, however the window was clamped upstream.
    expect(backwardsOffset(10, 9, 5)).toBe(0);
  });
});

/**
 * Keyframed effect parameters.
 *
 * The reason effect params were kept NUMERIC from the start is that they are
 * the same shape as level and can ride the same scheduler. These assert that
 * they actually do — and, just as importantly, that an unanimated project still
 * gets a single assignment rather than a 50 Hz ramp it does not need.
 */
describe('parameter automation', () => {
  const NODE = 'layer-1';
  const auto = { nodeId: NODE, startCompSec: 0, durationSec: 1, whenCtx: 0 };

  beforeEach(() => defaultAnimation.clear());

  /** Every value scheduled onto a param, in order. */
  const scheduleOf = (param: FakeNode): number[] =>
    (param.scheduled as number[] | undefined) ?? [];

  it('a keyframed parameter becomes a CURVE, not a value frozen at the start', () => {
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('delay-1', 'mix'), 0, 0);
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('delay-1', 'mix'), 1, 100);
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('delay', {})], auto);
    // The wet gain rises across the voice. More than two points means it was
    // sampled along the way rather than merely set at each end.
    const wet = created.filter((n) => n.kind === 'gain')
      .map((n) => scheduleOf(n.gain as unknown as FakeNode))
      .find((s) => s.length > 2 && s[s.length - 1]! > s[0]!);
    expect(wet).toBeTruthy();
    expect(wet![0]).toBeCloseTo(0, 6);
    expect(wet![wet!.length - 1]).toBeCloseTo(1, 6);
  });

  it('moves the dry side the OPPOSITE way, so the layer does not get louder', () => {
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('delay-1', 'mix'), 0, 0);
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('delay-1', 'mix'), 1, 100);
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('delay', {})], auto);
    const curves = created.filter((n) => n.kind === 'gain')
      .map((n) => scheduleOf(n.gain as unknown as FakeNode))
      .filter((s) => s.length > 2);
    // One rises 0→1 and one falls 1→0: Dry/Wet is one control read two ways.
    expect(curves.some((s) => s[0]! < s[s.length - 1]!)).toBe(true);
    expect(curves.some((s) => s[0]! > s[s.length - 1]!)).toBe(true);
  });

  it('leaves an UNANIMATED parameter as a single assignment', () => {
    // The cheap path has to stay cheap: a 50 Hz ramp on a static control would
    // be dozens of scheduled points per voice, per parameter, per seek.
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('delay', { mix: 40 })], auto);
    for (const n of created.filter((g) => g.kind === 'gain')) {
      expect(scheduleOf(n.gain as unknown as FakeNode)).toHaveLength(0);
    }
  });

  it('assigns rather than schedules when no window is given at all', () => {
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('delay-1', 'mix'), 0, 0);
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('delay-1', 'mix'), 1, 100);
    const { ctx, created } = fakeAudioContext();
    // No automation argument: the caller has no window, so there is nothing to
    // schedule against and the static value is the honest answer.
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('delay', {})]);
    for (const n of created.filter((g) => g.kind === 'gain')) {
      expect(scheduleOf(n.gain as unknown as FakeNode)).toHaveLength(0);
    }
  });

  it('holds a clamp across the WHOLE curve, not just at its ends', () => {
    // A Q sweep through zero throws in the audio thread rather than sounding
    // wrong, so the clamp lives inside the derivation and applies at every
    // sampled point. Keyframes that dip below the floor prove it.
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('parametric-eq-1', 'q'), 0, 1);
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('parametric-eq-1', 'q'), 0.5, -5);
    defaultAnimation.setKeyframe(NODE, audioEffectPropPath('parametric-eq-1', 'q'), 1, 1);
    const { ctx, created } = fakeAudioContext();
    connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('parametric-eq', {})], auto);
    const q = scheduleOf(created.find((n) => n.kind === 'biquad')!.Q as unknown as FakeNode);
    expect(q.length).toBeGreaterThan(2);
    for (const v of q) expect(v).toBeGreaterThan(0);
  });

  it('animates a parameter on each of the newer effects too', () => {
    // The failure this catches is an effect whose params were never routed
    // through `bind` — it would build, sound right, and ignore its keyframes.
    const cases: Array<[AudioEffect['type'], string]> = [
      ['reverb', 'mix'],
      ['flange-chorus', 'rate'],
      ['tone', 'frequency'],
      ['modulator', 'depth'],
      ['stereo-mixer', 'leftPan'],
    ];
    for (const [type, key] of cases) {
      defaultAnimation.clear();
      const id = `${type}-1`;
      defaultAnimation.setKeyframe(NODE, audioEffectPropPath(id, key), 0, 10);
      defaultAnimation.setKeyframe(NODE, audioEffectPropPath(id, key), 1, 90);
      const { ctx, created } = fakeAudioContext();
      connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx(type, {})], auto);
      const anyCurve = created.some((n) => ['gain', 'osc', 'biquad', 'delay'].includes(n.kind)
        && Object.values(n).some((v) => Array.isArray((v as { scheduled?: number[] })?.scheduled)
          && (v as { scheduled: number[] }).scheduled.length > 2));
      expect(`${type}.${key}: ${anyCurve}`).toBe(`${type}.${key}: true`);
    }
  });
});

describe('every effect is declared as well as built', () => {
  const ALL: AudioEffect['type'][] = [
    'parametric-eq', 'bass-treble', 'high-low-pass', 'delay',
    'reverb', 'flange-chorus', 'tone', 'modulator', 'stereo-mixer', 'backwards',
  ];

  it('has a definition for every type the union allows', () => {
    // A type with no entry in AUDIO_EFFECT_DEFS cannot be added from the UI and
    // has no parameter labels — it would exist only to someone editing JSON.
    for (const t of ALL) expect(AUDIO_EFFECT_DEFS[t]).toBeTruthy();
    expect(Object.keys(AUDIO_EFFECT_DEFS).sort()).toEqual([...ALL].sort());
  });

  it('every declared param has a default INSIDE its own range', () => {
    // A default outside the range is a control that jumps the moment it is
    // touched, and a slider that cannot return to where it started.
    for (const d of Object.values(AUDIO_EFFECT_DEFS)) {
      for (const p of d.params) {
        expect(p.min).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
    }
  });

  /**
   * `wave` has three separate ways to be a dead control, and each has a
   * precedent in this repo:
   *
   *  1. no UI writes it            → a field only a JSON editor can reach
   *  2. `readAudioEffects` drops it → set it, save, reload, it is gone
   *  3. the graph builder ignores it → it persists and changes no sound
   *
   * All three look identical from the inspector: a control that appears to
   * work. So all three are asserted.
   */
  describe('the waveform control is not a dead one', () => {
    it('is offered by the UI for exactly the effects that read it', () => {
      const ui = readSource('layout/Inspector/AudioEffectsSection.tsx');
      // Gated on the shared set, not a list repeated in the component — two
      // lists are how one of them ends up offering a setting nothing consumes.
      expect(ui).toMatch(/WAVE_EFFECTS\.has\(e\.type\)/);
      expect(ui).toMatch(/wave: ev\.currentTarget\.value/);
      expect(WAVE_EFFECTS.has('tone')).toBe(true);
      expect(WAVE_EFFECTS.has('flange-chorus')).toBe(true);
      expect(WAVE_EFFECTS.has('modulator')).toBe(true);
      expect(WAVE_EFFECTS.has('delay')).toBe(false);
    });

    it('survives a round trip through the document reader', () => {
      const stored = {
        components: [{
          type: 'fx',
          props: { audioEffects: [{ id: 't1', type: 'tone', params: {}, wave: 'square' }] },
        }],
      };
      expect(readAudioEffects(stored)![0]!.wave).toBe('square');
    });

    it('drops a waveform the audio thread would throw on', () => {
      // `osc.type = 'kazoo'` throws, which surfaces as the voice failing to
      // start — a silent layer rather than a rejected document.
      const stored = {
        components: [{
          type: 'fx',
          props: { audioEffects: [{ id: 't1', type: 'tone', params: {}, wave: 'kazoo' }] },
        }],
      };
      expect(readAudioEffects(stored)![0]!.wave).toBeUndefined();
    });

    it('actually reaches the oscillator, for every effect that offers it', () => {
      for (const t of WAVE_EFFECTS) {
        const { ctx, created } = fakeAudioContext();
        connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [
          fx(t, {}, { wave: 'square' }),
        ]);
        const osc = created.find((n) => n.kind === 'osc');
        expect(osc).toBeTruthy();
        expect(osc!.type).toBe('square');
      }
    });

    it('defaults to a sine when the document does not say', () => {
      const { ctx, created } = fakeAudioContext();
      connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx('tone', {})]);
      expect(created.find((n) => n.kind === 'osc')!.type).toBe('sine');
    });
  });

  it('builds SOMETHING for every filtering effect', () => {
    // Backwards is the one legitimate no-op here. Any other type that produced
    // no nodes would be an effect you can add, and see, and that does nothing —
    // the exact shape of the dead controls this repo keeps finding.
    for (const t of ALL) {
      const { ctx, created } = fakeAudioContext();
      connectAudioEffects(ctx, fakeSource() as unknown as AudioNode, [fx(t, {})]);
      if (t === 'backwards') expect(created).toHaveLength(0);
      else expect(created.length).toBeGreaterThan(0);
    }
  });
});
