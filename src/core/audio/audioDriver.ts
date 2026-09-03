/**
 * Audio DRIVERS — "make this property follow the music", as a control instead
 * of a formula.
 *
 * The pieces have been here for a while and never met. `audio` exists as an
 * expression identifier, Convert Audio to Keyframes writes an amplitude track,
 * `audioSpectrum` already owns an FFT. What did not exist is the sentence a
 * person actually wants to say: *this scale, from this track's low end, snappy
 * attack, slow release, between 100 and 160*. Today they write
 * `value + audio * 200` and then discover the three things that formula cannot
 * do, one at a time.
 *
 * ## Why most drivers cannot be an expression, and say so out loud
 *
 * The `audio` identifier is bound in `Providers.tsx` to
 * `audioEngine.currentLevel()` — the LIVE playback meter, broadband, and with
 * the frame time argument ignored. Three consequences follow, and they are the
 * whole reason this module bakes:
 *
 *   • It has no band. `audio` cannot tell a kick from a hi-hat.
 *   • It has no memory. Attack/release is a one-pole filter over the PREVIOUS
 *     frame's output; an expression is a pure function of one frame and has
 *     nowhere to keep that.
 *   • It is not a function of time. Scrubbing to 4s reports whatever the
 *     speakers are doing now, and an export — which never plays — reports 0.
 *
 * So {@link audioDriverExpression} returns a real expression for the narrow
 * case that is honestly expressible (comp mix, full band, no attack/release,
 * no smoothing, no normalisation) and `null` otherwise, and
 * {@link applyAudioDriver} falls back to BAKED keyframes rather than writing a
 * formula that would quietly mean something else. A driver that renders
 * differently than it previews is the failure this module is shaped to avoid.
 *
 * ## Shape
 *
 * Pure first: {@link analyseAudioEnvelope} (samples → per-frame 0..1) and
 * {@link mapEnvelope} (0..1 → the property's units) know nothing about the
 * scene, so the panel can compute a preview strip with the same code that does
 * the bake. The scene-touching half resolves the source, aligns it to comp
 * time, and writes one undoable edit.
 *
 * The driver's parameters are remembered on the node as a `__audioDriver` map
 * keyed by prop path (same hidden-prop convention as `__animators` on text
 * layers), so the panel can show what a baked track came from and re-bake it
 * after the audio, the work area or the numbers change. Without that, a baked
 * track is indistinguishable from hand-drawn keyframes the moment the panel
 * closes.
 */

import { fftInPlace } from '@motion/audio';
import { defaultAnimation, type Keyframe } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';
import { ensureAudioBuffer } from './audioKeyframes';
import { readAudioClipTimings } from './audioScene';
import { mixdownBuffer } from './audioMixdown';

// ── Analysis ────────────────────────────────────────────────────────

/** Analysis window, in samples. Power of two — the radix-2 FFT requires it. */
export const DRIVER_FFT_SIZE = 1024;

/** A named band, or an explicit Hz range. */
export type AudioBand = 'full' | 'low' | 'mid' | 'high' | { lo: number; hi: number };

/**
 * Hz edges for the named bands.
 *
 * `full` starts at 20 rather than 0 because bin 0 is DC — a constant offset in
 * the file, not a sound — and including it makes a slightly-offset recording
 * read as permanently loud.
 */
export const BAND_RANGES: Readonly<Record<'full' | 'low' | 'mid' | 'high', { lo: number; hi: number }>> = {
  full: { lo: 20, hi: 20000 },
  low: { lo: 20, hi: 250 },
  mid: { lo: 250, hi: 2000 },
  high: { lo: 2000, hi: 16000 },
};

export const BAND_LABELS: Readonly<Record<'full' | 'low' | 'mid' | 'high', string>> = {
  full: 'Full range',
  low: 'Low (20–250 Hz)',
  mid: 'Mid (250 Hz–2 kHz)',
  high: 'High (2–16 kHz)',
};

/** Resolve a band to Hz edges. */
export function bandRange(band: AudioBand): { lo: number; hi: number } {
  if (typeof band === 'string') return BAND_RANGES[band] ?? BAND_RANGES.full;
  const lo = Math.max(0, Number.isFinite(band.lo) ? band.lo : 0);
  const hi = Math.max(lo + 1, Number.isFinite(band.hi) ? band.hi : lo + 1);
  return { lo, hi };
}

