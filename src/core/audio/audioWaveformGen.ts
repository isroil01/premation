/**
 * Audio Waveform generator (AE "Audio Waveform" effect parity — the ENVELOPE
 * variant, NOT an FFT/spectrum analyser). Turns a referenced audio layer's
 * precomputed peak envelope into a shape layer's vector outline, so it draws
 * on-canvas through the existing rasterizer → GPU path (no new GPU pass, no new
 * layer kind — just `pathPoints` on a shape).
 *
 * Two moving parts:
 *   - {@link audioWaveformPoints} — PURE geometry (peaks + config → bezier
 *     corner points, local layer space). No Date.now / Math.random, so the same
 *     inputs always yield the same outline; unit-tested directly.
 *   - {@link resolveAudioWaveformPoints} — looks the referenced audio layer's
 *     peaks up (via the AudioEngine, which precomputes them on decode) and calls
 *     the pure generator. When the source isn't decoded yet it returns a
 *     degenerate zero-area path so the frame draws NOTHING (never throws/blocks).
 *
 * Config is stored on the shape's `fx` component under `audioWaveform`, mirroring
 * how puppet / particle / repeater blocks live on `fx`.
 */

import { corner, type BezierPoint } from '../../../packages/workspace/src/math/BezierPoint';
import { peakAtNorm, type WaveformPeaks } from './waveform';
import { audioEngine } from './AudioEngine';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioComponent, readAudioClipTimings } from './audioScene';
import type { SceneNode } from '@core/types';
import { bumpScene } from '@stores/sceneStore';

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

export const AUDIO_WAVEFORM_FX_KEY = 'audioWaveform';

export function defaultAudioWaveform(sourceLayerId = ''): AudioWaveformConfig {
  return {
    sourceLayerId,
    samples: 128,
    heightScale: 1,
    thickness: 2,
    mode: 'full',
    windowSec: 1,
  };
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

/** Read the audioWaveform block off a node's `fx` component, or null when absent. */
export function readNodeAudioWaveform(node: SceneNode): AudioWaveformConfig | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props[AUDIO_WAVEFORM_FX_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AudioWaveformConfig>;
  const d = defaultAudioWaveform();
  const mode: AudioWaveformMode = r.mode === 'playhead-window' ? 'playhead-window' : 'full';
  return {
    sourceLayerId: typeof r.sourceLayerId === 'string' ? r.sourceLayerId : '',
    samples: Math.max(2, Math.floor(num(r.samples, d.samples))),
    heightScale: num(r.heightScale, d.heightScale),
    thickness: Math.max(0, num(r.thickness, d.thickness)),
    mode,
    windowSec: Math.max(0, num(r.windowSec, d.windowSec)),
  };
}

/** True when the node carries an audioWaveform block (gates its inspector). */
export function hasAudioWaveform(node: SceneNode): boolean {
  return readNodeAudioWaveform(node) !== null;
}

/** Write / clear the audioWaveform block on a layer's `fx` component. */
export function setAudioWaveform(nodeId: string, cfg: AudioWaveformConfig | null): void {
  defaultSceneGraph.setAudioWaveform(nodeId, cfg ?? undefined);
  bumpScene();
}

/** Patch fields of a layer's audioWaveform block (seeding a default if absent). */
export function updateAudioWaveform(nodeId: string, patch: Partial<AudioWaveformConfig>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const base = readNodeAudioWaveform(node) ?? defaultAudioWaveform();
  setAudioWaveform(nodeId, { ...base, ...patch });
}

/**
 * A zero-area closed path (two coincident points). Used when there is nothing to
 * draw yet — it keeps `primitive:'path'` (so the shape does NOT fall back to a
 * solid rectangle) while filling no pixels. The renderer's outline reader wants
 * length > 1, hence two points rather than an empty array.
 */
export const EMPTY_WAVEFORM_PATH: readonly BezierPoint[] = [corner(0, 0), corner(0, 0)];

/**
 * PURE waveform-envelope outline as closed bezier corner points in local layer
 * space (centred at 0,0, spanning ±width/2 · ±height/2). Mirrored across the
 * horizontal midline like AE's Audio Waveform. Deterministic — no clock, no RNG.
 *
 * Returns `[]` when there is no data (empty peaks, non-positive size), so the
 * caller can decide how to represent "nothing".
 */
export function audioWaveformPoints(
  peaks: Float32Array,
  duration: number,
  width: number,
  height: number,
  timeSec: number,
  cfg: AudioWaveformConfig,
): BezierPoint[] {
  if (peaks.length === 0 || width <= 0 || height <= 0) return [];
  const n = Math.max(2, Math.floor(cfg.samples));
  const halfH = height / 2;
  const heightScale = Number.isFinite(cfg.heightScale) ? cfg.heightScale : 1;
  const minH = Math.min(halfH, Math.max(0, cfg.thickness) / 2);

  // Normalized [t0..t1] slice of the envelope this outline covers.
  let t0 = 0;
  let t1 = 1;
  if (cfg.mode === 'playhead-window' && duration > 0 && cfg.windowSec > 0) {
    const half = cfg.windowSec / 2;
    t0 = (timeSec - half) / duration;
    t1 = (timeSec + half) / duration;
  }

  const top: BezierPoint[] = [];
  const bottom: BezierPoint[] = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    const norm = t0 + (t1 - t0) * frac;
    // Outside the clip (window mode can run past either end) reads as silence.
    const amp = norm >= 0 && norm <= 1 ? peakAtNorm(peaks, norm) : 0;
    const x = -width / 2 + frac * width;
    let h = amp * halfH * heightScale;
    if (h < minH) h = minH;
    if (h > halfH) h = halfH;
    top.push(corner(x, -h));
    bottom.push(corner(x, h));
  }
  bottom.reverse();
  return [...top, ...bottom];
}

