/**
 * The frame index over synthetic sample tables — every edge the fixtures
 * cannot isolate. The B-frame pattern here is the one libx264 actually
 * produced for the fixture (probed, not invented): per 8-frame GOP the decode
 * order presents as I P B B P B B P, i.e. presentation numbers
 * [0, 3, 1, 2, 6, 4, 5, 7], with the whole timeline shifted late by the
 * 2-frame B delay exactly as ffmpeg writes it.
 */

import { buildFrameIndex, frameAtTime, type IndexableSample } from './frameIndex';

const TS = 15360; // 512 units per frame at 30fps
const DUR = 512;

/** The fixture's decode-order presentation pattern, per GOP of 8. */
const GOP_PRESENT = [0, 3, 1, 2, 6, 4, 5, 7];

function bframeTable(gops: number): IndexableSample[] {
  const out: IndexableSample[] = [];
  for (let g = 0; g < gops; g++) {
    for (let k = 0; k < 8; k++) {
      const decodeIdx = g * 8 + k;
      out.push({
        dts: decodeIdx * DUR,
        // +2 frames: the B-delay offset the container really carries.
        cts: (g * 8 + GOP_PRESENT[k]! + 2) * DUR,
        isKey: k === 0,
        duration: DUR,
      });
    }
  }
  return out;
}

function ippTable(n: number, gop: number): IndexableSample[] {
  return Array.from({ length: n }, (_, i) => ({
    dts: i * DUR,
    cts: i * DUR,
    isKey: i % gop === 0,
    duration: DUR,
  }));
}

describe('buildFrameIndex', () => {
  it('returns empty for empty input or broken timescale', () => {
    expect(buildFrameIndex([], TS)).toEqual({ frames: [], durationUs: 0 });
    expect(buildFrameIndex(ippTable(4, 4), 0)).toEqual({ frames: [], durationUs: 0 });
  });

  it('normalizes the B-delay away: frame 0 is at 0µs despite cts starting late', () => {
    const idx = buildFrameIndex(bframeTable(2), TS);
    expect(idx.frames[0]!.timeUs).toBe(0);
    for (let i = 0; i < idx.frames.length; i++) {
      expect(idx.frames[i]!.timeUs).toBe(Math.round((i * 1e6) / 30));
    }
  });

  it('maps presentation to decode indices exactly per the encoded pattern', () => {
    const idx = buildFrameIndex(bframeTable(1), TS);
    // Presentation i is at the decode position where GOP_PRESENT says i.
    const expected = GOP_PRESENT.map((_, pres) => GOP_PRESENT.indexOf(pres));
    expect(idx.frames.map((f) => f.decodeIndex)).toEqual(expected);
  });

  it('feed-through is the running max: a B-frame needs its FUTURE reference', () => {
    const idx = buildFrameIndex(bframeTable(1), TS);
    // pres 0 = dec 0 (the I): feed [0..0]. pres 1 = dec 2, but its reference
    // P sits at dec 1 — feed through 2 covers it. pres 3 = dec 1: the running
    // max stays 3 because pres 2 already needed dec 3.
    expect(idx.frames.map((f) => f.feedThroughDecodeIndex)).toEqual([0, 2, 3, 3, 5, 6, 6, 7]);
    for (const f of idx.frames) expect(f.keyDecodeIndex).toBe(0);
  });

  it('an all-intra stream feeds exactly one sample per frame', () => {
    const idx = buildFrameIndex(ippTable(6, 1), TS);
    for (let i = 0; i < 6; i++) {
      expect(idx.frames[i]!).toMatchObject({
        decodeIndex: i,
        keyDecodeIndex: i,
        feedThroughDecodeIndex: i,
      });
    }
  });

  it('GOP boundaries reset the running max — no feed range crosses a keyframe', () => {
    const idx = buildFrameIndex(bframeTable(3), TS);
    for (const f of idx.frames) {
      expect(f.feedThroughDecodeIndex).toBeGreaterThanOrEqual(f.decodeIndex);
      expect(f.feedThroughDecodeIndex - f.keyDecodeIndex).toBeLessThan(8);
    }
  });

  it('clamps a malformed stream whose first sample is not sync to GOP start 0', () => {
    const table = ippTable(6, 3).map((s, i) => ({ ...s, isKey: i === 3 }));
    const idx = buildFrameIndex(table, TS);
    expect(idx.frames[0]!.keyDecodeIndex).toBe(0);
    expect(idx.frames[5]!.keyDecodeIndex).toBe(3);
  });
});

describe('frameAtTime', () => {
  const idx = buildFrameIndex(ippTable(10, 5), TS);

  it('is the last frame starting at or before t, clamped to the clip', () => {
    expect(frameAtTime(idx, -50)).toBe(0);
    expect(frameAtTime(idx, 0)).toBe(0);
    expect(frameAtTime(idx, 33_333)).toBe(1); // exact frame start
    expect(frameAtTime(idx, 33_332)).toBe(0); // 1µs earlier
    expect(frameAtTime(idx, 5e6)).toBe(9); // far past the end
  });

  it('round-trips every frame at its start and mid-frame', () => {
    for (let i = 0; i < 10; i++) {
      const t = idx.frames[i]!.timeUs;
      expect(frameAtTime(idx, t)).toBe(i);
      expect(frameAtTime(idx, t + 16_000)).toBe(i);
    }
  });
});
