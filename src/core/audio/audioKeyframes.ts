/**
 * Convert Audio to Keyframes (AE's keyframe assistant) — sample an audio
 * layer's decoded buffer into a per-frame RMS loudness envelope and write it
 * as a keyframe track (`audioAmplitude`, 0–100) on the audio layer. Drive
 * anything from it: parent a scale/opacity expression to the track, or
 * copy keyframes onto other properties.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getTimelineController } from '@core/timeline/TimelineController';
import { audioEngine } from '@core/audio/AudioEngine';

export const AUDIO_AMPLITUDE_PROP = 'audioAmplitude';

/**
 * Per-frame RMS amplitude, normalized to 0–100 against the clip's own peak.
 * Pure math over the decoded buffer — one value per frame at `fps`.
 */
export function amplitudeEnvelope(buffer: AudioBuffer, fps: number): number[] {
  if (fps <= 0 || buffer.length === 0) return [];
  const frames = Math.max(1, Math.ceil(buffer.duration * fps));
  const samplesPerFrame = Math.max(1, Math.floor(buffer.sampleRate / fps));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const out = new Array<number>(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * samplesPerFrame;
    const end = Math.min(buffer.length, start + samplesPerFrame);
    let sum = 0;
    let n = 0;
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        const v = ch[i]!;
        sum += v * v;
        n++;
      }
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    out[f] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak <= 0) return out.map(() => 0);
  return out.map((v) => Math.round((v / peak) * 1000) / 10); // 0–100, 0.1 steps
}

/** Thin an envelope: keep frames where the value moves ≥ `minDelta` from the
 *  last KEPT frame (plus first/last), so flat stretches don't spam keyframes. */
export function thinEnvelope(env: readonly number[], minDelta = 0.5): Array<{ frame: number; value: number }> {
  if (env.length === 0) return [];
  const out: Array<{ frame: number; value: number }> = [{ frame: 0, value: env[0]! }];
  let last = env[0]!;
  for (let f = 1; f < env.length - 1; f++) {
    if (Math.abs(env[f]! - last) >= minDelta) {
      out.push({ frame: f, value: env[f]! });
      last = env[f]!;
    }
  }
  if (env.length > 1) out.push({ frame: env.length - 1, value: env[env.length - 1]! });
  return out;
}

/**
 * Write the audio layer's loudness envelope as keyframes. Returns the number
 * of keyframes written (0 = no decoded audio yet — play once, or wait for
 * the decode to finish).
 */
export function convertAudioToKeyframes(nodeId: string): number {
  const node = defaultSceneGraph.getNode(nodeId);
  const audio = node?.components.find((c) => c.type === 'Audio');
  const assetId = audio?.props.__assetId;
  if (typeof assetId !== 'string') return 0;
  const buffer = audioEngine.decodedBuffer(assetId);
  if (!buffer) return 0;
  const fps = getTimelineController().fps || 30;
  const keyframes = thinEnvelope(amplitudeEnvelope(buffer, fps));
  if (keyframes.length === 0) return 0;
  runAnimEdit('Convert audio to keyframes', () => {
    defaultAnimation.removeTrack(nodeId, AUDIO_AMPLITUDE_PROP);
    for (const k of keyframes) {
      defaultAnimation.setKeyframe(nodeId, AUDIO_AMPLITUDE_PROP, k.frame / fps, k.value);
    }
  });
  return keyframes.length;
}
