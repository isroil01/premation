/**
 * Keyframable audio levels, in the EXPORT path.
 *
 * The doc claimed keyframable levels for years and it was never true for either
 * layer kind: `gain.gain.value` was assigned once per voice and no track was
 * ever sampled. This pins the half that actually matters and is easiest to get
 * wrong — the offline mixdown. A level curve that sounds right while scrubbing
 * and renders flat is only discoverable by exporting and listening to the whole
 * file, which is why preview and export share one curve builder and why the
 * export side is asserted here rather than assumed from the preview side.
 */

const layers: Array<Record<string, unknown>> = [];
const buffers = new Map<string, { duration: number }>();
/** Every (time, gain) point scheduled on each voice's gain param, in order. */
const scheduled: Array<Array<[number, number]>> = [];
const tracks: Record<string, Array<{ t: number; value: number }>> = {};

jest.mock('./audioScene', () => ({ readAudioLayers: () => layers }));
jest.mock('./AudioEngine', () => ({
  audioEngine: { load: jest.fn(async () => null), decodedBuffer: (id: string) => buffers.get(id) },
}));
// A linear-interpolating stand-in for the animation engine, so the ramp builder
// is exercised against a real curve rather than a constant.
jest.mock('@motion/animation', () => ({
  defaultAnimation: {
    tracksFor: (nodeId: string) =>
      tracks[nodeId] ? [{ prop: 'audioLevelDb', keyframes: tracks[nodeId] }] : [],
    sample: (nodeId: string, prop: string, t: number) => {
      const kf = tracks[nodeId];
      if (!kf || prop !== 'audioLevelDb' || kf.length === 0) return undefined;
      if (t <= kf[0]!.t) return kf[0]!.value;
      if (t >= kf[kf.length - 1]!.t) return kf[kf.length - 1]!.value;
      for (let i = 1; i < kf.length; i++) {
        const a = kf[i - 1]!;
        const b = kf[i]!;
        if (t <= b.t) return a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t);
      }
      return undefined;
    },
  },
}));

import { mixdownAudio } from './audioMixdown';
import { dbToGain, MIN_LEVEL_DB } from './audioParams';

class FakeOfflineContext {
  destination = {};
  constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {}
  createBufferSource() {
    return { buffer: null as unknown, connect: (d: unknown) => d, start() {} };
  }
  createGain() {
    const points: Array<[number, number]> = [];
    scheduled.push(points);
    return {
      gain: {
        value: 1,
        setValueAtTime: (v: number, t: number) => points.push([t, v]),
        linearRampToValueAtTime: (v: number, t: number) => points.push([t, v]),
        cancelScheduledValues: () => {},
      },
      connect: (d: unknown) => d,
    };
  }
  async startRendering() {
    return {
      numberOfChannels: 2, length: this.length, sampleRate: this.sampleRate,
      duration: this.length / this.sampleRate,
      getChannelData: () => new Float32Array(this.length),
    };
  }
}

function voice(over: Record<string, unknown> = {}) {
  return {
    nodeId: 'v', assetId: 'clip', src: 'blob:x', levelDb: 0,
    startSec: 0, inSec: 0, outSec: 10, muted: false, source: 'video', ...over,
  };
}

/** Gain scheduled at time `t` on the first voice, by linear interpolation
 *  between the surrounding scheduled points — what the audio thread renders. */
function gainAt(points: Array<[number, number]>, t: number): number {
  if (points.length === 0) return NaN;
  if (t <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [ta, ga] = points[i - 1]!;
    const [tb, gb] = points[i]!;
    if (t <= tb) return ga + ((gb - ga) * (t - ta)) / (tb - ta);
  }
  return points[points.length - 1]![1];
}

