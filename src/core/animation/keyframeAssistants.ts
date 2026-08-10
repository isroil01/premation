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
 * The track transforms are pure functions (tested); the exported actions wrap
 * them in runAnimEdit so undo restores the exact previous keyframes.
 */

import { defaultAnimation, EASY_EASE_BEZIER, EASY_EASE_OUT_BEZIER, EASY_EASE_IN_BEZIER, type AnimationEngine } from '@motion/animation';
import { parseKeyframeId, expandKeyframeProp, setDataKeyframeEasing } from '@motion/animation';
import type { BezierHandles, EasingKind, PropPath } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import type { PresetTrack } from '@core/animation/animationPresets';
import {
  addTextAnimator,
  updateAnimator,
  updateSelector,
  selectorPropPath,
  hasTextComponent,
} from '@core/text/textAnimators';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';

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

// ── Engine actions (one undoable command each) ───────────────────────

function currentTracks(nodeId: string, engine: AnimationEngine): PresetTrack[] {
  const out: PresetTrack[] = [];
  for (const prop of engine.animatedProps(nodeId)) {
    const kfs = engine.getTrackKeyframes(nodeId, prop);
    if (kfs && kfs.length) out.push({ prop, keyframes: kfs });
  }
  return out;
}

function writeTracks(nodeId: string, tracks: ReadonlyArray<PresetTrack>, engine: AnimationEngine): void {
  for (const t of tracks) engine.setTrackKeyframes(nodeId, t.prop, [...t.keyframes]);
}

/** Mirror the layer's animation in time. Returns false when nothing animated. */
export function timeReverseKeyframes(nodeId: string, engine: AnimationEngine = defaultAnimation): boolean {
  const tracks = currentTracks(nodeId, engine);
  if (!tracks.length) return false;
  const reversed = reverseTracks(tracks);
  runAnimEdit('Time-reverse keyframes', () => writeTracks(nodeId, reversed, engine));
  return true;
}

/**
 * Bounce settings. AE's own bounce is an expression, not a preset, so these are
 * the three knobs every version of that expression exposes.
 */
export interface BounceOptions {
  /** How many rebounds to add after the original landing. */
  bounces: number;
  /** Fraction of the previous overshoot each rebound keeps, 0..1. */
  decay: number;
  /** Overshoot of the FIRST rebound as a fraction of the last segment's
   *  travel. ~0.3 lands firmly, ~0.6 reads rubbery. */
  elasticity: number;
}

export const DEFAULT_BOUNCE: BounceOptions = { bounces: 3, decay: 0.5, elasticity: 0.35 };

/**
 * Append a decaying bounce after each track's LAST keyframe.
 *
 * ── Why this is an assistant and not an easing preset ────────────────
 * A cubic-bezier is one curve with at most a single overshoot; a bounce is N
 * overshoots of shrinking amplitude, which no bezier can express. That is why
 * `BOUNCE_EASE` in animationPresets.ts — commented "Elastic bounce" — is really
 * an ease-out-back. Generating keyframes is the only honest way to do this
 * without reaching for an expression.
 *
 * Each rebound overshoots PAST the landing value and returns to it, with the
 * amplitude and the duration BOTH scaled by `decay`, so the bounces get smaller
 * and faster together. Scaling only the amplitude is the classic mistake: it
 * reads as a wobble rather than as gravity.
 *
 * Pure, so the geometry is testable without a scene. A track with fewer than
 * two keyframes comes back untouched — there is no travel to rebound from.
 */
