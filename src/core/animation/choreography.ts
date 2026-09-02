/**
 * Choreography — animating a SELECTION, not a layer.
 *
 * Animating one layer has never been the slow part. The slow part is eight
 * layers that should arrive one after another: you animate the first, copy its
 * keyframes seven times, nudge every offset by hand, and it still reads as
 * mechanical because evenly-spaced stagger is a metronome and motion needs a
 * rhythm. This module does that in one action, and writes ORDINARY KEYFRAMES —
 * real tracks on real properties that the graph editor can then bend like
 * anything else. It is a head start on manual work, not a mode you get stuck
 * in, and nothing here has to be "expanded" later.
 *
 * The craft lives next door in `entranceArchetypes.ts` and is pure: which
 * entrance suits which element, and the non-uniform gaps between them. This
 * file is the impure half — reading each layer's resting position, converting
 * to the keyframe time axis, and committing every layer in ONE undo step. That
 * last point is the whole reason this is not a loop over `applyPreset`: eight
 * separate undo entries for one gesture is not an undoable gesture.
 *
 * WHICH ARCHETYPES. Four of the six, deliberately — see
 * `CHOREOGRAPHY_ARCHETYPES`. The other two need an effect or a text animator
 * installed on the layer first, and a command that silently substituted a
 * different entrance would be worse than one that never offers it.
 *
 * NOT `sequenceLayers`. That command (Animation ▸ Stagger Animations) offsets
 * the keyframes a layer ALREADY has, and refuses a selection that has none.
 * This one is the other half: layers with no animation get one. They compose —
 * animate a selection here, then re-stagger it there — and neither can stand
 * in for the other.
 */

import { defaultAnimation, type AnimationEngine, type Keyframe, type PropPath } from '@motion/animation';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, THREE_D_PROPS } from '@core/scene/threeD';
import { readNodeKind } from '@core/scene/sceneDerive';
import { addEffect, effectPropPath, getNodeEffects } from '@core/effects/effects';
import {
  addTextAnimator,
  hasTextComponent,
  readAnimatorData,
  updateAnimator,
} from '@core/text/textAnimators';
import { runAnimEdit } from './animationCommands';
import { nodeBaseValue } from './animationPresets';
import type { EasePresetId } from './easePresets';
import { PHYSICS, type Bezier } from './motionCurves';
import {
  blurResolvePoints,
  charCascadePoints,
  entranceTrackPlans,
  hash32,
  hashFrac,
  pickEntranceArchetype,
  type EntranceArchetype,
  type EntranceTrackPlan,
} from './entranceArchetypes';

/**
 * Every archetype the choreography commands can perform.
 *
 * Four of these need nothing but keyframes. Two change the layer's STRUCTURE
 * first: `blur_resolve` installs a blur effect and animates its amount, and
 * `char_cascade` installs a text animator and sweeps its selector across the
 * string. Those installs are scene edits, so they happen outside the animation
 * transaction — the same split `applyPresetTracks` makes.
 */
export const CHOREOGRAPHY_ARCHETYPES = [
  'rise',
  'scale_pop',
  'slide_settle',
  'mask_wipe',
  'blur_resolve',
  'char_cascade',
] as const satisfies readonly EntranceArchetype[];

/**
 * What a given layer can actually do.
 *
 * `char_cascade` sweeps a selector across characters, so it needs a text
 * layer. Filtering the picker's candidates PER LAYER rather than picking and
 * substituting is what keeps the distribution honest: coercing a bad pick into
 * a fallback would quietly over-represent that fallback, which is the
 * everything-looks-the-same problem the archetypes exist to solve.
 */
function archetypesFor(nodeId: string): readonly EntranceArchetype[] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (node && hasTextComponent(node)) return CHOREOGRAPHY_ARCHETYPES;
  return CHOREOGRAPHY_ARCHETYPES.filter((a) => a !== 'char_cascade');
}