export interface EnvelopeOptions {
  /** Which part of the spectrum drives the envelope. Default `'full'`. */
  band?: AudioBand;
  /** Rise time constant, ms. 0 = instant. Default 0. */
  attackMs?: number;
  /** Fall time constant, ms. 0 = instant. Default 0. */
  releaseMs?: number;
  /** Floor, 0..1 — detector values below it are read as silence. Default 0. */
  gate?: number;
  /** Rescale the finished envelope so its own peak is 1. Default true. */
  normalize?: boolean;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * One-pole coefficient for a time constant in ms at `fps`.
 *
 * `1 - exp(-1/(τ·fps))` — the standard discrete one-pole, so the number in the
 * field means the same thing at 24 and at 60 fps. A zero (or negative) time
 * constant returns 1: follow the detector exactly.
 */
function poleCoeff(ms: number, fps: number): number {
  if (!Number.isFinite(ms) || ms <= 0 || fps <= 0) return 1;
  const frames = (ms / 1000) * fps;
  if (frames <= 0) return 1;
  return 1 - Math.exp(-1 / frames);
}

/**
 * Band magnitude of one analysis window, as an AMPLITUDE in 0..1-ish units.
 *
 * The FFT is unnormalised (see `fftInPlace`), and a Hann window has a coherent
 * gain of 0.5, so a full-scale sine lands at `A·N/4`. Undoing that here is what
 * makes the dB conversion below mean anything: without it the "0 dB" reference
 * would depend on the window size, and changing `DRIVER_FFT_SIZE` would move
 * every user's envelope.
 */
function windowBandAmplitude(
  re: Float32Array,
  im: Float32Array,
  sampleRate: number,
  lo: number,
  hi: number,
): number {
  const n = re.length;
  const bins = n / 2;
  const nyquist = sampleRate / 2;
  const f0 = Math.max(0, Math.min(nyquist, lo));
  const f1 = Math.max(f0, Math.min(nyquist, hi));
  // Bin 0 is DC and is never included — see BAND_RANGES.
  const i0 = Math.max(1, Math.min(bins - 1, Math.floor((f0 / nyquist) * bins)));
  const i1 = Math.max(i0 + 1, Math.min(bins, Math.ceil((f1 / nyquist) * bins)));

  let power = 0;
  for (let i = i0; i < i1; i++) {
    const mag = Math.hypot(re[i] ?? 0, im[i] ?? 0);
    const amp = (4 * mag) / n;
    power += amp * amp;
  }
  return Math.sqrt(power);
}

/**
 * Per-frame audio envelope in 0..1, one value per frame of `fps` across the
 * whole of `samples`.
 *
 * PURE: samples in, numbers out. No scene, no engine, no DOM — which is what
 * lets the inspector's preview strip and the bake share one implementation
 * instead of drifting apart the way a "quick preview approximation" always
 * eventually does.
 *
 * The detector is spectral (an FFT per frame over a Hann-windowed
 * {@link DRIVER_FFT_SIZE} window) rather than time-domain RMS, because band
 * selection is the point: RMS cannot tell a kick from a hi-hat, and "reuse the
 * existing amplitude envelope and filter it afterwards" would need a real
 * filter bank to do the same job less accurately.
 *
 * Order of operations, which is a choice and not an accident:
 *   detector → gate → attack/release → normalise
 * The gate is BEFORE the smoothing so a gated hit still decays through the
 * release rather than cutting to zero, and the normalise is AFTER it so the
 * peak being scaled to 1 is a peak the user can actually see in the preview.
 */
export function analyseAudioEnvelope(
  samples: Float32Array,
  sampleRate: number,
  fps: number,
  opts: EnvelopeOptions = {},
): Float32Array {
  if (fps <= 0 || sampleRate <= 0 || samples.length === 0) return new Float32Array(0);

  const { lo, hi } = bandRange(opts.band ?? 'full');
  const gate = clamp01(Number.isFinite(opts.gate ?? 0) ? (opts.gate ?? 0) : 0);
  const normalize = opts.normalize !== false;

  const n = DRIVER_FFT_SIZE;
  const samplesPerFrame = Math.max(1, sampleRate / fps);
  const frames = Math.max(1, Math.ceil(samples.length / samplesPerFrame));

  // Hann coefficients are the same for every window; computing them once turns
  // a per-frame trig loop into a per-frame multiply. At 5000 frames that is
  // five million cosines the bake does not do.
  const hann = new Float32Array(n);
  for (let i = 0; i < n; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const out = new Float32Array(frames);

  const aA = poleCoeff(opts.attackMs ?? 0, fps);
  const aR = poleCoeff(opts.releaseMs ?? 0, fps);
  let y = 0;

  for (let f = 0; f < frames; f++) {
    const start = Math.floor(f * samplesPerFrame);
    const take = Math.max(0, Math.min(n, samples.length - start));
    for (let i = 0; i < take; i++) re[i] = (samples[start + i] ?? 0) * (hann[i] ?? 0);
    // Zero the tail rather than allocating a fresh pair of arrays per frame.
    for (let i = take; i < n; i++) re[i] = 0;
    im.fill(0);
    fftInPlace(re, im);

    const amp = windowBandAmplitude(re, im, sampleRate, lo, hi);
    // −60 dB floor → 0, 0 dB → 1. The same compression `spectrumBands` uses,
    // and for the same reason: music spans orders of magnitude, so a linear
    // detector gives one spike and a flat line.
    const db = 20 * Math.log10(amp + 1e-6);
    let x = clamp01((db + 60) / 60);
    if (gate > 0 && x < gate) x = 0;

    y = y + (x - y) * (x > y ? aA : aR);
    out[f] = clamp01(y);
  }

  if (normalize) {
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const v = out[i] ?? 0;
      if (v > peak) peak = v;
    }
    if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = clamp01((out[i] ?? 0) / peak);
  }
  return out;
}

// ── Mapping ─────────────────────────────────────────────────────────

export type EnvelopeCurve = 'linear' | 'easeIn' | 'easeOut' | 'sCurve' | 'invert';

export const CURVES: readonly EnvelopeCurve[] = ['linear', 'easeIn', 'easeOut', 'sCurve', 'invert'];

export const CURVE_LABELS: Readonly<Record<EnvelopeCurve, string>> = {
  linear: 'Linear',
  easeIn: 'Ease in (soft quiet)',
  easeOut: 'Ease out (punchy)',
  sCurve: 'S-curve',
  invert: 'Invert',
};

/** Shape a 0..1 envelope value. Every curve maps 0..1 → 0..1. */
export function applyCurve(t: number, curve: EnvelopeCurve): number {
  const u = clamp01(t);
  switch (curve) {
    case 'easeIn': return u * u;
    case 'easeOut': return 1 - (1 - u) * (1 - u);
    case 'sCurve': return u * u * (3 - 2 * u);
    case 'invert': return 1 - u;
    default: return u;
  }
}

export interface MapOptions {
  min: number;
  max: number;
  curve?: EnvelopeCurve;
  /** Centred box smooth over this many FRAMES (1 = off). */
  smoothFrames?: number;
}

/**
 * Envelope → the property's own units.
 *
 * The output is guaranteed to lie between `min` and `max` inclusive (in either
 * order — `min > max` is a legitimate way to spell "louder means smaller", and
 * inverting the range is not the same gesture as the `invert` curve, which
 * inverts the SHAPE before the range is applied).
 */
export function mapEnvelope(env: Float32Array | readonly number[], opts: MapOptions): Float32Array {
  const src = env instanceof Float32Array ? env : Float32Array.from(env);
  const out = new Float32Array(src.length);
  if (src.length === 0) return out;

  const curve = opts.curve ?? 'linear';
  const min = Number.isFinite(opts.min) ? opts.min : 0;
  const max = Number.isFinite(opts.max) ? opts.max : 1;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);

