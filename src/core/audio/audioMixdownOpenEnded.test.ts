/**
 * `outSec: 0` — the "play to the end of the file" sentinel — in the EXPORT path.
 *
 * The live engine has always honoured it (`l.outSec > 0 ? l.outSec : buffer
 * .duration`), but the mixdown computed `outSec - inSec` directly, so a voice
 * carrying the sentinel produced a zero-length clip and was dropped from the
 * export. Preview played it; the exported file was silent. It reaches the
 * mixdown for any voice with no timeline bar and no known duration, which is
 * every video layer imported before its metadata resolved.
 */

const layers: Array<Record<string, unknown>> = [];
const buffers = new Map<string, { duration: number }>();
const started: Array<[number, number, number]> = [];
const scheduledGain: Array<Array<[number, number]>> = [];

jest.mock('./audioScene', () => ({ readAudioLayers: () => layers }));
jest.mock('./AudioEngine', () => ({
  audioEngine: {
    load: jest.fn(async () => null),
    decodedBuffer: (id: string) => buffers.get(id),
  },
}));

import { mixdownAudio } from './audioMixdown';

class FakeOfflineContext {
  destination = {};
  constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {}
  createBufferSource() {
    return {
      buffer: null as unknown,
      connect(dest: unknown) { return dest; },
      start(when: number, offset: number, duration: number) { started.push([when, offset, duration]); },
    };
  }
  createGain() {
    // Gain is scheduled, not assigned — the fake records the curve so tests can
    // assert what the export would actually render.
    const points: Array<[number, number]> = [];
    scheduledGain.push(points);
    return {
      gain: {
        value: 1,
        setValueAtTime(v: number, t: number) { points.push([t, v]); },
        linearRampToValueAtTime(v: number, t: number) { points.push([t, v]); },
        cancelScheduledValues() {},
      },
      connect(dest: unknown) { return dest; },
    };
  }
  async startRendering() {
    return {
      numberOfChannels: 2,
      length: this.length,
      sampleRate: this.sampleRate,
      duration: this.length / this.sampleRate,
      getChannelData: () => new Float32Array(this.length),
    };
  }
}

beforeEach(() => {
  layers.length = 0;
  buffers.clear();
  started.length = 0;
  scheduledGain.length = 0;
  (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = FakeOfflineContext;
});

afterEach(() => {
  delete (globalThis as unknown as { OfflineAudioContext?: unknown }).OfflineAudioContext;
});

function voice(over: Record<string, unknown> = {}) {
  return { nodeId: 'v', assetId: 'clip', src: 'blob:clip.mp4', levelDb: 0, startSec: 0, inSec: 0, outSec: 0, muted: false, ...over };
}

describe('mixdown with an open-ended voice', () => {
  it("exports a bar-less video layer's full audio instead of dropping it", async () => {
    layers.push(voice());
    buffers.set('clip', { duration: 6 });

    expect(await mixdownAudio(0, 10)).not.toBeNull();
    expect(started).toEqual([[0, 0, 6]]); // whole 6s file, at comp t=0
  });

  it('clamps the resolved end to the export range', async () => {
    layers.push(voice({ startSec: 1 }));
    buffers.set('clip', { duration: 30 });

    await mixdownAudio(0, 5);
    expect(started).toEqual([[1, 0, 4]]); // starts at 1s, cut off at the range end
  });

  it('still returns null when the file genuinely has no decodable audio', async () => {
    layers.push(voice()); // no entry in `buffers` — decode failed
    await expect(mixdownAudio(0, 10)).resolves.toBeNull();
  });

  it('leaves an explicit out-point alone', async () => {
    layers.push(voice({ inSec: 2, outSec: 5 }));
    buffers.set('clip', { duration: 30 });

    await mixdownAudio(0, 10);
    expect(started).toEqual([[0, 2, 3]]);
  });
});
