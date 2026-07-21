/**
 * Offline audio mixdown for export.
 *
 * Every MP4 and WebM this app produced was SILENT — the AudioEngine, audio
 * import and per-layer audio all existed, but nothing carried the sound into an
 * export. This mixes the comp's audio layers over the export range into a
 * single WAV, deterministically (via OfflineAudioContext, no wall-clock), which
 * both export paths then attach to the video: MP4 muxes it in ffmpeg on the
 * backend; WebM feeds it to MediaRecorder.
 *
 * Gain and scheduling mirror the live AudioEngine (linear `level/100`, buffer
 * offset `inSec + (compTime − startSec)`), so an export sounds like preview.
 */

import { audioEngine } from './AudioEngine';
import { readAudioLayers } from './audioScene';
import type { AudioLayerState } from './AudioEngine';

/** Standard export sample rate — 48 kHz is what AAC/most containers expect. */
const EXPORT_SAMPLE_RATE = 48000;

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  if (typeof OfflineAudioContext !== 'undefined') return OfflineAudioContext as unknown as OfflineCtor;
  const w = globalThis as { webkitOfflineAudioContext?: OfflineCtor };
  return w.webkitOfflineAudioContext ?? null;
}

/**
 * The comp-time window a layer is audible in, clamped to the export range.
 * Exported for testing — this scheduling math (trim × range overlap) is where
 * an off-by-one desyncs the whole export.
 */
export function audibleWindow(
  l: AudioLayerState,
  rangeStart: number,
  rangeEnd: number,
): { when: number; offset: number; duration: number } | null {
  const clipLen = Math.max(0, l.outSec - l.inSec);
  if (clipLen <= 0) return null;
  const clipStart = l.startSec;
  const clipEnd = l.startSec + clipLen;

  const overlapStart = Math.max(clipStart, rangeStart);
  const overlapEnd = Math.min(clipEnd, rangeEnd);
  if (overlapEnd <= overlapStart) return null;

  return {
    when: overlapStart - rangeStart, // position on the export timeline
    offset: l.inSec + (overlapStart - clipStart), // read position in the buffer
    duration: overlapEnd - overlapStart,
  };
}

/** The minimal AudioBuffer surface bufferToWav reads (so it's testable). */
export interface PcmSource {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** Render a 16-bit stereo PCM buffer to WAV bytes. Exported for testing (jsdom
 *  Blobs lack `.arrayBuffer()`, so tests read this directly). */
export function encodeWav(buffer: PcmSource): ArrayBuffer {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));

  let pos = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, chans[c]![i]!));
      view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      pos += 2;
    }
  }
  return out;
}

/** WAV bytes wrapped in a Blob for download / upload. */
export function bufferToWav(buffer: PcmSource): Blob {
  return new Blob([encodeWav(buffer)], { type: 'audio/wav' });
}

export interface AudioMixdown {
  wav: Blob;
  sampleRate: number;
  durationSec: number;
}

/**
 * Render the scene's audio layers over `[startSec, endSec]` into one AudioBuffer.
 *
 * Returns null when there is nothing to mix (no audio layers, none audible,
 * all muted) or Web Audio is unavailable — the caller then keeps the video
 * silent, exactly as before, rather than failing. Deterministic: no wall-clock.
 */
export async function mixdownBuffer(startSec: number, endSec: number): Promise<AudioBuffer | null> {
  const Ctor = offlineCtor();
  const duration = Math.max(0, endSec - startSec);
  if (!Ctor || duration <= 0) return null;

  const layers = readAudioLayers().filter((l) => !l.muted && l.level > 0);
  if (layers.length === 0) return null;

  // Decode anything not already in the AudioEngine's cache.
  await Promise.all(layers.map((l) => audioEngine.load(l.assetId, l.src)));

  const scheduled = layers
    .map((l) => ({ l, win: audibleWindow(l, startSec, endSec) }))
    .filter((x): x is { l: AudioLayerState; win: NonNullable<ReturnType<typeof audibleWindow>> } => x.win !== null);
  if (scheduled.length === 0) return null;

  const length = Math.ceil(duration * EXPORT_SAMPLE_RATE);
  const ctx = new Ctor(2, length, EXPORT_SAMPLE_RATE);

  let voices = 0;
  for (const { l, win } of scheduled) {
    const buffer = audioEngine.decodedBuffer(l.assetId);
    if (!buffer) continue; // decode failed; skip rather than fail the whole mix
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, l.level / 100);
    source.connect(gain).connect(ctx.destination);
    try {
      source.start(win.when, win.offset, win.duration);
      voices++;
    } catch {
      /* offset past the buffer end etc. — skip this voice */
    }
  }
  if (voices === 0) return null;

  return ctx.startRendering();
}

/** As {@link mixdownBuffer}, encoded to a 16-bit stereo WAV for ffmpeg. */
export async function mixdownAudio(startSec: number, endSec: number): Promise<AudioMixdown | null> {
  const rendered = await mixdownBuffer(startSec, endSec);
  if (!rendered) return null;
  return { wav: bufferToWav(rendered), sampleRate: EXPORT_SAMPLE_RATE, durationSec: rendered.duration };
}