/**
 * The picker's ROLE for a layer.
 *
 * The archetypes were written for a compositor that knows what each element
 * is — a title, a card, an emblem — and `ROLE_ALLOWED` gates them accordingly.
 * The editor knows only what kind of layer it is, so text maps to `title`
 * (the most permissive text role) and everything else to `generic`.
 *
 * This is load-bearing, not cosmetic: `char_cascade` is not in `generic`'s
 * allowed set at all, so passing `generic` for everything made the cascade
 * unreachable even on text layers that could perform it.
 */
function roleFor(nodeId: string): 'title' | 'generic' {
  const node = defaultSceneGraph.getNode(nodeId);
  return node && hasTextComponent(node) ? 'title' : 'generic';
}

export type ChoreographyFeel = 'snappy' | 'smooth' | 'bouncy';

interface FeelSpec {
  /** Length of one layer's move, seconds. */
  durSec: number;
  /** How far it travels, px — read as distance, so it scales the whole feel. */
  travelPx: number;
  /** Average gap between consecutive layers, seconds. */
  staggerSec: number;
  curve: Bezier;
}

/**
 * Three feels rather than a duration field.
 *
 * Duration, travel, stagger and curve are not independent: a long move over a
 * short distance is sluggish, and a snappy curve over a slow duration reads as
 * a mistake. Exposing them separately invites combinations that look broken,
 * so they move together and the sliders live in the graph editor afterwards.
 */
const FEELS: Record<ChoreographyFeel, FeelSpec> = {
  snappy: { durSec: 0.45, travelPx: 40, staggerSec: 0.06, curve: PHYSICS.snappy },
  smooth: { durSec: 0.75, travelPx: 60, staggerSec: 0.1, curve: PHYSICS.softOut },
  bouncy: { durSec: 0.65, travelPx: 55, staggerSec: 0.09, curve: PHYSICS.overshoot },
};

/**
 * The feel's own stagger, in whole frames — the number the parametric panel
 * starts from when a gesture has no remembered rhythm of its own.
 *
 * Floored at one frame, exactly as `staggerOffsets` does, so routing a
 * command through `planStagger` with this base reproduces the rhythm that
 * command has always had rather than quietly retiming it.
 */
export function feelStaggerFrames(feel: ChoreographyFeel, fps: number): number {
  const rate = fps > 0 ? fps : 30;
  return Math.max(1, Math.round(FEELS[feel].staggerSec * rate));
}

/** The feel's per-layer move length, seconds — what the panel reports. */
export function feelDurationSec(feel: ChoreographyFeel): number {
  return FEELS[feel].durSec;
}

export interface ChoreographyRequest {
  /** Layers to animate, in the order they should arrive. */
  nodeIds: readonly string[];
  /** Composition seconds the first layer starts at. */
  atCompTime: number;
  /** `in` arrives from off-position; `out` leaves the way it came. */
  phase: 'in' | 'out';
  feel?: ChoreographyFeel;
  /** Force one archetype for every layer. Omit for a varied, seeded pick. */
  archetype?: EntranceArchetype;
  /** Variation seed — same seed, same choreography. */
  seed?: number;
  /**
   * An explicit start time per layer, composition seconds — a beat grid, when
   * the music is what should be setting the rhythm.
   *
   * It REPLACES the computed stagger rather than shifting it: two rhythms at
   * once is not a rhythm. Shorter than the selection, the remaining layers
   * share the last time; the caller is expected to have extended its own grid
   * (see `beatGrid.beatsForLayers`), which knows the tempo and can count on.
   */
  startTimes?: readonly number[];
  /** Composition frame rate. The rhythm is quantized to it — see
   *  `staggerOffsets`. Defaults to 30 when a caller cannot say. */
  fps?: number;
  /**
   * A stagger offset per layer in WHOLE FRAMES, in `nodeIds` order — what
   * `planStagger` produces.
   *
   * Frames rather than seconds because that is the only unit in which a
   * rhythm survives: keyframe times snap to the frame grid, so a plan
   * expressed in seconds is a plan the engine is free to round back into a
   * metronome. Takes precedence over `startTimes` and over the built-in
   * `staggerOffsets` rhythm.
   */
  staggerFrames?: readonly number[];
  /** Override the feel's entrance curve — the panel's ease picker. */
  curve?: Bezier;
  /**
   * Structural installs to REUSE rather than re-create, per node — what a
   * previous run of this same choreography left behind. Without it, every
   * re-apply appends another text animator to the same layer.
   */
  installs?: Readonly<Record<string, ChoreoInstall>>;
  engine?: AnimationEngine;
}