  // Running-sum box smooth — O(n) rather than O(n·w), which matters at the
  // thousands of frames a three-minute track produces.
  const w = Math.max(1, Math.floor(opts.smoothFrames ?? 1));
  let smoothed = src;
  if (w > 1) {
    const half = Math.floor(w / 2);
    smoothed = new Float32Array(src.length);
    let sum = 0;
    let a = 0;
    let b = -1;
    for (let i = 0; i < src.length; i++) {
      const wantLo = Math.max(0, i - half);
      const wantHi = Math.min(src.length - 1, i + half);
      while (b < wantHi) sum += src[++b] ?? 0;
      while (a < wantLo) sum -= src[a++] ?? 0;
      smoothed[i] = sum / (b - a + 1);
    }
  }

  for (let i = 0; i < smoothed.length; i++) {
    const v = min + (max - min) * applyCurve(smoothed[i] ?? 0, curve);
    out[i] = v < lo ? lo : v > hi ? hi : v;
  }
  return out;
}

// ── The driver record ───────────────────────────────────────────────

/** The comp's whole mixdown, as a source. */
export const MIX_SOURCE = 'mix';

export interface AudioDriver {
  /** Animation prop path this drives (`scale`, `opacity`, `effect.fx_1.radius`…). */
  prop: string;
  /** An audio layer's node id, or {@link MIX_SOURCE} for the comp mixdown. */
  sourceLayerId: string;
  band: AudioBand;
  attackMs: number;
  releaseMs: number;
  gate: number;
  min: number;
  max: number;
  curve: EnvelopeCurve;
  smoothFrames: number;
  normalize: boolean;
  /**
   * What the user ASKED for. `'expression'` is honoured only when
   * {@link audioDriverExpression} can express the parameters; otherwise the
   * apply bakes and reports which it did.
   */
  mode: 'expression' | 'baked';
}

