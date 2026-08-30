/**
 * The composition's own sound, prepared for a speech-to-text service.
 *
 * The audio a transcriber wants is not the audio an exporter wants. An export
 * mixdown is 48 kHz stereo 16-bit because that is what AAC expects; a speech
 * model wants 16 kHz mono because that is all it uses, and because the
 * difference is a factor of six in bytes. Three minutes of comp is ~34 MB as an
 * export mix and ~5.8 MB here, which is the difference between "transcribe
 * this" and "the provider refuses anything over 25 MB".
 *
 * Deliberately reuses `mixdownBuffer` rather than reading a footage file: what
 * gets transcribed should be what the comp SOUNDS like — layer trims, levels,
 * mutes and all — so the cues line up with the picture the user is looking at.
 * Transcribing the source file of a clip that appears at 00:42, trimmed, would
 * produce captions timed to the file rather than to the composition.
 *
 * The resampler is a plain linear interpolation. That is a real, if mild,
 * quality choice: it aliases above 8 kHz, which is above every phoneme a speech
 * model reads, and the alternative (a windowed-sinc bank) is a page of code
 * defending fidelity that nothing downstream can hear.
 */

import { encodeWav, mixdownBuffer, type PcmSource } from '@core/audio/audioMixdown';

/** What speech models are trained on, and all of them accept. */
export const SPEECH_SAMPLE_RATE = 16000;

/** Average every channel into one. Speech models are monophonic. */
export function toMono(buffer: PcmSource): Float32Array {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  if (channels === 0) return out;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (data[i] ?? 0);
  }
  if (channels > 1) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / channels;
  }
  return out;
}

/**
 * Linear-interpolating resample. Pure, so the rate maths is testable without
 * Web Audio — which is the part worth testing: an off-by-one in the output
 * length shifts every caption in the file by a growing amount.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[index] ?? 0;
    // The last output sample can land on the final input sample exactly; there
    // is no `index + 1` to blend towards, and reading undefined as 0 would put
    // a click on the end of every clip.
    const b = samples[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Wrap a mono Float32Array in the shape `encodeWav` reads. */
function monoSource(samples: Float32Array, sampleRate: number): PcmSource {
  return {
    numberOfChannels: 1,
    length: samples.length,
    sampleRate,
    getChannelData: () => samples,
  };
}

/**
 * Mix `[startSec, endSec]` of the composition down to a 16 kHz mono WAV.
 *
 * Returns null when there is nothing to transcribe — no audio layers, all
 * muted, or no Web Audio — which the caller reports as "this composition has no
 * sound" rather than sending an empty file to a provider and paying for the
 * silence.
 */
export async function speechWav(
  startSec: number,
  endSec: number,
  scopeRootId?: string,
): Promise<Uint8Array | null> {
  const rendered = await mixdownBuffer(startSec, endSec, scopeRootId);
  if (!rendered || rendered.length === 0) return null;
  const mono = resampleLinear(toMono(rendered), rendered.sampleRate, SPEECH_SAMPLE_RATE);
  return new Uint8Array(encodeWav(monoSource(mono, SPEECH_SAMPLE_RATE)));
}

/** Bytes per second of the format above — for a size estimate before mixing. */
export const SPEECH_BYTES_PER_SECOND = SPEECH_SAMPLE_RATE * 2;