/**
 * What an archetype had to build on a layer before it could be keyframed.
 *
 * Recorded so a re-apply can write to the SAME blur and the SAME text animator
 * instead of stacking a new one on every press. The keyframes a re-apply
 * writes are restored from a capture; these installs are not keyframes, so
 * nothing else would ever clean them up.
 */
export interface ChoreoInstall {
  /** The blur effect `blur_resolve` animates. */
  effectId?: string;
  /** The text animator `char_cascade` sweeps. */
  animatorIndex?: number;
}

export interface ChoreographyResult {
  /** Layers that actually received keyframes. */
  layers: number;
  keyframes: number;
  /** The archetype chosen per layer, in request order — the UI reports it so
   *  a varied result is legible rather than mysterious. */
  archetypes: EntranceArchetype[];
  /** Stagger offset per layer, seconds from `atCompTime`. */
  offsets: number[];
  /** Total length of the choreography, seconds. */
  durationSec: number;
}

const EMPTY: ChoreographyResult = {
  layers: 0, keyframes: 0, archetypes: [], offsets: [], durationSec: 0,
};

/**
 * Stagger offsets in seconds, with the rhythm composed in WHOLE FRAMES.
 *
 * `nonUniformStagger` varies each gap by ±30% because an even stagger reads as
 * a metronome. That variation was being silently erased: keyframe times go
 * through `compToKeyframeTime`, which snaps to the frame grid, and ±30% of a
 * 3-frame stagger is less than one frame — so the gaps rounded back to equal.
 * Measured, not theorised: planned gaps of 0.0976 / 0.0902 / 0.1060 / 0.0923
 * were all stored as exactly 0.1.
 *
 * Multiplying and rounding is not enough on its own either, because whether the
 * variation survives then depends on where the multipliers happen to land —
 * one real selection produced 0.976 / 0.902 / 1.060 / 0.923, every one of which
 * rounds to the same 3 frames. So the swing is expressed in frames and floored
 * at one: still ±30% of the nominal gap where that is more than a frame, but
 * never less than the smallest difference the timebase can represent.
 *
 * Below a 2-frame stagger there is no rhythm to be had — you cannot syncopate
 * faster than the timebase — and every gap is one frame, which is honest.
 */
export function staggerOffsets(count: number, staggerSec: number, fps: number, seed: number): number[] {
  const rate = fps > 0 ? fps : 30;
  const base = Math.max(1, Math.round(staggerSec * rate));
  // At least a frame, or the "variation" is invisible after quantization.
  const swing = base >= 2 ? Math.max(1, Math.round(base * 0.3)) : 0;

  const out: number[] = [];
  let frames = 0;
  for (let i = 0; i < count; i++) {
    out.push(frames / rate);
    const step = swing === 0 ? 0 : Math.floor(hashFrac(seed, 'stagger', i) * 3) - 1;
    frames += Math.max(1, base + step * swing);
  }
  return out;
}

// ── The parametric stagger ──────────────────────────────────────────

/**
 * How the layers are ordered before the rhythm is laid over them.
 *
 * Order and rhythm are separate on purpose. "Which one arrives first" is a
 * composition decision — the eye should travel left-to-right, or outward from
 * the centre — while "how far apart" is a timing decision. Fusing them into a
 * single "stagger style" enum is what forces a re-run when only one of the two
 * was wrong.
 */
export const STAGGER_ORDERS = [
  'timeline',
  'reverse',
  'byPositionX',
  'byPositionY',
  'byDistanceFromCenter',
  'random',
] as const;
export type StaggerOrder = (typeof STAGGER_ORDERS)[number];