beforeEach(() => {
  layers.length = 0;
  buffers.clear();
  scheduled.length = 0;
  for (const k of Object.keys(tracks)) delete tracks[k];
  (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = FakeOfflineContext;
});
afterEach(() => {
  delete (globalThis as unknown as { OfflineAudioContext?: unknown }).OfflineAudioContext;
});

describe('export follows the level curve, not just its first value', () => {
  it('ducks over a keyframed range', async () => {
    // 0 dB → -20 dB across 4 seconds, the classic duck under a voiceover.
    tracks.v = [
      { t: 0, value: 0 },
      { t: 4, value: -20 },
    ];
    layers.push(voice({ levelAnimated: true }));
    buffers.set('clip', { duration: 10 });

    await mixdownAudio(0, 10);
    const points = scheduled[0]!;

    // More than one point: a flat schedule is exactly the bug being guarded.
    expect(points.length).toBeGreaterThan(10);
    expect(gainAt(points, 0)).toBeCloseTo(dbToGain(0), 3);
    expect(gainAt(points, 2)).toBeCloseTo(dbToGain(-10), 2);
    expect(gainAt(points, 4)).toBeCloseTo(dbToGain(-20), 3);
    // Monotonically falling through the duck.
    expect(gainAt(points, 3)).toBeLessThan(gainAt(points, 1));
  });

  it('rises from silence — a level of 0 at the start must not drop the layer', async () => {
    tracks.v = [
      { t: 0, value: MIN_LEVEL_DB },
      { t: 2, value: 0 },
    ];
    layers.push(voice({ levelAnimated: true, levelDb: MIN_LEVEL_DB }));
    buffers.set('clip', { duration: 10 });

    expect(await mixdownAudio(0, 10)).not.toBeNull();
    const points = scheduled[0]!;
    expect(gainAt(points, 0)).toBe(0);
    expect(gainAt(points, 2)).toBeCloseTo(1, 3);
  });

  it('picks the curve up mid-fade when the export range starts late', async () => {
    // Export [2,10] of a fade that runs 0→4s. At export t=0 (comp t=2) the
    // level must already be halfway down, not back at the start of the fade.
    tracks.v = [
      { t: 0, value: 0 },
      { t: 4, value: -20 },
    ];
    layers.push(voice({ levelAnimated: true }));
    buffers.set('clip', { duration: 10 });

    await mixdownAudio(2, 10);
    const points = scheduled[0]!;
    expect(gainAt(points, 0)).toBeCloseTo(dbToGain(-10), 2);
  });

  it('an unanimated level schedules exactly one point', async () => {
    layers.push(voice({ levelDb: -6 }));
    buffers.set('clip', { duration: 10 });

    await mixdownAudio(0, 10);
    expect(scheduled[0]).toHaveLength(1);
    expect(scheduled[0]![0]![1]).toBeCloseTo(dbToGain(-6), 4);
  });

  it('a muted layer contributes no voice at all', async () => {
    layers.push(voice({ muted: true }));
    buffers.set('clip', { duration: 10 });
    expect(await mixdownAudio(0, 10)).toBeNull();
    expect(scheduled).toHaveLength(0);
  });
});

describe('mixing several sources', () => {
  it('music + VO + two video clips each get their own scheduled gain', async () => {
    layers.push(
      voice({ nodeId: 'music', assetId: 'music', levelDb: -12, source: 'audio' }),
      voice({ nodeId: 'vo', assetId: 'vo', levelDb: 0, source: 'audio' }),
      voice({ nodeId: 'clipA', assetId: 'clipA', levelDb: -3, source: 'video' }),
      voice({ nodeId: 'clipB', assetId: 'clipB', levelDb: -6, source: 'video' }),
    );
    for (const id of ['music', 'vo', 'clipA', 'clipB']) buffers.set(id, { duration: 10 });

    expect(await mixdownAudio(0, 10)).not.toBeNull();
    expect(scheduled).toHaveLength(4);
    // Per-source gains, in scheduling order — no shared bus scaling, and no
    // voice quietly inheriting another's level.
    expect(scheduled.map((p) => Number(p[0]![1].toFixed(4)))).toEqual(
      [-12, 0, -3, -6].map((db) => Number(dbToGain(db).toFixed(4))),
    );
  });

  it('N voices behave like N-1 plus one more — no per-voice rescaling', async () => {
    layers.push(voice({ nodeId: 'a', assetId: 'a', levelDb: -6, source: 'audio' }));
    buffers.set('a', { duration: 10 });
    await mixdownAudio(0, 10);
    const soloGain = scheduled[0]![0]![1];

    scheduled.length = 0;
    layers.push(voice({ nodeId: 'b', assetId: 'b', levelDb: -6, source: 'video' }));
    buffers.set('b', { duration: 10 });
    await mixdownAudio(0, 10);

    // Adding a source must not change what the first one renders at. If a
    // headroom or normalisation stage is ever added, this is what catches it
    // silently re-gaining every existing project.
    expect(scheduled[0]![0]![1]).toBeCloseTo(soloGain, 6);
    expect(scheduled[1]![0]![1]).toBeCloseTo(soloGain, 6);
  });
});
