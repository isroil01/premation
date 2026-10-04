/**
 * Keyframe assistants — AE's "big animation logic" actions. Each operates on a
 * layer's existing keyframes (or builds new ones) and applies as ONE undoable
 * command through the Prompt-2 command path.
 *
 *   • Easy Ease All — easy-ease every keyframe on the layer
 *   • Time-Reverse — mirror all keyframes within their span
 *   • Stretch — scale keyframe timing by a factor
 *   • Sequence Layers — stagger selected layers' animations in time
 *   • Typewriter (text) — builds a text animator + keyframes so characters
 *                            appear one-by-one (a whole rig from one click)
 *
 * Bounce is NOT here: it grew parameters, presets, a from-zero mode and
 * squash & stretch, which is a panel's worth of surface rather than one action.
 * It lives in `bounce.ts` and its home in the UI is the Graph panel.
 *
 * The track transforms are pure functions (tested); the exported actions wrap
 * them in runAnimEdit so undo restores the exact previous keyframes.
 */

import {  EASY_EASE_BEZIER, EASY_EASE_OUT_BEZIER, EASY_EASE_IN_BEZIER } from '@motion/animation';
import type { BezierHandles, EasingKind, Keyframe,  PropertyTrack } from '@motion/animation';
import { sampleTrack, smoothTrackTangents } from '@motion/animation';
import type { PresetTrack } from '@core/animation/animationPresets';
import { easePresetById, type EasePresetId } from '@core/animation/easePresets';

// ── Pure track transforms (the tested core) ──────────────────────────

/** Overall [min,max] keyframe time across tracks (null when empty). */
export function trackSpan(tracks: ReadonlyArray<PresetTrack>): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const t of tracks) {
    for (const k of t.keyframes) {
      if (k.t < min) min = k.t;
      if (k.t > max) max = k.t;
    }
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** Mirror every keyframe time within the tracks' overall span. Pure. */
export function reverseTracks(tracks: ReadonlyArray<PresetTrack>): PresetTrack[] {
  const span = trackSpan(tracks);
  if (!span) return [...tracks];
  return tracks.map((t) => ({
    prop: t.prop,
    keyframes: t.keyframes
      .map((k) => ({ ...k, t: span.min + span.max - k.t }))
      .sort((a, b) => a.t - b.t),
  }));
}

/** Easy-ease every keyframe (bezier with the standard 33% influence). Pure. */
export function easeTracks(tracks: ReadonlyArray<PresetTrack>): PresetTrack[] {
  return tracks.map((t) => ({
    prop: t.prop,
    keyframes: t.keyframes.map((k) => ({ ...k, easing: 'bezier' as const, bezier: EASY_EASE_BEZIER })),
  }));
}

/** Scale keyframe timing by `factor` around the tracks' start. Pure. */
export function stretchTracks(tracks: ReadonlyArray<PresetTrack>, factor: number): PresetTrack[] {
  const span = trackSpan(tracks);
  if (!span || factor <= 0) return [...tracks];
  return tracks.map((t) => ({
    prop: t.prop,
    keyframes: t.keyframes.map((k) => ({ ...k, t: span.min + (k.t - span.min) * factor })),
  }));
}

/** Shift all keyframes by `dt`. Pure. */
export function shiftTracks(tracks: ReadonlyArray<PresetTrack>, dt: number): PresetTrack[] {
  return tracks.map((t) => ({
    prop: t.prop,
    keyframes: t.keyframes.map((k) => ({ ...k, t: k.t + dt })),
  }));
}

// ── The Smoother ─────────────────────────────────────────────────────

/**
 * AE's The Smoother: replace a dense, noisy track with the fewest keyframes
 * that keep the curve within `tolerance` (VALUE units) of the original, then
 * give the survivors smooth Catmull-Rom tangents. The main customers are baked
 * tracks — motion sketch, tracking, audio keyframes, expression bakes — where
 * hundreds of per-frame keys make the graph uneditable.
 *
 * Simplification is Douglas-Peucker measured as VERTICAL (value) deviation
 * from the chord, not perpendicular distance: t and value have different units
 * and a perpendicular metric would change meaning with the graph's zoom.
 * Endpoints always survive. Pure.
 */
export function smoothTrackKeyframes(kfs: ReadonlyArray<Keyframe>, tolerance: number): Keyframe[] {
  if (kfs.length < 3 || !(tolerance > 0)) return kfs.map((k) => ({ ...k }));
  const keep = new Array<boolean>(kfs.length).fill(false);
  keep[0] = true;
  keep[kfs.length - 1] = true;
  const rdp = (i0: number, i1: number): void => {
    if (i1 <= i0 + 1) return;
    const a = kfs[i0]!;
    const b = kfs[i1]!;
    const span = b.t - a.t;
    let maxD = -1;
    let maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const f = span > 0 ? (kfs[i]!.t - a.t) / span : 0;
      const chord = a.value + (b.value - a.value) * f;
      const d = Math.abs(kfs[i]!.value - chord);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolerance && maxI > 0) {
      keep[maxI] = true;
      rdp(i0, maxI);
      rdp(maxI, i1);
    }
  };
  rdp(0, kfs.length - 1);
  // Survivors restart with clean interpolation: stale easing/bezier authored
  // for a neighbour that no longer exists would kink the simplified curve.
  const survivors = kfs
    .filter((_, i) => keep[i])
    .map((k) => ({ t: k.t, value: k.value }));
  return smoothTrackTangents(survivors);
}