/** A layer as the planner sees it: an id, a name to show, and where it rests. */
export interface StaggerLayer {
  readonly nodeId: string;
  readonly name?: string;
  readonly x: number;
  readonly y: number;
}

export interface StaggerParams {
  readonly order: StaggerOrder;
  /** Same seed, same rhythm and same `random` order. */
  readonly seed: number;
  /** Nominal gap between consecutive arrivals, whole frames. 0 = all at once. */
  readonly baseOffsetFrames: number;
  /** How much each gap may vary from the base, percent. 0 = a metronome. */
  readonly swingPct: number;
  /** Per-gesture, NOT the global motion-feel preference. */
  readonly feel: ChoreographyFeel;
  /** Overrides the feel's entrance curve when set. */
  readonly easeCurve?: EasePresetId;
  /** nodeId → offset in frames. Wins over the plan for that layer. */
  readonly perLayerOverrides: Readonly<Record<string, number>>;
  /**
   * The point `byDistanceFromCenter` measures from — the composition centre,
   * when the caller knows it. Falls back to the centroid of `layers`, which
   * keeps the function pure and is the right answer for a floating cluster.
   */
  readonly center?: { readonly x: number; readonly y: number };
}

export interface StaggerPlanEntry {
  readonly nodeId: string;
  /** 0-based arrival position under `order` — 0 is the layer that leads. */
  readonly rank: number;
  /** Whole frames after the leading layer. Always an integer. */
  readonly offsetFrames: number;
  /** True when `perLayerOverrides` supplied this, not the rhythm. */
  readonly overridden: boolean;
}

export const DEFAULT_STAGGER_PARAMS: StaggerParams = {
  order: 'timeline',
  seed: 1,
  baseOffsetFrames: 3,
  swingPct: 30,
  feel: 'smooth',
  perLayerOverrides: {},
};

function centroid(layers: readonly StaggerLayer[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const l of layers) {
    x += l.x;
    y += l.y;
  }
  const n = layers.length || 1;
  return { x: x / n, y: y / n };
}

/**
 * The value each order sorts ascending by. Ties fall back to the input index,
 * so two layers stacked at the same point keep their selection order rather
 * than swapping between renders.
 */
function orderKey(
  order: StaggerOrder,
  layer: StaggerLayer,
  index: number,
  center: { x: number; y: number },
  seed: number,
): number {
  switch (order) {
    case 'timeline': return index;
    case 'reverse': return -index;
    case 'byPositionX': return layer.x;
    case 'byPositionY': return layer.y;
    case 'byDistanceFromCenter': return Math.hypot(layer.x - center.x, layer.y - center.y);
    // Seeded, not `Math.random`: a reroll button that cannot reproduce the
    // shuffle it just showed you is not a control, it is a slot machine.
    case 'random': return hashFrac(seed, 'order', layer.nodeId);
  }
}

/**
 * Offsets in FRAMES for every layer, in input order. Pure.
 *
 * The rhythm is composed in whole frames for the reason `staggerOffsets`
 * documents at length: keyframe times snap to the frame grid, so a swing
 * smaller than a frame is a swing that gets rounded away. `swing` is therefore
 * floored at one frame whenever there is any swing at all — the smallest
 * difference the timebase can actually represent — and gaps never fall below
 * one frame while the base is non-zero.
 *
 * A `baseOffsetFrames` of 0 means "all together", and that is honoured exactly:
 * no floor, no swing, every offset 0. It is a legitimate choice (a pop-on) and
 * quietly turning it into a one-frame cascade would be the app overruling it.
 */