export function defaultAudioDriver(prop: string): AudioDriver {
  return {
    prop,
    sourceLayerId: MIX_SOURCE,
    band: 'full',
    attackMs: 10,
    releaseMs: 120,
    gate: 0,
    min: 0,
    max: 100,
    curve: 'linear',
    smoothFrames: 1,
    normalize: true,
    mode: 'baked',
  };
}

/** Hidden prop holding `{ [prop]: AudioDriver }` on the node's Transform. */
export const AUDIO_DRIVER_PROP = '__audioDriver';

/**
 * Where the map lives: the layer's Transform component, which every node has.
 * (A `__`-prefixed prop, so the generic NodeInspector's property list skips it
 * — the same convention `__animators` uses on text layers.)
 */
function driverHost(node: SceneNode): SceneNode['components'][number] | undefined {
  return node.components.find((c) => c.type === 'Transform') ?? node.components[0];
}

function normalizeDriver(raw: unknown, fallbackProp: string): AudioDriver | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<AudioDriver>;
  const base = defaultAudioDriver(typeof d.prop === 'string' ? d.prop : fallbackProp);
  const band: AudioBand =
    d.band === 'low' || d.band === 'mid' || d.band === 'high' || d.band === 'full'
      ? d.band
      : d.band && typeof d.band === 'object' && typeof d.band.lo === 'number' && typeof d.band.hi === 'number'
        ? { lo: d.band.lo, hi: d.band.hi }
        : base.band;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  return {
    prop: base.prop,
    sourceLayerId: typeof d.sourceLayerId === 'string' ? d.sourceLayerId : base.sourceLayerId,
    band,
    attackMs: num(d.attackMs, base.attackMs),
    releaseMs: num(d.releaseMs, base.releaseMs),
    gate: clamp01(num(d.gate, base.gate)),
    min: num(d.min, base.min),
    max: num(d.max, base.max),
    curve: CURVES.includes(d.curve as EnvelopeCurve) ? (d.curve as EnvelopeCurve) : base.curve,
    smoothFrames: Math.max(1, Math.floor(num(d.smoothFrames, base.smoothFrames))),
    normalize: d.normalize !== false,
    mode: d.mode === 'expression' ? 'expression' : 'baked',
  };
}

/** Every driver remembered on a node, keyed by prop path. */
export function readAudioDrivers(node: SceneNode): Record<string, AudioDriver> {
  const raw = driverHost(node)?.props[AUDIO_DRIVER_PROP];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, AudioDriver> = {};
  for (const [prop, value] of Object.entries(raw as Record<string, unknown>)) {
    const d = normalizeDriver(value, prop);
    if (d) out[prop] = { ...d, prop };
  }
  return out;
}

