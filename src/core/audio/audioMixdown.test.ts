/**
 * Audio export mixdown.
 *
 * Every MP4/WebM this app produced was silent — nothing carried the comp's
 * audio into an export. The scheduling math (a layer's trim × the export range)
 * is where an off-by-one silently desyncs or drops audio, so it's tested
 * directly; the WAV encoder is checked at the byte level.
 */

import { audibleWindow, encodeWav, bufferToWav, mixdownAudio, type PcmSource } from './audioMixdown';
import type { AudioLayerState } from './AudioEngine';

function layer(over: Partial<AudioLayerState> = {}): AudioLayerState {
  return {
    nodeId: 'a', assetId: 'asset', src: 'x', level: 100,
    startSec: 0, inSec: 0, outSec: 10, muted: false, ...over,
  };
}

describe('audibleWindow', () => {
  it('places a whole clip at its comp start', () => {
    // Clip at t=2 spanning buffer [0,4]; full export range.
    const w = audibleWindow(layer({ startSec: 2, inSec: 0, outSec: 4 }), 0, 20);
    expect(w).toEqual({ when: 2, offset: 0, duration: 4 });
  });

  it('respects the in-point (buffer offset)', () => {
    // Trimmed to start 3s into the source.
    const w = audibleWindow(layer({ startSec: 0, inSec: 3, outSec: 5 }), 0, 20);
    expect(w).toEqual({ when: 0, offset: 3, duration: 2 });
  });

  it('clips the head when the export range starts mid-clip', () => {
    // Clip [0,10]; export starts at 4. First 4s are skipped in both timelines.
    const w = audibleWindow(layer({ startSec: 0, inSec: 0, outSec: 10 }), 4, 12);
    expect(w).toEqual({ when: 0, offset: 4, duration: 6 });
  });

  it('clips the tail when the clip runs past the export end', () => {
    const w = audibleWindow(layer({ startSec: 0, inSec: 0, outSec: 10 }), 0, 6);
    expect(w).toEqual({ when: 0, offset: 0, duration: 6 });
  });

  it('combines head+tail clipping with a non-zero in-point', () => {
    // Clip at comp t=5, buffer [2,12] (10s long → comp span [5,15]); export [8,10].
    const w = audibleWindow(layer({ startSec: 5, inSec: 2, outSec: 12 }), 8, 10);
    // overlap comp [8,10]: when = 8-8 = 0; offset = 2 + (8-5) = 5; duration 2.
    expect(w).toEqual({ when: 0, offset: 5, duration: 2 });
  });

  it('returns null when the clip is entirely before the range', () => {
    expect(audibleWindow(layer({ startSec: 0, outSec: 3 }), 5, 10)).toBeNull();
  });

  it('returns null when the clip is entirely after the range', () => {
    expect(audibleWindow(layer({ startSec: 20, outSec: 3 }), 0, 10)).toBeNull();
  });

  it('returns null for a zero-length trim', () => {
    expect(audibleWindow(layer({ inSec: 5, outSec: 5 }), 0, 10)).toBeNull();
  });
});

describe('bufferToWav', () => {
  function tone(): PcmSource {
    const frames = 100;
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) data[i] = Math.sin(i / 5);
    return { numberOfChannels: 1, length: frames, sampleRate: 48000, getChannelData: () => data };
  }

  it('writes a valid RIFF/WAVE header', () => {
    const bytes = new Uint8Array(encodeWav(tone()));
    const str = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));

    expect(bufferToWav(tone()).type).toBe('audio/wav');
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(str(12, 4)).toBe('fmt ');
    expect(str(36, 4)).toBe('data');

    const view = new DataView(bytes.buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint32(24, true)).toBe(48000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('sizes the data chunk to the frames (mono, 16-bit)', () => {
    const bytes = new Uint8Array(encodeWav(tone()));
    const view = new DataView(bytes.buffer);
    // 100 frames × 1 channel × 2 bytes = 200; total = 44 + 200.
    expect(view.getUint32(40, true)).toBe(200);
    expect(bytes.length).toBe(244);
  });
});

describe('mixdownAudio', () => {
  it('returns null gracefully when Web Audio is unavailable (jsdom)', async () => {
    // OfflineAudioContext doesn't exist in jsdom, so export falls back to silent
    // video rather than throwing.
    await expect(mixdownAudio(0, 10)).resolves.toBeNull();
  });
});
