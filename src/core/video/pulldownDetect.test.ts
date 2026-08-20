/**
 * Pulldown detection on synthetic material built from first principles: film
 * frames woven into the 2-3 field cadence must detect; progressive, true
 * interlace, stills and cut-riddled footage must not. The weave here is the
 * same A/A, B/B, B/C, C/D, D/D cycle the module's header derives.
 */

import { detectPulldown, splitFields, type FieldPair } from './pulldownDetect';

const W = 32;
const H = 24;

/** A "film frame": a smooth pattern displaced by `phase` — every frame
 *  distinct, plenty of texture, no randomness. */
function filmLuma(phase: number): Float32Array {
  const d = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      d[y * W + x] = 128 + 100 * Math.sin((x + phase * 3) * 0.4) * Math.cos((y + phase * 2) * 0.3);
    }
  }
  return d;
}

const fieldsOf = (luma: Float32Array): FieldPair => splitFields(luma, W, H, 1);

/** Weave film frames into telecined video fields: one 5-frame cycle per 4
 *  film frames — A/A, B/B, B/C, C/D, D/D. */
function telecine(filmFrames: Float32Array[]): FieldPair[] {
  const out: FieldPair[] = [];
  for (let c = 0; c + 3 < filmFrames.length; c += 4) {
    const [a, b, cc, d] = [filmFrames[c]!, filmFrames[c + 1]!, filmFrames[c + 2]!, filmFrames[c + 3]!];
    const F = (topSrc: Float32Array, botSrc: Float32Array): FieldPair => ({
      top: fieldsOf(topSrc).top,
      bottom: fieldsOf(botSrc).bottom,
    });
    out.push(F(a, a), F(b, b), F(b, cc), F(cc, d), F(d, d));
  }
  return out;
}

const film = (n: number): Float32Array[] => Array.from({ length: n }, (_, i) => filmLuma(i));

describe('detectPulldown', () => {
  it('detects clean 2-3 telecine with high confidence', () => {
    const report = detectPulldown(telecine(film(24))); // 6 cycles, 30 frames
    expect(report.telecine).toBe(true);
    expect(report.confidence).toBeGreaterThan(0.8);
  });

  it('progressive video (every frame distinct) does not detect', () => {
    const frames = film(30).map(fieldsOf);
    const report = detectPulldown(frames);
    expect(report.telecine).toBe(false);
  });

  it('true interlace (fields from DIFFERENT times, no repeats) does not detect', () => {
    // Each video frame weaves two temporally adjacent but distinct moments.
    const moments = film(60);
    const frames: FieldPair[] = [];
    for (let i = 0; i + 1 < moments.length; i += 2) {
      frames.push({ top: fieldsOf(moments[i]!).top, bottom: fieldsOf(moments[i + 1]!).bottom });
    }
    expect(detectPulldown(frames).telecine).toBe(false);
  });

  it('a still shot has no cadence to find', () => {
    const frames = Array.from({ length: 30 }, () => fieldsOf(filmLuma(0)));
    expect(detectPulldown(frames).telecine).toBe(false);
  });

  it('too short a window refuses rather than guessing', () => {
    expect(detectPulldown(telecine(film(4)).slice(0, 5)).telecine).toBe(false);
  });

  it('is deterministic', () => {
    const frames = telecine(film(24));
    expect(detectPulldown(frames)).toEqual(detectPulldown(frames));
  });
});

describe('splitFields', () => {
  it('deals rows to fields by parity, with horizontal decimation', () => {
    // 4×4: rows 0..3 hold values 0,1,2,3.
    const luma = new Float32Array(16);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) luma[y * 4 + x] = y;
    const f = splitFields(luma, 4, 4, 2);
    expect(Array.from(f.top)).toEqual([0, 0, 2, 2]);
    expect(Array.from(f.bottom)).toEqual([1, 1, 3, 3]);
  });
});
