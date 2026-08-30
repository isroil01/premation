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

import { defaultAnimation, type AnimationEngine } from '@motion/animation';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, THREE_D_PROPS } from '@core/scene/threeD';
import { readNodeKind } from '@core/scene/sceneDerive';
import { runAnimEdit } from './animationCommands';
import { nodeBaseValue } from './animationPresets';
import { PHYSICS, type Bezier } from './motionCurves';
import {
  entranceTrackPlans,
  hash32,
  hashFrac,
  pickEntranceArchetype,
  type EntranceArchetype,
  type EntranceTrackPlan,
} from './entranceArchetypes';

/**
 * The archetypes this command can perform with keyframes alone.
 *
 * `blur_resolve` needs a blur effect installed on the layer and `char_cascade`
 * needs a text animator — both are real work with their own failure modes (a
 * non-text layer cannot cascade), and both change the layer's structure rather
 * than just its animation. Offering them here and quietly falling back would
 * skew every varied pick toward the fallback, which is exactly the
 * everything-looks-the-same problem the archetypes exist to solve.
 */
export const CHOREOGRAPHY_ARCHETYPES = [
  'rise',
  'scale_pop',
  'slide_settle',
  'mask_wipe',
] as const satisfies readonly EntranceArchetype[];

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
  engine?: AnimationEngine;
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
 * Animate every layer in `nodeIds`, staggered, as one undoable action.
 *
 * Returns what it did rather than a boolean: the caller reports the archetypes
 * back to the user, and a varied result that nobody can see the shape of just
 * looks like the app ignored the request.
 */
export function animateLayers(req: ChoreographyRequest): ChoreographyResult {
  const engine = req.engine ?? defaultAnimation;
  const feel = FEELS[req.feel ?? 'smooth'];
  const seed = req.seed ?? 1;

  const ids = req.nodeIds.filter((id) => defaultSceneGraph.getNode(id) !== undefined);
  if (ids.length === 0) return EMPTY;

  const offsets = req.startTimes && req.startTimes.length > 0
    ? ids.map((_, i) => (req.startTimes![Math.min(i, req.startTimes!.length - 1)] ?? req.atCompTime) - req.atCompTime)
    : staggerOffsets(ids.length, feel.staggerSec, req.fps ?? 30, seed);
  const archetypes: EntranceArchetype[] = [];
  const perLayer: Array<{ nodeId: string; plans: EntranceTrackPlan[] }> = [];

  for (let i = 0; i < ids.length; i++) {
    const nodeId = ids[i]!;
    const start = req.atCompTime + (offsets[i] ?? 0);
    const archetype = req.archetype ?? pickEntranceArchetype({
      role: 'generic',
      seed,
      index: i,
      allowed: CHOREOGRAPHY_ARCHETYPES,
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
      curve: feel.curve,
      // Seeded per layer so a row of slides does not all come from the same
      // side, which reads as a single object splitting rather than as several.
      direction: (['left', 'right', 'up', 'down'] as const)[hash32(seed, 'dir', i, nodeId) % 4]!,
    });
    perLayer.push({ nodeId, plans: req.phase === 'out' ? reverseValues(plans) : plans });
  }

  // The 3D switch is a SCENE edit, not an animation edit, so it is flipped
  // outside the animation transaction — the same split `applyPresetTracks`
  // makes for the same reason.
  for (const { nodeId, plans } of perLayer) enable3DIfNeeded(nodeId, plans);

  let keyframes = 0;
  runAnimEdit(req.phase === 'in' ? 'Animate in' : 'Animate out', () => {
    for (const { nodeId, plans } of perLayer) {
      for (const plan of plans) {
        for (const point of plan.points) {
          // The keyframe axis, not raw comp time: a trimmed or retimed clip
          // maps the two differently, and writing comp seconds straight in
          // puts the entrance somewhere the layer is not.
          const t = compToKeyframeTime(nodeId, point.t);
          engine.setKeyframe(nodeId, plan.prop, t, point.value, point.easing ?? 'easeOut');
          if (point.easing === 'bezier' && point.bezier) {
            engine.setBezier(nodeId, plan.prop, t, point.bezier);
          }
          keyframes++;
        }
      }
    }
  });

  return {
    layers: ids.length,
    keyframes,
    archetypes,
    offsets,
    durationSec: (offsets[offsets.length - 1] ?? 0) + feel.durSec,
  };
}