export function bounceTracks(
  tracks: ReadonlyArray<PresetTrack>,
  opts: BounceOptions = DEFAULT_BOUNCE,
): PresetTrack[] {
  const bounces = Math.max(0, Math.floor(opts.bounces));
  const decay = Math.min(0.95, Math.max(0.05, opts.decay));
  const elasticity = Math.max(0, opts.elasticity);
  if (bounces === 0 || elasticity === 0) return tracks.map((t) => ({ ...t }));

  return tracks.map((track) => {
    const keys = track.keyframes;
    if (keys.length < 2) return { ...track };

    const last = keys[keys.length - 1]!;
    const prev = keys[keys.length - 2]!;
    const travel = last.value - prev.value;
    const segment = last.t - prev.t;
    // A hold at the end has nothing to rebound from, and a zero-length final
    // segment would scale the timing by nothing.
    if (travel === 0 || segment <= 0) return { ...track };

    // The rebound goes back the way it came: land after a fall and you
    // overshoot upward, so the sign is opposite to the travel.
    const dir = -Math.sign(travel);
    const out = [...keys];
    let amp = Math.abs(travel) * elasticity;
    let dur = segment * decay;
    let t = last.t;

    for (let i = 0; i < bounces; i++) {
      t += dur / 2; // up to the peak…
      out.push({ t, value: last.value + dir * amp, easing: 'bezier', bezier: EASY_EASE_OUT_BEZIER });
      t += dur / 2; // …and back down to the landing value.
      out.push({ t, value: last.value, easing: 'bezier', bezier: EASY_EASE_IN_BEZIER });
      amp *= decay;
      dur *= decay;
    }
    return { ...track, keyframes: out };
  });
}

/**
 * Add a bounce to the end of the layer's animation. False when nothing is
 * animated, or when no track had anything to bounce off.
 */
export function bounceKeyframes(
  nodeId: string,
  opts: BounceOptions = DEFAULT_BOUNCE,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  const tracks = currentTracks(nodeId, engine);
  if (!tracks.length) return false;
  const bounced = bounceTracks(tracks, opts);
  // Every track unchanged means every one was a hold or a single key. Reporting
  // success there would push an empty entry onto the undo stack.
  const changed = bounced.some((t, i) => t.keyframes.length !== tracks[i]!.keyframes.length);
  if (!changed) return false;
  runAnimEdit('Bounce keyframes', () => writeTracks(nodeId, bounced, engine));
  return true;
}

/** Easy-ease every keyframe on the layer. Returns false when nothing animated. */
export function easyEaseAll(nodeId: string, engine: AnimationEngine = defaultAnimation): boolean {
  const tracks = currentTracks(nodeId, engine);
  if (!tracks.length) return false;
  const eased = easeTracks(tracks);
  runAnimEdit('Easy ease all keyframes', () => writeTracks(nodeId, eased, engine));
  return true;
}

/**
 * Stagger the selected layers' animations: layer i starts `intervalSec` after
 * layer i-1 (the first stays put). One undoable command for the whole set.
 */
export function sequenceLayers(
  nodeIds: ReadonlyArray<string>,
  intervalSec: number,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  const animated = nodeIds.filter((id) => currentTracks(id, engine).length > 0);
  if (animated.length < 2) return false;
  const shifted = animated.map((id, i) => ({
    id,
    tracks: shiftTracks(currentTracks(id, engine), i * intervalSec),
  }));
  runAnimEdit('Sequence layers', () => {
    for (const s of shifted) writeTracks(s.id, s.tracks, engine);
  });
  return true;
}

/**
 * Typewriter — one click builds a whole rig on a text layer: adds a text
 * animator (characters hidden by a full-range opacity-0 selector) and
 * keyframes the selector's START 0→100 so characters pop in one at a time.
 */
export function applyTypewriter(
  nodeId: string,
  atTime: number,
  durationSec = 1.5,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasTextComponent(node)) return false;
  // Reuse the layer's existing animators; append a dedicated one for the rig.
  const index = addTextAnimator(nodeId);
  updateAnimator(nodeId, index, { opacity: 0 });
  // Hard square edges: a typewriter pops characters on, it does not fade them.
  updateSelector(nodeId, index, 0, {
    basedOn: 'characters', shape: 'square', smoothness: 0, start: 0, end: 100,
  });
  const path = selectorPropPath(index, 0, 'start');
  runAnimEdit('Typewriter', () => {
    engine.setKeyframe(nodeId, path, atTime, 0, 'linear');
    engine.setKeyframe(nodeId, path, atTime + durationSec, 100, 'linear');
  });
  return true;
}