/** The driver on one property, or null. */
export function readAudioDriver(node: SceneNode, prop: string): AudioDriver | null {
  return readAudioDrivers(node)[prop] ?? null;
}

/** Remember (or replace) a driver on the node. */
export function writeAudioDriver(nodeId: string, driver: AudioDriver): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const host = node ? driverHost(node) : undefined;
  if (!node || !host) return;
  const next = { ...readAudioDrivers(node), [driver.prop]: driver };
  defaultSceneGraph.writeProp(nodeId, host.id, AUDIO_DRIVER_PROP, next);
  bumpScene();
}

/** Forget a driver (does NOT touch the keyframes it wrote). */
export function forgetAudioDriver(nodeId: string, prop: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const host = node ? driverHost(node) : undefined;
  if (!node || !host) return;
  const next = { ...readAudioDrivers(node) };
  delete next[prop];
  defaultSceneGraph.writeProp(nodeId, host.id, AUDIO_DRIVER_PROP, next);
  bumpScene();
}

// ── Expression mode ─────────────────────────────────────────────────

/** Format a number for embedding in expression source (negatives parenthesised). */
function num(v: number): string {
  const s = String(Math.round(v * 1e6) / 1e6);
  return v < 0 ? `(${s})` : s;
}

/**
 * Why a driver cannot be an expression, in one sentence, or null when it can.
 *
 * Returned rather than thrown so the panel can SHOW the reason next to the
 * mode switch. "It silently baked instead" is the version of this feature that
 * generates support questions.
 */
export function expressionBlocker(d: AudioDriver): string | null {
  if (d.sourceLayerId !== MIX_SOURCE) {
    return 'the `audio` identifier reads the whole comp’s live level, so it cannot follow one layer';
  }
  if (d.band !== 'full') return '`audio` is broadband — a band needs the baked FFT';
  if (d.attackMs > 0 || d.releaseMs > 0) {
    return 'attack/release remembers the previous frame, which an expression cannot';
  }
  if (d.smoothFrames > 1) return 'smoothing reads neighbouring frames, which an expression cannot';
  if (d.normalize) return 'normalising needs the clip’s peak, which is only known after analysis';
  return null;
}

/** True when {@link audioDriverExpression} can express this driver exactly. */
export function canExpressDriver(d: AudioDriver): boolean {
  return expressionBlocker(d) === null;
}

/**
 * The driver as expression source, or null when it cannot be expressed.
 *
 * Only the gate, the curve and the output range survive the translation — see
 * {@link expressionBlocker} for the rest and the module header for why.
 */
export function audioDriverExpression(d: AudioDriver): string | null {
  if (!canExpressDriver(d)) return null;
  const g = d.gate > 0
    ? `clamp((audio - ${num(d.gate)}) / ${num(1 - d.gate)}, 0, 1)`
    : 'clamp(audio, 0, 1)';
  let shaped: string;
  switch (d.curve) {
    case 'easeIn': shaped = `Math.pow(${g}, 2)`; break;
    case 'easeOut': shaped = `1 - Math.pow(1 - ${g}, 2)`; break;
    case 'sCurve': shaped = `Math.pow(${g}, 2) * (3 - 2 * ${g})`; break;
    case 'invert': shaped = `1 - ${g}`; break;
    default: shaped = g;
  }
  return `${num(d.min)} + ${num(d.max - d.min)} * (${shaped})`;
}

// ── Resolving the source ────────────────────────────────────────────

/** The minimal AudioBuffer surface this module reads (so tests need no DOM). */
export interface DriverBuffer {
  sampleRate: number;
  length: number;
  duration: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Average the channels down to one — the detector is mono by nature. */
export function mixToMono(buffer: DriverBuffer): Float32Array {
  const n = buffer.length;
  const chans = Math.max(1, buffer.numberOfChannels);
  const out = new Float32Array(n);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(Math.min(c, chans - 1));
    for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + (data[i] ?? 0);
  }
  if (chans > 1) for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) / chans;
  return out;
}