export function planStagger(
  layers: readonly StaggerLayer[],
  params: StaggerParams,
): StaggerPlanEntry[] {
  if (layers.length === 0) return [];

  const center = params.center ?? centroid(layers);
  const ranked = layers
    .map((layer, index) => ({ layer, index, key: orderKey(params.order, layer, index, center, params.seed) }))
    .sort((a, b) => (a.key - b.key) || (a.index - b.index));

  const base = Math.max(0, Math.round(params.baseOffsetFrames));
  const swingPct = Math.max(0, params.swingPct);
  const swing = base >= 2 && swingPct > 0 ? Math.max(1, Math.round((base * swingPct) / 100)) : 0;

  const planned = new Map<number, { rank: number; frames: number }>();
  let frames = 0;
  for (let rank = 0; rank < ranked.length; rank++) {
    const entry = ranked[rank]!;
    planned.set(entry.index, { rank, frames });
    if (base === 0) continue;
    const step = swing === 0 ? 0 : Math.floor(hashFrac(params.seed, 'stagger', rank) * 3) - 1;
    frames += Math.max(1, base + step * swing);
  }

  return layers.map((layer, index) => {
    const seat = planned.get(index) ?? { rank: index, frames: 0 };
    const raw = params.perLayerOverrides[layer.nodeId];
    // Negative overrides are allowed: "this one leads by two frames" is a real
    // thing to want, and clamping it at zero would silently ignore the typed
    // value rather than refusing it.
    const overridden = typeof raw === 'number' && Number.isFinite(raw);
    return {
      nodeId: layer.nodeId,
      rank: seat.rank,
      offsetFrames: overridden ? Math.round(raw) : seat.frames,
      overridden,
    };
  });
}

/**
 * The layers as the planner needs them — resting positions sampled through the
 * engine, so a layer that is already animated is read at `atCompTime` rather
 * than from a stale static prop. The impure companion to `planStagger`.
 */
export function staggerLayersFor(
  nodeIds: readonly string[],
  atCompTime: number,
  engine: AnimationEngine = defaultAnimation,
): StaggerLayer[] {
  const out: StaggerLayer[] = [];
  for (const nodeId of nodeIds) {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) continue;
    out.push({
      nodeId,
      name: node.name || nodeId,
      x: nodeBaseValue(nodeId, 'x', atCompTime, engine) ?? 0,
      y: nodeBaseValue(nodeId, 'y', atCompTime, engine) ?? 0,
    });
  }
  return out;
}

// ── Exact capture / restore ─────────────────────────────────────────

/** One (node, prop) track, addressed. */
export interface TrackRef {
  readonly nodeId: string;
  readonly prop: PropPath;
}

/**
 * A track exactly as it was before a choreography wrote over it.
 *
 * `keyframes: null` is the load-bearing case — the property had NO track, and
 * restoring must delete the one we added rather than leave it behind. Without
 * it a re-apply that picks a different archetype accumulates the props of
 * every archetype ever tried on the layer.
 */
export interface CapturedTrack {
  readonly nodeId: string;
  readonly prop: PropPath;
  readonly keyframes: Keyframe[] | null;
}

/**
 * Copy the named tracks verbatim. Exact, not diffed, for the same reason
 * `assistantPreview` captures for the Smoother: re-running a generator with
 * the old parameters is not a revert when the generator is lossy, and this one
 * deletes and re-tangents keyframes it did not create.
 */
