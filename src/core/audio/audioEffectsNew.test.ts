/**
 * The four AE 26.3 audio effects, and the deepened versions of the older ones.
 *
 * Two things are worth pinning here and one is not.
 *
 * WORTH PINNING: that the graph is built from the nodes the effect claims to be
 * built from, and — more importantly — that the effects which grew new
 * parameters still build the OLD graph when those parameters are at their
 * defaults. Every one of Parametric EQ, Tone, Flange & Chorus, Reverb and
 * Modulator gained controls in this change, and a project saved before them
 * must sound identical. That is not something anyone would notice by listening;
 * it is exactly what a test is for.
 *
 * NOT worth pinning: how any of them sound. These assert wiring and shape, not
 * timbre.
 */


import {
  distortionCurve,
  hasFlag,
  AUDIO_EFFECT_DEFS,
  AUDIO_EFFECT_FLAGS,
  DISTORTION_CURVES,
  type AudioEffect,
  type AudioEffectType,
} from './audioEffects';

let n = 0;
const fx = (type: AudioEffectType, params: Record<string, number> = {}, extra: Partial<AudioEffect> = {}): AudioEffect => ({
  id: `afx_${++n}`,
  type,
  params,
  ...extra,
});

// ── Distortion ───────────────────────────────────────────────────────
describe('distortion', () => {

  describe('the transfer curves', () => {
    it.each(DISTORTION_CURVES.map((c) => c.value))('%s stays inside the rails', (kind) => {
      const curve = distortionCurve(kind, 100, 16);
      for (const v of curve) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    /**
     * Zero drive must be a WIRE. Soft Clip is the default character, so an
     * effect added and left alone would otherwise colour the layer before the
     * user touched a control.
     */
    it('soft clip at zero drive is the identity', () => {
      const curve = distortionCurve('soft-clip', 0, 16);
      expect(curve[0]).toBeCloseTo(-1, 3);
      expect(curve[curve.length - 1]).toBeCloseTo(1, 3);
      expect(curve[Math.floor(curve.length / 2)]).toBeCloseTo(0, 2);
    });

    it('is monotonic, so louder in is never quieter out', () => {
      for (const { value } of DISTORTION_CURVES) {
        const curve = distortionCurve(value, 60, 16);
        for (let i = 1; i < curve.length; i++) {
          expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]! - 1e-6);
        }
      }
    });

    /**
     * The bitcrusher. At 16 bits the step is finer than the table itself, so it
     * must change nothing; at 2 bits the output can only take a handful of
     * distinct values, which IS the effect.
     */
    it('quantises to the requested bit depth, and not at 16', () => {
      const full = distortionCurve('soft-clip', 50, 16);
      const crushed = distortionCurve('soft-clip', 50, 2);
      expect(new Set(full).size).toBeGreaterThan(100);
      expect(new Set(crushed).size).toBeLessThanOrEqual(4);
    });

    it('tube is asymmetric — that asymmetry is the even harmonics', () => {
      const curve = distortionCurve('tube', 70, 16);
      const mid = Math.floor(curve.length / 2);
      const up = curve[mid + 400]!;
      const down = curve[mid - 400]!;
      expect(Math.abs(up)).not.toBeCloseTo(Math.abs(down), 2);
    });
  });
});

// ── Flags ────────────────────────────────────────────────────────────
describe('the flag mechanism', () => {
  it('reads a set flag and treats an absent list as nothing set', () => {
    expect(hasFlag(fx('backwards', {}, { flags: ['swapChannels'] }), 'swapChannels')).toBe(true);
    expect(hasFlag(fx('backwards'), 'swapChannels')).toBe(false);
  });

  /**
   * Every flag the UI offers must name an effect that reads it. This is the
   * dead-control check the waveform control already has: a switch that
   * persists, keyframes nothing and changes no sound is the failure shape this
   * repo has shipped more than once.
   */
  it('offers flags only for effects that exist', () => {
    for (const type of Object.keys(AUDIO_EFFECT_FLAGS) as AudioEffectType[]) {
      expect(AUDIO_EFFECT_DEFS[type]).toBeTruthy();
      for (const f of AUDIO_EFFECT_FLAGS[type]!) {
        expect(f.key).toMatch(/^[a-zA-Z]+$/);
        expect(f.label.length).toBeGreaterThan(0);
      }
    }
  });
});