/**
 * A source layer's samples laid out on COMPOSITION time over `[start, end)`.
 *
 * The envelope is indexed by comp frame, and the buffer is indexed by file
 * position; a layer that starts at 4s and is trimmed 10s into the file relates
 * the two, and nothing else does. Baking straight from the buffer — the
 * obvious version — pins the whole envelope to comp time 0, which looks right
 * for the one project where the audio starts at the top and is wrong for
 * every other one.
 *
 * Gaps (before the bar, after it, between split clips) are silence, which is
 * the truthful answer: nothing is playing there.
 */
export function alignSamplesToRange(
  channel: Float32Array,
  sampleRate: number,
  timings: ReadonlyArray<{ startSec: number; inSec: number; outSec: number }>,
  startSec: number,
  endSec: number,
): Float32Array {
  const length = Math.max(0, Math.ceil((endSec - startSec) * sampleRate));
  const out = new Float32Array(length);
  if (length === 0) return out;
  const spans = timings.length > 0
    ? timings
    : [{ startSec: 0, inSec: 0, outSec: channel.length / sampleRate }];

  for (const t of spans) {
    const barLen = Math.max(0, t.outSec - t.inSec);
    if (barLen <= 0) continue;
    const from = Math.max(startSec, t.startSec);
    const to = Math.min(endSec, t.startSec + barLen);
    if (to <= from) continue;
    const first = Math.floor((from - startSec) * sampleRate);
    const count = Math.ceil((to - from) * sampleRate);
    const srcBase = (t.inSec + (from - t.startSec)) * sampleRate;
    for (let i = 0; i < count; i++) {
      const di = first + i;
      if (di < 0 || di >= length) continue;
      const si = Math.round(srcBase + i);
      if (si < 0 || si >= channel.length) continue;
      out[di] = channel[si] ?? 0;
    }
  }
  return out;
}

/** Test seam for the comp mixdown, which needs an OfflineAudioContext. */
let mixdown: (startSec: number, endSec: number) => Promise<DriverBuffer | null> =
  (a, b) => mixdownBuffer(a, b) as Promise<DriverBuffer | null>;
export function __setDriverMixdownForTest(
  fn?: (startSec: number, endSec: number) => Promise<DriverBuffer | null>,
): void {
  mixdown = fn ?? ((a, b) => mixdownBuffer(a, b) as Promise<DriverBuffer | null>);
}

/** Comp-aligned mono samples for a driver's source over `[start, end)`. */
export async function driverSamples(
  d: AudioDriver,
  startSec: number,
  endSec: number,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  if (d.sourceLayerId === MIX_SOURCE) {
    const buf = await mixdown(startSec, endSec);
    if (!buf) return null;
    // Already laid out on the export timeline starting at `startSec`.
    return { samples: mixToMono(buf), sampleRate: buf.sampleRate };
  }
  const buf = (await ensureAudioBuffer(d.sourceLayerId)) as DriverBuffer | null;
  if (!buf) return null;
  const mono = mixToMono(buf);
  const timings = readAudioClipTimings(d.sourceLayerId);
  return {
    samples: alignSamplesToRange(mono, buf.sampleRate, timings, startSec, endSec),
    sampleRate: buf.sampleRate,
  };
}

// ── Range, preview, apply ───────────────────────────────────────────

/** The bake range: the work area when one is set, else the whole comp. */
export function driverRange(): { start: number; end: number; fps: number } {
  const controller = getTimelineController();
  const fps = controller.fps || 30;
  const wa = controller.getWorkArea();
  if (wa && wa.end > wa.start) return { start: wa.start, end: wa.end, fps };
  return { start: 0, end: Math.max(1 / fps, controller.durationSeconds || 0), fps };
}

export interface DriverEnvelope {
  /** Detector output, 0..1 per frame. What the preview strip draws. */
  raw: Float32Array;
  /** `raw` through the curve and range — the values a bake would write. */
  mapped: Float32Array;
  start: number;
  end: number;
  fps: number;
}

/**
 * Compute a driver's envelope without writing anything. The panel's preview
 * strip and {@link applyAudioDriver} both go through here, so what is drawn is
 * what would be baked — not an approximation of it.
 */