// ── Peak source (default = AudioEngine's precomputed cache) ───────────────
// Indirected so a buildSnapshot integration test can seed peaks without Web
// Audio. The DEFAULT is wired to the real engine at module load, so the app
// path needs no external wiring (nothing to forget to hook up).
let getWave: (assetId: string) => WaveformPeaks | undefined = (id) => audioEngine.getWaveform(id);

/** Test seam: override the peak source. Pass no arg to restore the engine. */
export function __setWaveProviderForTest(fn?: (assetId: string) => WaveformPeaks | undefined): void {
  getWave = fn ?? ((id) => audioEngine.getWaveform(id));
}

/**
 * Resolve the waveform outline for a config against the live scene: find the
 * referenced audio layer, look up its decoded peaks, and generate the outline.
 * Always returns a drawable BezierPoint[] — a degenerate zero-area path when the
 * source is missing / not yet decoded (draw nothing, never throw).
 */
export function resolveAudioWaveformPoints(
  cfg: AudioWaveformConfig,
  width: number,
  height: number,
  timeSec: number,
): BezierPoint[] {
  const src = cfg.sourceLayerId ? defaultSceneGraph.getNode(cfg.sourceLayerId) : undefined;
  if (!src) return EMPTY_WAVEFORM_PATH as BezierPoint[];
  const comp = audioComponent(src);
  const assetId = comp && typeof comp.props.__assetId === 'string' ? comp.props.__assetId : '';
  if (!assetId) return EMPTY_WAVEFORM_PATH as BezierPoint[];
  const wave = getWave(assetId);
  if (!wave) return EMPTY_WAVEFORM_PATH as BezierPoint[];
  // Clip-local time so the playhead window tracks the audio, honouring where
  // the source layer's BAR sits (and which part of the source it plays). The
  // timeline clip is the authority — see audioScene; `__start` is only the
  // fallback for audio with no bar.
  const timings = readAudioClipTimings(cfg.sourceLayerId);
  const at = timings.find((t) => timeSec >= t.startSec && timeSec < t.startSec + (t.outSec - t.inSec)) ?? timings[0];
  const localT = at
    ? at.inSec + (timeSec - at.startSec)
    : timeSec - num(comp?.props.__start, 0);
  const pts = audioWaveformPoints(wave.peaks, wave.duration, width, height, localT, cfg);
  return pts.length > 1 ? pts : (EMPTY_WAVEFORM_PATH as BezierPoint[]);
}