export function applyBounceInWords(
  nodeId: string,
  atTime: number,
  durationSec = 1.5,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasTextComponent(node)) return false;
  const index = addTextAnimator(nodeId);
  updateAnimator(nodeId, index, { y: -80, opacity: 0, scale: 50, scaleY: 50 });
  updateSelector(nodeId, index, 0, {
    basedOn: 'words', shape: 'rampDown', start: 0, end: 100,
  });
  const path = selectorPropPath(index, 0, 'offset');
  runAnimEdit('Bounce In Words', () => {
    engine.setKeyframe(nodeId, path, atTime, -100, 'bezier');
    engine.setBezier(nodeId, path, atTime, [0.175, 0.885, 0.32, 1.275]);
    engine.setKeyframe(nodeId, path, atTime + durationSec, 100, 'linear');
  });
  return true;
}

export function applySpinFadeCharacters(
  nodeId: string,
  atTime: number,
  durationSec = 1.5,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasTextComponent(node)) return false;
  const index = addTextAnimator(nodeId);
  updateAnimator(nodeId, index, { rotation: 90, opacity: 0, scale: 150, scaleY: 150 });
  updateSelector(nodeId, index, 0, {
    basedOn: 'characters', shape: 'rampDown', start: 0, end: 100,
  });
  const path = selectorPropPath(index, 0, 'offset');
  runAnimEdit('Spin & Fade Characters', () => {
    engine.setKeyframe(nodeId, path, atTime, -100, 'bezier');
    engine.setBezier(nodeId, path, atTime, [0.16, 1, 0.3, 1]);
    engine.setKeyframe(nodeId, path, atTime + durationSec, 100, 'linear');
  });
  return true;
}

export function applyTrackingReveal(
  nodeId: string,
  atTime: number,
  durationSec = 1.5,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasTextComponent(node)) return false;
  const index = addTextAnimator(nodeId);
  updateAnimator(nodeId, index, { tracking: 40, opacity: 0 });
  updateSelector(nodeId, index, 0, {
    basedOn: 'characters', shape: 'square', start: 0, end: 100,
  });
  const path = selectorPropPath(index, 0, 'start');
  runAnimEdit('Tracking Reveal', () => {
    engine.setKeyframe(nodeId, path, atTime, 0, 'bezier');
    engine.setBezier(nodeId, path, atTime, [0.4, 0, 0.2, 1]);
    engine.setKeyframe(nodeId, path, atTime + durationSec, 100, 'linear');
  });
  return true;
}

/**
 * Apply a named easing preset to a set of keyframes (identified by their
 * compound ID `nodeId::prop::t` from `makeKeyframeId` — decode with
 * `parseKeyframeId`, never by hand).
 *
 *   Linear  → easing: 'linear'
 *   Ease    → easing: 'bezier', EASY_EASE_BEZIER     (33%/33% in+out)
 *   EaseIn  → easing: 'bezier', EASY_EASE_IN_BEZIER  (strong in only)
 *   EaseOut → easing: 'bezier', EASY_EASE_OUT_BEZIER (strong out only)
 *   Hold    → easing: 'hold'   (step function)
 */
export type EasingPreset = 'Linear' | 'Ease' | 'EaseIn' | 'EaseOut' | 'Hold';

/** The (easing, bezier) a preset resolves to — shared by scalar and data paths. */
function presetCurve(preset: EasingPreset): { easing: EasingKind; bezier?: BezierHandles } {
  switch (preset) {
    case 'Linear': return { easing: 'linear' };
    case 'Ease': return { easing: 'bezier', bezier: EASY_EASE_BEZIER };
    case 'EaseIn': return { easing: 'bezier', bezier: EASY_EASE_IN_BEZIER };
    case 'EaseOut': return { easing: 'bezier', bezier: EASY_EASE_OUT_BEZIER };
    case 'Hold': return { easing: 'hold' };
  }
}

