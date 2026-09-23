/**
 * Time Stretch maths and the non-footage bake — the parts both the legacy
 *  (layerTimeCommands.ts) and the engine's
 *  handler (engine/handlers/layerTime.ts, B3z) run: Hold in
 * Place geometry, the non-footage bake geometry, keyframe retiming and the
 * baked-stretch bookkeeping. Moved out of layerTimeCommands.ts (which imports
 * UI modules) so the engine can use them; layerTimeCommands re-exports every
 * name, so its callers are unchanged.
 */

import { defaultAnimation, type BezierHandles } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { readNodeMaskAnim } from '@core/effects/mask';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SPEED_PROP } from './retime';

/** Same prop names PrecompControl writes — one track, two surfaces. */
const REMAP = 'timeRemap';
const LEGACY_REMAP = 'precompTime';

/** Clamp a stretch percentage to what `layerTime` stores (1…1000, whole %). */
export function clampStretch(percent: number): number {
  return Math.max(1, Math.min(1000, Math.round(percent)));
}

// ── Time Stretch with Hold in Place ─────────────────────────────────────────

export type StretchHold = 'in' | 'current' | 'out';

/** A clip bar in FRAMES (end exclusive), plus the source frame it starts on. */
export interface ClipGeometry {
  start: number;
  duration: number;
  sourceIn: number;
}

/** The comp frame a stretch holds in place, given the layer's span (frames). */
export function holdFrameFor(
  span: { start: number; end: number },
  hold: StretchHold,
  currentFrame: number,
): number {
  if (hold === 'in') return span.start;
  if (hold === 'out') return span.end;
  return currentFrame;
}

/**
 * The bar after changing the stretch from `oldStretch` to `newStretch` %,
 * holding comp frame `holdFrame` in place.
 *
 * The renderer maps comp frame f to source seconds in two steps:
 *   c = (sourceIn + f − start) / fps          (the clip map)
 *   s = a + (c − a) · 100 / stretch           (`layerTime.remapTime`, a = span start)
 *
 * Holding frame H means s(H) is unchanged. With r = new / old, the bar scales
 * about H (start' = H − (H − start)·r, duration' = duration·r) and the clip map
 * must satisfy c'(H) − a = (c(H) − a)·r, which fixes sourceIn'. Keyframes live
 * on the source axis, so they follow automatically — the same composition
 * `compToKeyframeTime` / `keyframeToCompTime` use to place the diamonds.
 *
 * A bar cannot start before frame 0; when it would, the start clamps and
 * sourceIn is recomputed from the clamped start so the held frame still shows
 * the same source frame.
 */
export function stretchClipGeometry(
  clip: ClipGeometry,
  oldStretch: number,
  newStretch: number,
  holdFrame: number,
  fps: number,
  spanStartSec = 0,
  bounded = false,
): ClipGeometry {
  const r = newStretch / (oldStretch > 0 ? oldStretch : 100);
  if (!Number.isFinite(r) || r <= 0 || r === 1) return { ...clip };
  const H = holdFrame;
  const duration = Math.max(1, Math.round(clip.duration * r));
  const start = Math.max(0, Math.round(H - (H - clip.start) * r));
  const c0 = (clip.sourceIn + H - clip.start) / fps;
  const a = spanStartSec;
  let sourceIn = Math.round(fps * (a + (c0 - a) * r) - H + start);
  if (bounded) sourceIn = Math.max(0, sourceIn);
  return { start, duration, sourceIn };
}


// ── The stretch value a layer shows ─────────────────────────────────────────

/** Where a non-footage layer keeps its stretch — bookkeeping only (see `stretchValueOf`). */
const BAKED_STRETCH_KEY = 'bakedStretch';

/**
 * A non-footage layer's current stretch %, signed (−100 = reversed), default
 * 100. Stored on `fx.bakedStretch` — NOT `fx.time.stretch`, which the renderer
 * time-scales by: the bake has already moved the bar, keyframes and markers,
 * so this value only records where the layer stands. It is saved with the
 * scene, restored by undo, and nothing re-applies it on load.
 */
