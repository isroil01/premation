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
  fakeAudioContext,   FAKE_SAMPLE_RATE, 
} from '@/__testHelpers__/fakeAudioContext';
import { readSource } from '@/__testHelpers__/readSource';
import {
  
  
  
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

describe('backwards', () => {

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

describe('every effect is declared as well as built', () => {
  const ALL: AudioEffect['type'][] = [
    'parametric-eq', 'bass-treble', 'high-low-pass', 'delay',
    'reverb', 'flange-chorus', 'tone', 'modulator', 'stereo-mixer', 'backwards',
    // AE 26.3's additions.
    'compressor', 'distortion', 'de-esser',
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
  });
});