export async function computeDriverEnvelope(
  d: AudioDriver,
  range = driverRange(),
): Promise<DriverEnvelope | null> {
  const src = await driverSamples(d, range.start, range.end);
  if (!src) return null;
  const raw = analyseAudioEnvelope(src.samples, src.sampleRate, range.fps, {
    band: d.band,
    attackMs: d.attackMs,
    releaseMs: d.releaseMs,
    gate: d.gate,
    normalize: d.normalize,
  });
  const mapped = mapEnvelope(raw, {
    min: d.min,
    max: d.max,
    curve: d.curve,
    smoothFrames: d.smoothFrames,
  });
  return { raw, mapped, start: range.start, end: range.end, fps: range.fps };
}

export interface ApplyDriverResult {
  /** What actually happened — not necessarily `driver.mode`. */
  mode: 'expression' | 'baked';
  /** Keyframes written (0 in expression mode). */
  keyframes: number;
  /** Why expression mode was refused, when it was asked for and declined. */
  fellBackBecause?: string;
  /** Set when nothing could be done: no decoded audio in the range. */
  error?: string;
}

/**
 * Apply a driver to its property: one expression, or one bake, as ONE undo
 * entry — and remember the parameters either way so the panel can re-bake.
 *
 * Baking clears any expression on the property first: leaving a stale
 * `value + audio * 200` on top of a freshly baked track would multiply the two
 * and produce motion that matches neither the preview nor the panel.
 */
export async function applyAudioDriver(nodeId: string, d: AudioDriver): Promise<ApplyDriverResult> {
  const blocker = d.mode === 'expression' ? expressionBlocker(d) : null;
  const expr = d.mode === 'expression' ? audioDriverExpression(d) : null;

  if (expr) {
    writeAudioDriver(nodeId, { ...d, mode: 'expression' });
    runAnimEdit('Audio driver', () => {
      defaultAnimation.batch(() => {
        // The expression IS the value; a leftover baked track underneath it is
        // dead weight that reappears the moment the expression is disabled.
        defaultAnimation.removeTrack(nodeId, d.prop);
        defaultAnimation.setExpression(nodeId, d.prop, expr);
      });
    });
    return { mode: 'expression', keyframes: 0 };
  }

  const range = driverRange();
  const env = await computeDriverEnvelope(d, range);
  if (!env || env.mapped.length === 0) {
    return {
      mode: 'baked',
      keyframes: 0,
      ...(blocker ? { fellBackBecause: blocker } : {}),
      error: d.sourceLayerId === MIX_SOURCE
        ? 'No audible audio in this range — import audio, or check the layer is not muted.'
        : 'That layer’s audio has not decoded (or has no sound in this range).',
    };
  }

  const seen = new Set<number>();
  const keyframes: Keyframe[] = [];
  for (let f = 0; f < env.mapped.length; f++) {
    const compTime = range.start + f / range.fps;
    if (compTime > range.end + 1e-9) break;
    // The canonical keyframe axis, so the track survives trimming, sliding and
    // time-stretching the target layer afterwards.
    const t = compToKeyframeTime(nodeId, compTime, d.prop);
    if (seen.has(t)) continue;
    seen.add(t);
    keyframes.push({ t, value: Math.round((env.mapped[f] ?? 0) * 1000) / 1000, easing: 'linear' });
  }
  if (keyframes.length === 0) {
    return { mode: 'baked', keyframes: 0, error: 'Nothing to write in this range.' };
  }

  writeAudioDriver(nodeId, { ...d, mode: 'baked' });
  runAnimEdit('Audio driver', () => {
    defaultAnimation.batch(() => {
      defaultAnimation.setExpression(nodeId, d.prop, '');
      defaultAnimation.setKeyframes(nodeId, d.prop, keyframes);
    });
  });
  return {
    mode: 'baked',
    keyframes: keyframes.length,
    ...(blocker ? { fellBackBecause: blocker } : {}),
  };
}

/**
 * Remove a driver: forget the parameters AND undo what it wrote (the baked
 * track or the generated expression), in one undo entry.
 */
export function removeAudioDriver(nodeId: string, prop: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const d = node ? readAudioDriver(node, prop) : null;
  forgetAudioDriver(nodeId, prop);
  if (!d) return;
  runAnimEdit('Remove audio driver', () => {
    defaultAnimation.batch(() => {
      if (d.mode === 'expression') defaultAnimation.setExpression(nodeId, prop, '');
      else defaultAnimation.removeTrack(nodeId, prop);
    });
  });
}
