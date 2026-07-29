/**
 * Decoding a video file's audio track, and what happens when there isn't one.
 *
 * A video layer is now a voice like any other (see videoAudio.test.ts), so the
 * engine is asked to decode `.mp4` bytes. Two things have to hold:
 *
 *  - A container with an audio track decodes through the ordinary path.
 *  - A container WITHOUT one fails exactly once. `sync` runs on every playhead
 *    change and asks for every referenced asset, so an uncached failure meant a
 *    silent video re-fetched and re-decoded its whole file dozens of times a
 *    second — which is why the failure is remembered rather than retried.
 */

import { audioEngine } from './AudioEngine';

const engine = audioEngine as unknown as {
  ctx: unknown;
  assets: Map<string, unknown>;
  loading: Map<string, unknown>;
  undecodable: Set<string>;
  voices: Map<string, unknown>;
};

let decodeAudioData: jest.Mock;
let fetchMock: jest.Mock;

beforeEach(() => {
  engine.ctx = null;
  engine.assets.clear();
  engine.loading.clear();
  engine.undecodable.clear();
  engine.voices.clear();

  decodeAudioData = jest.fn(async () => ({
    numberOfChannels: 1,
    length: 48000,
    duration: 1,
    getChannelData: () => new Float32Array(48000),
  }));

  (window as unknown as { AudioContext: unknown }).AudioContext = jest.fn(() => ({
    state: 'running',
    currentTime: 0,
    resume: jest.fn(),
    createGain: jest.fn(() => ({ gain: { value: 1 }, connect: jest.fn().mockReturnThis(), disconnect: jest.fn() })),
    createBufferSource: jest.fn(() => ({ connect: jest.fn(), disconnect: jest.fn(), start: jest.fn(), stop: jest.fn() })),
    createAnalyser: jest.fn(() => ({ connect: jest.fn(), fftSize: 0, getFloatTimeDomainData: jest.fn() })),
    createChannelSplitter: jest.fn(() => ({ connect: jest.fn() })),
    destination: {},
    decodeAudioData,
  }));

  fetchMock = jest.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => jest.restoreAllMocks());

describe("a video file's audio track", () => {
  it('decodes through the same path as an audio asset', async () => {
    const loaded = await audioEngine.load('vidAsset', 'blob:clip.mp4');
    expect(loaded).not.toBeNull();
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(audioEngine.decodeState('vidAsset')).toBe('decoded');
    // The waveform comes for free, so a video bar can draw one like audio does.
    expect(audioEngine.getWaveform('vidAsset')?.duration).toBe(1);
  });

  it('reports a track-less file as silent rather than pending', async () => {
    decodeAudioData.mockRejectedValue(new Error('Unable to decode audio data'));
    expect(await audioEngine.load('mute', 'blob:silent.mp4')).toBeNull();
    expect(audioEngine.decodeState('mute')).toBe('silent');
  });

  it('never re-fetches a file it already failed to decode', async () => {
    decodeAudioData.mockRejectedValue(new Error('Unable to decode audio data'));
    await audioEngine.load('mute', 'blob:silent.mp4');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // What `sync` does on every single playhead change.
    for (let i = 0; i < 25; i++) {
      audioEngine.sync(true, i / 30, [
        { nodeId: 'v', assetId: 'mute', src: 'blob:silent.mp4', level: 100, startSec: 0, inSec: 0, outSec: 5, muted: false },
      ]);
    }
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it('retries after the source is replaced', async () => {
    decodeAudioData.mockRejectedValueOnce(new Error('Unable to decode audio data'));
    await audioEngine.load('swap', 'blob:silent.mp4');
    expect(audioEngine.decodeState('swap')).toBe('silent');

    audioEngine.retry('swap');
    expect(await audioEngine.load('swap', 'blob:with-sound.mp4')).not.toBeNull();
    expect(audioEngine.decodeState('swap')).toBe('decoded');
  });
});