export function readBakedStretch(nodeId: string): number {
  const fx = defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.type === 'fx');
  const v = (fx?.props as Record<string, unknown> | undefined)?.[BAKED_STRETCH_KEY];
  return typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : 100;
}

export function writeBakedStretch(nodeId: string, value: number): void {
  defaultSceneGraph.setFxKey(nodeId, BAKED_STRETCH_KEY, value === 100 ? undefined : value);
  getEventBus().emit('AnimationChanged', { nodeId });
}


// ── Time Stretch on layers with no source ───────────────────────────────────

/**
 * A signed stretch factor, clamped to what the dialog accepts: ±1…1000 %, whole
 * percent. Negative is AE's backwards stretch (−100 % = same length, reversed).
 * Zero and garbage mean "no change" (100).
 */
export function clampSignedStretch(percent: number): number {
  if (!Number.isFinite(percent) || Math.round(percent) === 0) return 100;
  return percent < 0 ? -clampStretch(-percent) : clampStretch(percent);
}

const REMAP_TRACKS: ReadonlySet<string> = new Set([REMAP, LEGACY_REMAP, SPEED_PROP]);

/** A baked stretch: the new bars, and the affine map every keyframe time takes. */
export interface StretchBake {
  bars: ClipGeometry[];
  /** New keyframe time = keyOffset + keyScale · old keyframe time (seconds). */
  keyScale: number;
  keyOffset: number;
  /** Old comp frame → new comp frame (continuous) — how markers move with the bar. */
  place: (frame: number) => number;
}

/**
 * Time Stretch for a layer with no source (solid, shape, text, null, camera,
 * light), which AE implements by scaling the bar AND the keyframes about the
 * Hold in Place frame — there is no footage to play slower.
 *
 * Keyframe k (seconds) shows at comp frame f = D + k·fps on a bar with
 * D = start − sourceIn (the clip map `compToKeyframeTime` inverts). The stretch
 * moves every comp frame to G(f) = H + (f − H)·|r| (plus a shift when the bar
 * would start before frame 0), and a negative factor then mirrors the result
 * within the new bar: F(f) = S + E − G(f). Both are affine in f, so the keyframe
 * map is affine too: k' = keyOffset + sign(r)·|r|·k, fixed by keeping the
 * earliest bar's `sourceIn` (F(D + k·fps) = D' + k'·fps). Every other bar of a
 * split layer takes the `sourceIn` that makes the same k' land at the same F —
 * so the composition of bars and keys is exactly the stretched picture.
 *
 * Bar edges round to whole frames; keyframe times do not, so a key on a
 * sub-frame stays where the maths puts it. Null for no bars or a zero factor.
 */
export function bakeStretchGeometry(
  bars: ReadonlyArray<ClipGeometry>,
  factor: number,
  holdFrame: number,
  fps: number,
): StretchBake | null {
  if (bars.length === 0 || !Number.isFinite(factor) || factor === 0 || !(fps > 0)) return null;
  if (factor === 1) return { bars: bars.map((b) => ({ ...b })), keyScale: 1, keyOffset: 0, place: (f) => f };
  const H = holdFrame;
  const ra = Math.abs(factor);
  const reversed = factor < 0;
  const scaled = bars.map((b) => ({
    start: Math.round(H + (b.start - H) * ra),
    duration: Math.max(1, Math.round(b.duration * ra)),
  }));
  const shift = Math.max(0, -Math.min(...scaled.map((s) => s.start)));
  for (const s of scaled) s.start += shift;
  const S = Math.min(...scaled.map((s) => s.start));
  const E = Math.max(...scaled.map((s) => s.start + s.duration));
  const G = (f: number): number => H + (f - H) * ra + shift;
  const place = (f: number): number => (reversed ? S + E - G(f) : G(f));
  const starts = scaled.map((s) => (reversed ? S + E - (s.start + s.duration) : s.start));

  let p = 0;
  bars.forEach((b, i) => {
    if (b.start < bars[p]!.start) p = i;
  });
  const primary = bars[p]!;
  const alphaFrames = place(primary.start - primary.sourceIn) - starts[p]! + primary.sourceIn;
  const out = bars.map((b, i): ClipGeometry => {
    const start = starts[i]!;
    const duration = scaled[i]!.duration;
    if (i === p) return { start, duration, sourceIn: b.sourceIn };
    const D = place(b.start - b.sourceIn) - alphaFrames;
    return { start, duration, sourceIn: Math.round(start - D) };
  });
  return { bars: out, keyScale: reversed ? -ra : ra, keyOffset: alphaFrames / fps, place };
}