export function captureTracks(
  refs: readonly TrackRef[],
  engine: AnimationEngine = defaultAnimation,
): CapturedTrack[] {
  const seen = new Set<string>();
  const out: CapturedTrack[] = [];
  for (const ref of refs) {
    const key = `${ref.nodeId} ${ref.prop}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kfs = engine.getTrackKeyframes(ref.nodeId, ref.prop);
    out.push({
      nodeId: ref.nodeId,
      prop: ref.prop,
      keyframes: kfs && kfs.length ? kfs.map((k) => ({ ...k })) : null,
    });
  }
  return out;
}

/** Union of two captures, `first` winning — it is the older, truer "before". */
export function mergeCaptures(
  first: readonly CapturedTrack[],
  second: readonly CapturedTrack[],
): CapturedTrack[] {
  const out = new Map<string, CapturedTrack>();
  for (const c of second) out.set(`${c.nodeId} ${c.prop}`, c);
  for (const c of first) out.set(`${c.nodeId} ${c.prop}`, c);
  return [...out.values()];
}

/** Put every captured track back exactly. Caller owns the undo entry. */
export function restoreTracks(
  captured: readonly CapturedTrack[],
  engine: AnimationEngine = defaultAnimation,
): void {
  for (const c of captured) {
    engine.setTrackKeyframes(c.nodeId, c.prop, c.keyframes ? c.keyframes.map((k) => ({ ...k })) : null);
  }
}

/** Every track a node currently animates — what a re-stagger will move. */
export function nodeTrackRefs(
  nodeId: string,
  engine: AnimationEngine = defaultAnimation,
): TrackRef[] {
  return engine.tracksFor(nodeId).map((t) => ({ nodeId, prop: t.prop }));
}

/**
 * Slide every keyframe on each node by its own delta. Returns the number of
 * keyframes moved; the caller owns the undo entry and the batch.
 *
 * Deltas are keyframe-axis seconds, matching `sequenceLayers`: a retimed layer
 * maps comp time to keyframe time non-linearly, but a stagger is a shift of the
 * layer's own animation, so its own axis is the right one to shift along.
 */
export function shiftLayerTracks(
  entries: readonly { nodeId: string; deltaSec: number }[],
  engine: AnimationEngine = defaultAnimation,
): number {
  let moved = 0;
  for (const { nodeId, deltaSec } of entries) {
    for (const track of engine.tracksFor(nodeId)) {
      const shifted = track.keyframes.map((k) => ({ ...k, t: k.t + deltaSec }));
      if (!shifted.length) continue;
      engine.setTrackKeyframes(nodeId, track.prop, shifted);
      moved += shifted.length;
    }
  }
  return moved;
}

/**
 * An exit is the entrance played the other way round: same path, same easing,
 * values reversed in place so the layer leaves toward where it came from.
 *
 * The times are deliberately NOT reversed. Mirroring the whole plan would put
 * a fade that finishes early at the START of the exit, so the layer would
 * vanish before it moved; keeping the times and swapping the value sequence
 * keeps the fast fade fast and the long move long, which is what an exit is.
 */
function reverseValues(plans: readonly EntranceTrackPlan[]): EntranceTrackPlan[] {
  return plans.map((plan) => {
    const values = plan.points.map((p) => p.value).reverse();
    return { ...plan, points: plan.points.map((p, i) => ({ ...p, value: values[i]! })) };
  });
}

/**
 * Install whatever an archetype needs on the layer, and return the extra
 * keyframe plans that only exist once the ids do.
 *
 * Structural, so it runs BEFORE the animation transaction: adding an effect or
 * a text animator writes to the scene graph, and the property path to keyframe
 * (`effect.<id>`, `ta.<index>.offset`) is not knowable until it has.
 */
function installFor(
  nodeId: string,
  archetype: EntranceArchetype,
  start: number,
  dur: number,
  prior: ChoreoInstall | undefined,
): { plans: EntranceTrackPlan[]; install: ChoreoInstall } {
  if (archetype === 'blur_resolve') {
    // Reuse a blur the layer already has rather than stacking a second one on
    // every re-run — pressing Animate In twice should not leave two blurs. The
    // recorded id wins so a re-apply keeps writing to the same effect even on a
    // layer that has since gained others.
    const effects = getNodeEffects(nodeId);
    let effectId = effects.find((e) => e.id === prior?.effectId)?.id
      ?? effects.find((e) => e.type === 'blur')?.id;
    if (!effectId) {
      const before = new Set(effects.map((e) => e.id));
      addEffect(nodeId, 'blur');
      effectId = getNodeEffects(nodeId).find((e) => !before.has(e.id))?.id;
    }
    if (!effectId) return { plans: [], install: {} };
    // No param key: `effect.<id>` is the effect's own amount (effectPropPath).
    return {
      plans: [{ prop: effectPropPath(effectId), points: blurResolvePoints(start, dur) }],
      install: { effectId },
    };
  }

  if (archetype === 'char_cascade') {
    const node = defaultSceneGraph.getNode(nodeId);
    const existing = node ? readAnimatorData(node).length : 0;
    // A re-apply re-uses the animator the first apply added. Appending a fresh
    // one each time would leave the layer wearing every rehearsal at once, and
    // no keyframe restore would ever remove them.
    const reuse = prior?.animatorIndex !== undefined && prior.animatorIndex < existing
      ? prior.animatorIndex
      : -1;
    const index = reuse >= 0 ? reuse : addTextAnimator(nodeId);
    if (index < 0) return { plans: [], install: {} };
    // Covered glyphs start invisible, low and small; sweeping the selector
    // window off the end of the string reveals them left to right.
    updateAnimator(nodeId, index, {
      basedOn: 'characters', shape: 'rampUp', start: 0, end: 100, opacity: 0, y: 16, scale: 88,
    });
    return {
      plans: [{
        prop: `ta.${index}.offset`,
        points: charCascadePoints(start, Math.max(0.4, dur * 1.1)),
      }],
      install: { animatorIndex: index },
    };
  }

  return { plans: [], install: {} };
}

/** Layers whose entrance tilts in 3D need the layer's 3D switch on to render. */
function enable3DIfNeeded(nodeId: string, plans: readonly EntranceTrackPlan[]): void {
  if (!plans.some((p) => (THREE_D_PROPS as readonly string[]).includes(p.prop))) return;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const kind = readNodeKind(node);
  // Cameras and lights read their depth props directly — the switch is not
  // theirs to flip.
  if (kind === 'camera' || kind === 'light') return;
  if (!is3DEnabled(node)) set3DEnabled(nodeId, true);
}

/**
 * Everything a choreography will do, decided but not yet written.
 *
 * The split exists for re-editability. `animateLayers` plans and writes in one
 * breath, which is right for a one-shot command — but a re-apply has to
 * restore the previous keyframes and write the new ones inside a SINGLE undo
 * entry, so it needs the plan in its hands before the transaction opens, and
 * needs to know which tracks the write is about to touch so it can capture
 * them first.
 */
export interface ChoreographyPlan {
  readonly perLayer: ReadonlyArray<{ nodeId: string; plans: EntranceTrackPlan[] }>;
  readonly archetypes: EntranceArchetype[];
  /** Seconds from `atCompTime`, in request order. */
  readonly offsets: number[];
  readonly durationSec: number;
  /** Every track the write will touch — what to capture beforehand. */
  readonly refs: TrackRef[];
  /** Structural installs used, per node, for the next re-apply to reuse. */
  readonly installs: Record<string, ChoreoInstall>;
}

const EMPTY_PLAN: ChoreographyPlan = {
  perLayer: [], archetypes: [], offsets: [], durationSec: 0, refs: [], installs: {},
};

/**
 * Choose the entrances, the resting positions and the times — and perform the
 * STRUCTURAL installs (a blur effect, a text animator), which are scene edits
 * and deliberately live outside the animation transaction.
 *
 * Writes no keyframes. `writeChoreography` does that.
 */
export function planChoreography(req: ChoreographyRequest): ChoreographyPlan {
  const engine = req.engine ?? defaultAnimation;
  const feel = FEELS[req.feel ?? 'smooth'];
  const seed = req.seed ?? 1;
  const curve = req.curve ?? feel.curve;

  const ids = req.nodeIds.filter((id) => defaultSceneGraph.getNode(id) !== undefined);
  if (ids.length === 0) return EMPTY_PLAN;

  const fps = req.fps && req.fps > 0 ? req.fps : 30;
  const offsets = req.staggerFrames && req.staggerFrames.length > 0
    ? ids.map((_, i) => (req.staggerFrames![i] ?? 0) / fps)
    : req.startTimes && req.startTimes.length > 0
      ? ids.map((_, i) => (req.startTimes![Math.min(i, req.startTimes!.length - 1)] ?? req.atCompTime) - req.atCompTime)
      : staggerOffsets(ids.length, feel.staggerSec, fps, seed);
  const archetypes: EntranceArchetype[] = [];
  const perLayer: Array<{ nodeId: string; plans: EntranceTrackPlan[] }> = [];
  const installs: Record<string, ChoreoInstall> = {};

  for (let i = 0; i < ids.length; i++) {
    const nodeId = ids[i]!;
    const start = req.atCompTime + (offsets[i] ?? 0);
    const archetype = req.archetype ?? pickEntranceArchetype({
      role: roleFor(nodeId),
      seed,
      index: i,
      allowed: archetypesFor(nodeId),
    });
    archetypes.push(archetype);

    // Resting position: where the layer must END UP on an entrance, and where
    // it starts from on an exit. Sampled through the engine so a layer that is
    // already animated resolves to its value at this time, not to a stale
    // static prop.
    const cx = nodeBaseValue(nodeId, 'x', start, engine) ?? 0;
    const cy = nodeBaseValue(nodeId, 'y', start, engine) ?? 0;

    const plans = entranceTrackPlans(archetype, {
      start,
      dur: feel.durSec,
      travelPx: feel.travelPx,
      cx,
      cy,
      curve,
      // Seeded per layer so a row of slides does not all come from the same
      // side, which reads as a single object splitting rather than as several.
      direction: (['left', 'right', 'up', 'down'] as const)[hash32(seed, 'dir', i, nodeId) % 4]!,
    });
    // Structural installs contribute their own tracks (blur amount, the text
    // animator's selector offset), which ride the same phase mirroring.
    const installed = installFor(nodeId, archetype, start, feel.durSec, req.installs?.[nodeId]);
    if (installed.install.effectId !== undefined || installed.install.animatorIndex !== undefined) {
      installs[nodeId] = installed.install;
    }
    const withInstalls = [...plans, ...installed.plans];
    perLayer.push({ nodeId, plans: req.phase === 'out' ? reverseValues(withInstalls) : withInstalls });
  }

  // The 3D switch is a SCENE edit, not an animation edit, so it is flipped
  // outside the animation transaction — the same split `applyPresetTracks`
  // makes for the same reason.
  for (const { nodeId, plans } of perLayer) enable3DIfNeeded(nodeId, plans);

  const refs: TrackRef[] = [];
  for (const { nodeId, plans } of perLayer) {
    for (const plan of plans) refs.push({ nodeId, prop: plan.prop });
  }

  return {
    perLayer,
    archetypes,
    offsets,
    durationSec: (offsets[offsets.length - 1] ?? 0) + feel.durSec,
    refs,
    installs,
  };
}

/**
 * Write a plan's keyframes. Returns how many. The CALLER owns the undo entry —
 * that is the whole point of the split.
 */
export function writeChoreography(
  plan: ChoreographyPlan,
  engine: AnimationEngine = defaultAnimation,
): number {
  let keyframes = 0;
  for (const { nodeId, plans } of plan.perLayer) {
    for (const track of plans) {
      for (const point of track.points) {
        // The keyframe axis, not raw comp time: a trimmed or retimed clip
        // maps the two differently, and writing comp seconds straight in
        // puts the entrance somewhere the layer is not.
        const t = compToKeyframeTime(nodeId, point.t);
        engine.setKeyframe(nodeId, track.prop, t, point.value, point.easing ?? 'easeOut');
        if (point.easing === 'bezier' && point.bezier) {
          engine.setBezier(nodeId, track.prop, t, point.bezier);
        }
        keyframes++;
      }
    }
  }
  return keyframes;
}

/**
 * Animate every layer in `nodeIds`, staggered, as one undoable action.
 *
 * Returns what it did rather than a boolean: the caller reports the archetypes
 * back to the user, and a varied result that nobody can see the shape of just
 * looks like the app ignored the request.
 */
export function animateLayers(req: ChoreographyRequest): ChoreographyResult {
  const engine = req.engine ?? defaultAnimation;
  const plan = planChoreography(req);
  if (plan.perLayer.length === 0) return EMPTY;

  let keyframes = 0;
  runAnimEdit(req.phase === 'in' ? 'Animate in' : 'Animate out', () => {
    keyframes = writeChoreography(plan, engine);
  });

  return {
    layers: plan.perLayer.length,
    keyframes,
    archetypes: plan.archetypes,
    offsets: plan.offsets,
    durationSec: plan.durationSec,
  };
}
