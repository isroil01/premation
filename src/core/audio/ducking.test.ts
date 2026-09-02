/**
 * Ducking — the pure half.
 *
 * `duckLevels` is a per-frame envelope in and a per-frame gain out, with no
 * scene and no Web Audio, so the ballistics can be asserted exactly rather than
 * listened for. The linear ramps are what make "exactly" possible: a one-pole
 * would only ever approach `duckDb`, and every assertion below would have to be
 * a tolerance nobody could justify.
 */

import { duckLevels, thinLevels, envToDb, dbToEnv, DEFAULT_DUCKING } from './ducking';

const FPS = 30;

/** An envelope that sits at `db` dBFS for `frames` frames. */
function at(db: number, frames: number): number[] {
  return Array.from({ length: frames }, () => dbToEnv(db));
}

const LOUD = -6;
const SILENT = -60;

describe('envToDb / dbToEnv', () => {
  it('are the analyser’s own scale: 0 ⇒ −60 dBFS, 1 ⇒ 0 dBFS', () => {
    expect(envToDb(0)).toBe(-60);
    expect(envToDb(1)).toBe(0);
    expect(envToDb(0.5)).toBe(-30);
  });

  it('round-trip, and clamp outside the scale', () => {
    expect(dbToEnv(envToDb(0.42))).toBeCloseTo(0.42, 9);
    expect(dbToEnv(6)).toBe(1);
    expect(dbToEnv(-200)).toBe(0);
    expect(envToDb(2)).toBe(0);
    expect(envToDb(-1)).toBe(-60);
  });
});

describe('duckLevels', () => {
  const params = { fps: FPS, duckDb: -12, thresholdDb: -30, attackMs: 100, releaseMs: 200, holdMs: 0 };

  it('holds at 0 dB while the sidechain is below threshold', () => {
    const gain = duckLevels(at(SILENT, 30), params);
    expect(Array.from(gain).every((g) => g === 0)).toBe(true);
  });

  it('reaches exactly duckDb while the sidechain is above threshold', () => {
    // 100 ms attack at 30 fps = 3 frames; 30 frames is far past it.
    const gain = duckLevels(at(LOUD, 30), params);
    expect(gain[0]).toBeLessThan(0);
    expect(gain[3]).toBeCloseTo(-12, 9);
    expect(gain[29]).toBeCloseTo(-12, 9);
  });

  it('takes the whole attack and no longer to get there', () => {
    // 200 ms at 30 fps = 6 frames of 2 dB each. The first frame of the envelope
    // already takes a step, so the duck is complete at index 5.
    const gain = duckLevels(at(LOUD, 10), { ...params, attackMs: 200 });
    expect(gain[0]).toBeCloseTo(-2, 9);
    expect(gain[2]).toBeCloseTo(-6, 9);
    expect(gain[4]).toBeCloseTo(-10, 9);
    expect(gain[5]).toBeCloseTo(-12, 9);
    expect(gain[6]).toBeCloseTo(-12, 9);
  });

  it('recovers to exactly 0 after the release, once the voice stops', () => {
    // 10 frames of voice, then silence. Release 200 ms = 6 frames.
    const gain = duckLevels([...at(LOUD, 10), ...at(SILENT, 20)], params);
    expect(gain[9]).toBeCloseTo(-12, 9);
    expect(gain[10]).toBeCloseTo(-10, 9); // release has started
    expect(gain[15]).toBeCloseTo(0, 9);
    expect(gain[19]).toBe(0);
  });

  it('hold keeps the duck down through a gap between words', () => {
    // Voice, a 4-frame pause, voice again. Hold of 200 ms = 6 frames covers it.
    const env = [...at(LOUD, 10), ...at(SILENT, 4), ...at(LOUD, 10)];
    const held = duckLevels(env, { ...params, holdMs: 200 });
    const unheld = duckLevels(env, { ...params, holdMs: 0 });

    expect(held[13]).toBeCloseTo(-12, 9); // never let go
    expect(unheld[13]).toBeGreaterThan(-12); // started releasing into the pause
  });

  it('hold expires, and then the release runs normally', () => {
    const gain = duckLevels([...at(LOUD, 10), ...at(SILENT, 30)], { ...params, holdMs: 200 });
    expect(gain[15]).toBeCloseTo(-12, 9); // still inside the 6-frame hold
    expect(gain[17]).toBeGreaterThan(-12); // hold over, release under way
    expect(gain[25]).toBeCloseTo(0, 9);
  });

  it('threshold decides what counts as the voice being present', () => {
    const env = at(-35, 20);
    expect(duckLevels(env, { ...params, thresholdDb: -30 })[10]).toBe(0);
    expect(duckLevels(env, { ...params, thresholdDb: -40 })[10]).toBeCloseTo(-12, 9);
  });

  it('a positive duckDb is treated as no duck rather than a boost', () => {
    const gain = duckLevels(at(LOUD, 20), { ...params, duckDb: 6 });
    expect(Array.from(gain).every((g) => g === 0)).toBe(true);
  });

  it('one value per frame, never above 0 or below duckDb', () => {
    const env = [...at(LOUD, 7), ...at(SILENT, 3), ...at(LOUD, 5), ...at(SILENT, 15)];
    const gain = duckLevels(env, params);
    expect(gain.length).toBe(env.length);
    for (const g of gain) {
      expect(g).toBeLessThanOrEqual(0);
      expect(g).toBeGreaterThanOrEqual(-12);
    }
  });

  it('is empty for an empty envelope, and uses 30 fps when none is given', () => {
    expect(duckLevels(new Float32Array(0), params).length).toBe(0);
    expect(duckLevels(at(LOUD, 30), { duckDb: -12, thresholdDb: -30, attackMs: 100, releaseMs: 200, holdMs: 0 })[3])
      .toBeCloseTo(-12, 9);
  });

  it('ships the defaults it documents', () => {
    expect(DEFAULT_DUCKING).toEqual({
      duckDb: -12,
      thresholdDb: -30,
      attackMs: 60,
      releaseMs: 400,
      holdMs: 200,
    });
  });
});

describe('thinLevels', () => {
  it('keeps only the ends of a flat run', () => {
    expect(thinLevels(new Float32Array([0, 0, 0, 0, 0]))).toEqual([0, 4]);
  });

  it('keeps only the ends of a straight ramp', () => {
    expect(thinLevels(new Float32Array([0, -3, -6, -9, -12]))).toEqual([0, 4]);
  });

  it('keeps the corner where the slope changes', () => {
    const kept = thinLevels(new Float32Array([0, -6, -12, -12, -12, -12]));
    expect(kept[0]).toBe(0);
    expect(kept).toContain(2);
    expect(kept[kept.length - 1]).toBe(5);
  });

  it('collapses a real duck to a handful of points', () => {
    const gain = duckLevels(
      [...at(SILENT, 30), ...at(LOUD, 60), ...at(SILENT, 90)],
      { fps: FPS, duckDb: -12, thresholdDb: -30, attackMs: 100, releaseMs: 200, holdMs: 0 },
    );
    const kept = thinLevels(gain);
    expect(kept.length).toBeLessThan(10);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(gain.length - 1);
  });

  it('handles the degenerate lengths', () => {
    expect(thinLevels(new Float32Array(0))).toEqual([]);
    expect(thinLevels(new Float32Array([1]))).toEqual([0]);
    expect(thinLevels(new Float32Array([1, 2]))).toEqual([0, 1]);
  });
});
