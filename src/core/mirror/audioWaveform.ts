/**
 * The Audio Waveform generator's config (`layer/audioWaveform`) as the
 * inspector reads it from the document mirror: normalised exactly as the
 * engine's generator reads it (scene/audio_waveform — the ENGINE draws it).
 * Pure: a json value in, a config out.
 */

/** Which slice of the envelope is drawn. */
export type AudioWaveformMode = 'full' | 'playhead-window';

export interface AudioWaveformConfig {
  /** Scene id of the audio layer whose envelope drives this waveform. */
  sourceLayerId: string;
  /** Columns sampled across the layer width (outline resolution). */
  samples: number;
  /** Amplitude multiplier — 1 fills the layer half-height at peak. */
  heightScale: number;
  /** Baseline thickness in px (min visible height, even during silence). */
  thickness: number;
  /** `full` = whole clip across the width; `playhead-window` = a moving slice. */
  mode: AudioWaveformMode;
  /** Window width (seconds) for `playhead-window` mode. */
  windowSec: number;
}


export function defaultAudioWaveform(sourceLayerId = ''): AudioWaveformConfig {
  return { sourceLayerId, samples: 128, heightScale: 1, thickness: 2, mode: 'full', windowSec: 1 };
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

/** The config, or null when the layer carries none. */
export function normalizeAudioWaveform(raw: unknown): AudioWaveformConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AudioWaveformConfig>;
  const d = defaultAudioWaveform();
  return {
    sourceLayerId: typeof r.sourceLayerId === 'string' ? r.sourceLayerId : '',
    samples: Math.max(2, Math.floor(num(r.samples, d.samples))),
    heightScale: num(r.heightScale, d.heightScale),
    thickness: Math.max(0, num(r.thickness, d.thickness)),
    mode: r.mode === 'playhead-window' ? 'playhead-window' : 'full',
    windowSec: Math.max(0, num(r.windowSec, d.windowSec)),
  };
}
