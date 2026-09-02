/**
 * Silence detection and the source→comp mapping — the pure halves.
 *
 * Both run on synthesised samples and plain timing records: no scene, no
 * engine, no Web Audio. That is the point of keeping them pure — the detector
 * is the part a user cannot eyeball (a gap either got cut or it did not), so it
 * is the part that has to be provable from a tone.
 */

import {
  detectSilences,
  totalSilenceSec,
  rangesToCompIntervals,
  mergeIntervals,
  DEFAULT_SILENCE_OPTIONS,
} from './silenceRemoval';

const SR = 8000; // plenty for an RMS detector, and fast

/** `seconds` of a 440 Hz sine at `amp`. */
function tone(seconds: number, amp = 0.8): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
  return out;
}

function quiet(seconds: number, amp = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  if (amp !== 0) for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 60 * i) / SR);
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('detectSilences', () => {
  it('finds the one long gap in tone / silence / tone', () => {
    // 1s tone, 1s silence, 1s tone.
    const ranges = detectSilences(concat(tone(1), quiet(1), tone(1)), SR, { paddingMs: 0 });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startSec).toBeCloseTo(1, 1);
    expect(ranges[0]!.endSec).toBeCloseTo(2, 1);
  });

  it('respects minSilenceMs — a short gap survives, a long one does not', () => {
    // 0.5s tone, 0.2s gap, 0.5s tone, 0.8s gap, 0.5s tone.
    const samples = concat(tone(0.5), quiet(0.2), tone(0.5), quiet(0.8), tone(0.5));
    const strict = detectSilences(samples, SR, { minSilenceMs: 400, paddingMs: 0 });
    expect(strict).toHaveLength(1);
    expect(strict[0]!.startSec).toBeCloseTo(1.2, 1);

    // Lower the bar and the 200 ms gap qualifies too.
    const loose = detectSilences(samples, SR, { minSilenceMs: 100, paddingMs: 0 });
    expect(loose).toHaveLength(2);
  });

  it('padding keeps a margin at each end of the gap', () => {
    const samples = concat(tone(1), quiet(1), tone(1));
    const bare = detectSilences(samples, SR, { paddingMs: 0 });
    const padded = detectSilences(samples, SR, { paddingMs: 100 });

    expect(padded).toHaveLength(1);
    expect(padded[0]!.startSec).toBeCloseTo(bare[0]!.startSec + 0.1, 2);
    expect(padded[0]!.endSec).toBeCloseTo(bare[0]!.endSec - 0.1, 2);
    // …and the padding is real time kept, not a relabelling.
    expect(totalSilenceSec(padded)).toBeCloseTo(totalSilenceSec(bare) - 0.2, 2);
  });

  it('padding is taken off AFTER the minimum is checked', () => {
    // A 500 ms gap with 200 ms padding leaves 100 ms — still removed, because
    // the 500 ms run is what `minSilenceMs` is measured against.
    const samples = concat(tone(0.5), quiet(0.5), tone(0.5));
    const ranges = detectSilences(samples, SR, { minSilenceMs: 400, paddingMs: 200 });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.endSec - ranges[0]!.startSec).toBeCloseTo(0.1, 1);
  });

  it('drops a gap the padding eats entirely', () => {
    const samples = concat(tone(0.5), quiet(0.5), tone(0.5));
    expect(detectSilences(samples, SR, { minSilenceMs: 400, paddingMs: 300 })).toHaveLength(0);
  });

  it('threshold decides what counts as quiet', () => {
    // A -34 dBFS hum in the "gap": below -30, above -40.
    const samples = concat(tone(1), quiet(1, 0.02), tone(1));
    expect(detectSilences(samples, SR, { thresholdDb: -40, paddingMs: 0 })).toHaveLength(0);
    expect(detectSilences(samples, SR, { thresholdDb: -30, paddingMs: 0 })).toHaveLength(1);
  });

  it('catches leading and trailing silence too', () => {
    const ranges = detectSilences(concat(quiet(0.8), tone(0.5), quiet(0.8)), SR, { paddingMs: 0 });
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.startSec).toBeCloseTo(0, 2);
    expect(ranges[1]!.endSec).toBeCloseTo(2.1, 1);
  });

  it('is empty for continuous programme material, and for nothing at all', () => {
    expect(detectSilences(tone(2), SR)).toHaveLength(0);
    expect(detectSilences(new Float32Array(0), SR)).toHaveLength(0);
    expect(detectSilences(tone(1), 0)).toHaveLength(0);
  });

  it('ships the defaults it documents', () => {
    expect(DEFAULT_SILENCE_OPTIONS).toEqual({
      thresholdDb: -40,
      minSilenceMs: 400,
      paddingMs: 80,
      windowMs: 10,
    });
  });
});

describe('rangesToCompIntervals', () => {
  const untrimmed = [{ startSec: 0, inSec: 0, outSec: 10 }];

  it('maps source seconds straight through an untrimmed bar at comp 0', () => {
    expect(rangesToCompIntervals(untrimmed, [{ startSec: 2, endSec: 3 }])).toEqual([
      { start: 2, end: 3 },
    ]);
  });

  it('offsets by where the bar sits and what it is trimmed to', () => {
    // The bar begins at comp 4s and plays from 1s into the file.
    const timings = [{ startSec: 4, inSec: 1, outSec: 6 }];
    expect(rangesToCompIntervals(timings, [{ startSec: 2, endSec: 3 }])).toEqual([
      { start: 5, end: 6 },
    ]);
  });

  it('ignores material trimmed off the bar', () => {
    const timings = [{ startSec: 0, inSec: 5, outSec: 10 }];
    expect(rangesToCompIntervals(timings, [{ startSec: 1, endSec: 2 }])).toEqual([]);
  });

  it('clips a range that overruns the bar', () => {
    const timings = [{ startSec: 0, inSec: 0, outSec: 3 }];
    expect(rangesToCompIntervals(timings, [{ startSec: 2, endSec: 9 }])).toEqual([
      { start: 2, end: 3 },
    ]);
  });

  it('a range spanning a cut becomes two intervals, not one', () => {
    // Split at source 5s, with the right half moved later in the comp.
    const timings = [
      { startSec: 0, inSec: 0, outSec: 5 },
      { startSec: 8, inSec: 5, outSec: 10 },
    ];
    expect(rangesToCompIntervals(timings, [{ startSec: 4, endSec: 6 }])).toEqual([
      { start: 4, end: 5 },
      { start: 8, end: 9 },
    ]);
  });

  it('merges ranges that land on top of each other', () => {
    expect(
      rangesToCompIntervals(untrimmed, [
        { startSec: 1, endSec: 3 },
        { startSec: 2, endSec: 4 },
      ]),
    ).toEqual([{ start: 1, end: 4 }]);
  });
});

describe('mergeIntervals', () => {
  it('sorts, coalesces abutting spans and drops empty ones', () => {
    expect(
      mergeIntervals([
        { start: 5, end: 6 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
        { start: 4, end: 4 },
      ]),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it('does not mutate its input', () => {
    const input = [{ start: 1, end: 2 }, { start: 1.5, end: 3 }];
    mergeIntervals(input);
    expect(input).toEqual([{ start: 1, end: 2 }, { start: 1.5, end: 3 }]);
  });
});