const EASE_MIRROR: Readonly<Record<string, string>> = { easeIn: 'easeOut', easeOut: 'easeIn' };

/**
 * Keyframes after `t → offset + scale·t`, in time order.
 *
 * A NEGATIVE scale reverses the track, and a key's easing describes the
 * segment that STARTS at it — so each key takes over the easing of the key
 * that now follows it (its old predecessor), bezier handles mirrored in time
 * and Ease In / Ease Out swapped, and its spatial in/out tangents trade places.
 * Works for scalar and data keyframes alike (same `easing`/`bezier`/`si`/`so`).
 */
export function retimeKeys<K extends { t: number }>(keys: ReadonlyArray<K>, scale: number, offset: number): K[] {
  const moved = [...keys]
    .sort((a, b) => a.t - b.t)
    .map((k) => ({ ...k, t: offset + scale * k.t }))
    .sort((a, b) => a.t - b.t);
  if (scale >= 0) return moved;
  return moved.map((k, j) => {
    const out = { ...k } as Record<string, unknown>;
    const src = k as Record<string, unknown>;
    delete out.si;
    delete out.so;
    if (src.so !== undefined) out.si = src.so;
    if (src.si !== undefined) out.so = src.si;
    const owner = moved[j + 1] as Record<string, unknown> | undefined;
    if (owner) {
      delete out.easing;
      delete out.bezier;
      delete out.continuous;
      if (typeof owner.easing === 'string') out.easing = EASE_MIRROR[owner.easing] ?? owner.easing;
      const b = owner.bezier as BezierHandles | undefined;
      if (b) out.bezier = [1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]];
      if (owner.continuous !== undefined) out.continuous = owner.continuous;
    }
    return out as K;
  });
}

/**
 * Retime every keyframe the layer owns: scalar tracks (transform, effects,
 * masks' feather/opacity/expansion, text animators, …), data tracks (Source
 * Text holds, gradient stops, mask paths) and the whole-mask shape track.
 * Expressions are untouched — they are not keyframes. The time-remap track is
 * skipped: a non-footage layer has none, and it lives on a different axis.
 */
export function retimeLayerKeyframes(nodeId: string, keyScale: number, keyOffset: number): void {
  if (keyScale === 1 && keyOffset === 0) return;
  defaultAnimation.batch(() => {
    for (const prop of defaultAnimation.getAnimatedPropPaths(nodeId)) {
      if (REMAP_TRACKS.has(prop)) continue;
      const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
      if (!kfs || kfs.length === 0) continue;
      defaultAnimation.setTrackKeyframes(nodeId, prop, retimeKeys(kfs, keyScale, keyOffset));
    }
    for (const prop of defaultAnimation.getDataAnimatedPropPaths(nodeId)) {
      const track = defaultAnimation.getDataTrack(nodeId, prop);
      if (!track || track.keyframes.length === 0) continue;
      defaultAnimation.setDataTrack(nodeId, prop, { ...track, keyframes: retimeKeys(track.keyframes, keyScale, keyOffset) });
    }
  });
  const node = defaultSceneGraph.getNode(nodeId);
  const maskKeys = node ? readNodeMaskAnim(node) : [];
  if (maskKeys.length > 0) {
    defaultSceneGraph.setMaskAnim(nodeId, retimeKeys(maskKeys, keyScale, keyOffset));
    getEventBus().emit('AnimationChanged', { nodeId });
  }
}