/** Smoother result summary, for the command's notification. */
export interface SmootherResult { tracks: number; before: number; after: number }

// ── The Wiggler ──────────────────────────────────────────────────────

/** Deterministic hash → [0,1). Seeded per (track, index) so re-running with
 *  the same seed reproduces the exact wobble — the repo-wide randomness rule. */
function wiggleHash01(seed: number, i: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface WigglerOptions {
  /** Wobble keyframes per second. */
  frequency: number;
  /** Peak deviation in the track's value units (px for position). */
  amplitude: number;
  /** Vary for a different wobble; same seed ⇒ same keyframes. */
  seed?: number;
}

/**
 * AE's The Wiggler, baked: insert deterministic noise keyframes at `frequency`
 * between the track's first and last keyframe, each offset from the CURRENT
 * curve value, then smooth the whole set so the wobble is C1 rather than a
 * zig-zag. Authored keyframes keep their times and values (a generated key
 * that would land within a quarter-step of one is skipped); endpoints are
 * never offset, so the motion still departs and lands exactly where it did.
 * Pure.
 */
export function wiggleTrackKeyframes(kfs: ReadonlyArray<Keyframe>, opts: WigglerOptions): Keyframe[] {
  const out = kfs.map((k) => ({ ...k }));
  if (kfs.length < 2 || !(opts.frequency > 0) || !(opts.amplitude !== 0)) return out;
  const t0 = kfs[0]!.t;
  const t1 = kfs[kfs.length - 1]!.t;
  if (!(t1 > t0)) return out;
  const track: PropertyTrack = { nodeId: '', prop: 'x', keyframes: kfs as Keyframe[] };
  const step = 1 / opts.frequency;
  const seed = opts.seed ?? 1;
  for (let n = 1; t0 + n * step < t1 - 1e-9; n++) {
    const tt = t0 + n * step;
    if (out.some((k) => Math.abs(k.t - tt) < step * 0.25)) continue;
    const base = sampleTrack(track, tt);
    if (base === undefined) continue;
    out.push({ t: tt, value: base + (wiggleHash01(seed, n) * 2 - 1) * opts.amplitude });
  }
  out.sort((a, b) => a.t - b.t);
  return smoothTrackTangents(out);
}

/** Wiggler result summary, for the command's notification. */
export interface WigglerResult { tracks: number; added: number }

/**
 * Apply a named easing preset to a set of keyframes, each named by its STORED
 * position (`nodeId`, track, stored `t` — a keyframe selection decodes to these
 * through `selectionStoredRefs`, core/mirror/keySelection.ts).
 *
 *   Linear  → easing: 'linear'
 *   Ease    → easing: 'bezier', EASY_EASE_BEZIER     (33%/33% in+out)
 *   EaseIn  → easing: 'bezier', EASY_EASE_IN_BEZIER  (strong in only)
 *   EaseOut → easing: 'bezier', EASY_EASE_OUT_BEZIER (strong out only)
 *   Hold    → easing: 'hold'   (step function)
 *
 * The five names above are the AE interpolation types. Every OTHER id accepted
 * here is a curve from the ease library (`easePresets.ts`) — `expo-out`,
 * `back-inOut`, … — which resolves to `easing: 'bezier'` with that curve's
 * handles. Both kinds go through this one entry point on purpose: the timeline
 * pills, the F9 chords, the property menu and the Graph panel's curve grid then
 * cannot disagree about what applying an easing means, and all four inherit the
 * data-track and merged-Position handling below for free.
 */
export type EasingPreset = 'Linear' | 'Ease' | 'EaseIn' | 'EaseOut' | 'Hold' | EasePresetId;

/** The (easing, bezier) a preset resolves to — shared by scalar and data paths. */
export function presetCurve(preset: EasingPreset): { easing: EasingKind; bezier?: BezierHandles } {
  switch (preset) {
    case 'Linear': return { easing: 'linear' };
    case 'Ease': return { easing: 'bezier', bezier: EASY_EASE_BEZIER };
    case 'EaseIn': return { easing: 'bezier', bezier: EASY_EASE_IN_BEZIER };
    case 'EaseOut': return { easing: 'bezier', bezier: EASY_EASE_OUT_BEZIER };
    case 'Hold': return { easing: 'hold' };
    default: {
      const curve = easePresetById(preset);
      // Unreachable through the type, but an id can arrive from persisted state
      // or a command registry. Falling back to Easy Ease keeps a stale id from
      // silently writing a LINEAR curve, which reads as "the button did
      // nothing" rather than as the error it is.
      return { easing: 'bezier', bezier: curve?.bezier ?? EASY_EASE_BEZIER };
    }
  }
}

