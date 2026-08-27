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
import { buildParamRamp, applyRamp } from './audioParams';
import { connectAudioEffects, hasBackwards, reverseBuffer, backwardsOffset } from './audioEffects';

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
  const rate = Math.max(0.01, l.playbackRate ?? 1);
  // Bar length on the timeline (wall seconds). Source consumed = barLen × rate.
  const barLen = Math.max(0, l.outSec - l.inSec);
  if (barLen <= 0) return null;
  const clipStart = l.startSec;
  const clipEnd = l.startSec + barLen;

  const overlapStart = Math.max(clipStart, rangeStart);
  const overlapEnd = Math.min(clipEnd, rangeEnd);
  if (overlapEnd <= overlapStart) return null;

  const wallDur = overlapEnd - overlapStart;
  return {
    when: overlapStart - rangeStart, // position on the export timeline
    offset: l.inSec + (overlapStart - clipStart) * rate, // read position in the buffer
    duration: wallDur * rate, // BUFFER seconds to play at `rate`
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
 *  Blobs lack `.arrayBuffer`, so tests read this directly). */
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
async function mixdownBuffer(startSec: number, endSec: number, scopeRootId?: string): Promise<AudioBuffer | null> {
  const Ctor = offlineCtor();
  const duration = Math.max(0, endSec - startSec);
  if (!Ctor || duration <= 0) return null;

  // A muted layer contributes nothing. Level is NOT filtered on here: an
  // animated level that starts at silence and rises is entirely legitimate, and
  // dropping it on its opening value would remove exactly the fade-in case
  // keyframable levels exist for.
  const layers = readAudioLayers(scopeRootId).filter((l) => !l.muted);
  if (layers.length === 0) return null;

  // Decode anything not already in the AudioEngine's cache.
  await Promise.all(layers.map((l) => audioEngine.load(l.assetId, l.src)));

  // `outSec: 0` is the "play to the end of the file" sentinel the live engine
  // already honours (`l.outSec > 0 ? l.outSec : buffer.duration`). It reaches
  // here for any voice with no timeline bar and no known duration — including
  // every video layer imported before its metadata resolved. Resolving it
  // against the decoded buffer has to happen AFTER the decode above and BEFORE
  // `audibleWindow`, which would otherwise compute a zero-length clip and drop
  // the layer from the export while preview played it fine.
  const resolved = layers.map((l) =>
    l.outSec > 0 ? l : { ...l, outSec: audioEngine.decodedBuffer(l.assetId)?.duration ?? 0 },
  );

  const scheduled = resolved
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
    // Layer-time reverse OR the Backwards effect — same decision as startVoice.
    const reversed = l.retimeReverse === true || hasBackwards(l.effects);
    source.buffer = reversed ? reverseBuffer(ctx, buffer) : buffer;
    const rate = Math.max(0.01, l.playbackRate ?? 1);
    if (source.playbackRate) source.playbackRate.value = rate;
    const gain = ctx.createGain();
    // `win.offset` is a position in the SOURCE buffer; wall start = invert rate.
    const compStart = l.startSec + (win.offset - l.inSec) / rate;
    const wallDur = win.duration / rate;
    // The SAME builder the live engine uses, on the offline context. Both take
    // a `BaseAudioContext` precisely so this call cannot diverge from that one,
    // and both hand it the voice window so an animated parameter is a curve
    // rather than a value frozen at the voice's start.
    const chain = connectAudioEffects(ctx, source, l.effects, {
      nodeId: l.nodeId,
      startCompSec: compStart,
      durationSec: wallDur,
      whenCtx: win.when,
    });
    chain.node.connect(gain).connect(ctx.destination);

    // The SAME curve builder the live engine uses, scheduled on the offline
    // context's clock. This is the seam where preview and export could drift
    // apart, and the reason it is one function rather than two: a level curve
    // that sounds right while scrubbing and renders differently is only
    // discoverable by exporting and listening to the whole file.
    //
    // (`compStart` is computed above, because the effect chain schedules its
    // own curves from the same window.)
    const ramp = buildParamRamp(l.nodeId, l.levelDb, compStart, wallDur, {
      animated: l.levelAnimated === true,
    });
    applyRamp(gain.gain, ramp, win.when);

    try {
      // Mirrored when the buffer is reversed — see `backwardsOffset` for the
      // failure this prevents: the wrong span of the file, in time, silently.
      const readAt = reversed
        ? backwardsOffset(buffer.duration, win.offset, win.duration)
        : win.offset;
      source.start(win.when, readAt, win.duration);
      /*
        The chain's oscillators, on the render clock.

        Offline has no "now", so both times are absolute. An oscillator left
        unstarted here renders silence into the export while the live preview
        plays it — the exact preview/export divergence this module exists to
        prevent, and one that only an export and a careful listen would find.
      */
      for (const s of chain.sources) {
        s.start(win.when);
        s.stop(win.when + wallDur);
      }
      voices++;
    } catch {
      /* offset past the buffer end etc. — skip this voice */
    }
  }
  if (voices === 0) return null;

  return ctx.startRendering();
}

/** As {@link mixdownBuffer}, encoded to a 16-bit stereo WAV for ffmpeg.
 *  `scopeRootId` restricts the mix to ONE composition's layers — exports pass
 *  their comp, so a multi-comp project no longer ships every comp's audio
 *  under whichever comp's picture was rendered. */
export async function mixdownAudio(
  startSec: number,
  endSec: number,
  scopeRootId?: string,
): Promise<AudioMixdown | null> {
  const rendered = await mixdownBuffer(startSec, endSec, scopeRootId);
  if (!rendered) return null;
  return { wav: bufferToWav(rendered), sampleRate: EXPORT_SAMPLE_RATE, durationSec: rendered.duration };
}