/**
 * Ease a DATA-track keyframe (points / gradient stops / number / text) at `t`.
 * Returns false when this node+prop is not a data track, so the caller can fall
 * through to the scalar path.
 *
 * Data tracks were unreachable from Easy Ease / F9: this function only ever
 * walked `getTrackKeyframes`, which is the scalar store. The SAMPLER has
 * honoured `easing`/`bezier` on a DataKeyframe all along — nothing could author
 * them. That is why puppet pin motion (a `points` data track) read as linear.
 */
function easeDataKeyframe(
  engine: AnimationEngine,
  nodeId: string,
  prop: string,
  t: number,
  preset: EasingPreset,
): boolean {
  const track = engine.getDataTrack(nodeId, prop as PropPath);
  if (!track) return false;
  const { easing, bezier } = presetCurve(preset);
  const keyframes = setDataKeyframeEasing(track.keyframes, t, easing, bezier);
  if (keyframes === track.keyframes) return false; // no keyframe at that time
  engine.setDataTrack(nodeId, prop as PropPath, { ...track, keyframes });
  return true;
}

export function applyEasingToKeyframes(
  kfIds: ReadonlyArray<string>,
  preset: EasingPreset,
  engine: AnimationEngine = defaultAnimation,
): void {
  if (!kfIds.length) return;
  runAnimEdit(`Set keyframe easing: ${preset}`, () => {
    for (const kfId of kfIds) {
      const ref = parseKeyframeId(kfId);
      if (!ref) continue;
      const { nodeId, t } = ref;
      // A selected Position keyframe is the merged x/y/z row — ease all three.
      for (const prop of expandKeyframeProp(ref.prop)) {
        // Data tracks first: a data prop has no scalar keyframes, so the scalar
        // lookup below would silently `continue` and F9 would do nothing.
        if (easeDataKeyframe(engine, nodeId, prop, t, preset)) continue;

        const kfs = engine.getTrackKeyframes(nodeId, prop);
        const kf = kfs?.find((k) => Math.abs(k.t - t) < 1e-6);
        if (!kf) continue;
        const value = kf.value;
        const { easing, bezier } = presetCurve(preset);
        // Scalar tracks spell hold as 'step'; the data sampler accepts either.
        engine.setKeyframe(nodeId, prop, t, value, easing === 'hold' ? 'step' : easing);
        if (bezier) engine.setBezier(nodeId, prop, t, bezier);
      }
    }
  });
}

/**
 * Apply custom asymmetric Bezier influence to a set of keyframes.
 * inflOut affects the outgoing curve (x1), inflIn affects the incoming curve (x2).
 */
export function applyVelocityToKeyframes(
  kfIds: ReadonlyArray<string>,
  inflOut: number,
  inflIn: number,
  engine: AnimationEngine = defaultAnimation,
): void {
  if (!kfIds.length) return;
  const outVal = Math.max(0.01, Math.min(0.99, inflOut / 100));
  const inVal = Math.max(0.01, Math.min(0.99, inflIn / 100));
  const bezier: [number, number, number, number] = [outVal, 0, 1 - inVal, 1];
  runAnimEdit(`Set keyframe velocity (Out: ${inflOut}%, In: ${inflIn}%)`, () => {
    for (const kfId of kfIds) {
      const ref = parseKeyframeId(kfId);
      if (!ref) continue;
      const { nodeId, t } = ref;
      for (const prop of expandKeyframeProp(ref.prop)) {
        const kfs = engine.getTrackKeyframes(nodeId, prop);
        const kf = kfs?.find((k) => Math.abs(k.t - t) < 1e-6);
        if (!kf) continue;
        engine.setKeyframe(nodeId, prop, t, kf.value, 'bezier');
        engine.setBezier(nodeId, prop, t, bezier);
      }
    }
  });
}
