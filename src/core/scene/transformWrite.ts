/**
 * The one place that knows how to write a transform property.
 *
 * ── THE AE KEYFRAMING CONTRACT ──────────────────────────────────────────────
 * A property with a lit stopwatch (an existing track) ALWAYS keyframes on
 * direct manipulation. The global Auto-Keyframe mode only decides whether
 * *un-animated* properties start recording.
 *
 * This is not a style preference, it is a correctness requirement: the renderer
 * reads animated values FIRST (`av.get(prop) ?? transform.prop`), so writing a
 * static value to a tracked property is silently discarded. The edit appears to
 * work — the store changes — and nothing moves on screen.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * The contract was implemented correctly in exactly one place, `workspace/ports`,
 * for canvas drags and the 3D gizmo — and `hasAnyTrack` was a private function
 * there, so nothing else could reuse it. Three user-facing features wrote
 * transform props directly and therefore broke on any animated layer:
 *
 *   • Anchor point       pan-behind compensated `x`/`y` with `writeProp`, so on
 *                        a layer with animated Position the compensation was
 *                        discarded and the layer JUMPED by the compensation
 *                        amount. Reproduced: anchorX 1 → 11 left Position X at
 *                        961 instead of 971.
 *   • Align & Distribute wrote `x`/`y` directly — aligning an animated layer
 *                        did nothing visible.
 *   • Fit to Comp / Fill / Native Size — same, for size and position.
 *
 * In a motion-design tool an animated layer is the NORMAL case, so all three
 * were broken most of the time. Route every transform write through here.
 */

import type { ID } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { bumpScene } from '@stores/sceneStore';

/**
 * Properties that keyframe TOGETHER.
 *
 * A track lit on one axis keyframes the whole group, so `x` and `y` cannot
 * drift onto different keyframe times — which is what makes a diagonal move
 * read as one motion rather than two. Mirrors `GIZMO_TRACK_GROUPS` in
 * `workspace/ports`; keep them in step.
 */
const TRACK_GROUPS: Record<string, readonly string[]> = {
  x: ['x', 'y'],
  y: ['x', 'y'],
  scaleX: ['scaleX', 'scaleY', 'scale'],
  scaleY: ['scaleX', 'scaleY', 'scale'],
  anchorX: ['anchorX', 'anchorY'],
  anchorY: ['anchorX', 'anchorY'],
};

/** True when any property in `props` already carries a keyframe track. */
export function hasAnyTrack(nodeId: string, props: readonly string[]): boolean {
  return defaultAnimation.tracksFor(nodeId).some((t: { prop: unknown }) => props.includes(t.prop as string));
}

/**
 * Does writing `prop` on this node have to go through the animation engine?
 *
 * Exported because callers sometimes need to know BEFORE computing a value —
 * a compensation that cannot be applied should not be half-applied.
 */
export function writesAsKeyframe(nodeId: string, prop: string): boolean {
  if (usePreferenceStore.getState().timelineAutoKeyframe) return true;
  return hasAnyTrack(nodeId, TRACK_GROUPS[prop] ?? [prop]);
}

/** The node's own time axis — the ONLY axis keyframes may be written on. */
function layerTime(nodeId: string): number {
  const s = useProjectStore.getState();
  const rawTime = s.tabs[s.activeTabId ?? '']?.time ?? 0;
  return getRemappedTime(nodeId, rawTime);
}

/**
 * Aliases the renderer accepts for one transform prop, in the order it tries
 * them: `buildSnapshot` resolves scale as `av.scaleX ?? av.scale ?? base`, so a
 * layer animated through the uniform `scale` shorthand has no `scaleX` anywhere
 * and a reader that only asks for `scaleX` sees 1.
 */
const PROP_ALIASES: Record<string, readonly string[]> = {
  scaleX: ['scaleX', 'scale'],
  scaleY: ['scaleY', 'scale'],
};

/**
 * The value the RENDERER resolves for `prop` right now: the animated value at
 * the playhead when the property is keyframed or expression-driven, the base
 * prop otherwise.
 *
 * ── WHY THIS IS THE OTHER HALF OF `writeTransformProps` ─────────────────────
 * That function fixed the WRITE side of the AE keyframing contract. The read
 * side was left behind, and every caller that computes a value RELATIVE to the
 * current one — `current + delta`, a bounding box, a compensation — kept
 * reading the static base prop. On an animated layer the two halves then
 * disagree: the new value is derived from the layer's rest pose and written as
 * a keyframe at the playhead, so the layer TELEPORTS from wherever it actually
 * was to wherever it would have been at time 0 plus the delta.
 *
 * Measured before this existed, on a layer keyframed 100 → 900 with the
 * playhead at its midpoint (world x = 500):
 *
 *   • Pan Behind, anchor +20px  → x jumped to 120 instead of 520
 *   • Centre Anchor in Content  → x jumped to 70 instead of 470
 *   • Align Left                → aligned to the rest pose, not the artwork
 *
 * All three are the SAME defect as the parenting bug, in the read direction:
 * chrome and commands reasoning about a place the layer is not. Any code that
 * needs "where is this property NOW" must come through here.
 */
export function readTransformProp(nodeId: string, prop: string, fallback = 0): number {
  const node = defaultSceneGraph.getNode(nodeId as ID);
  if (!node) return fallback;
  const lt = layerTime(nodeId);
  const names = PROP_ALIASES[prop] ?? [prop];
  for (const name of names) {
    const v = defaultAnimation.sample(nodeId, name, lt);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const name of names) {
    for (const c of node.components) {
      const v = (c.props as Record<string, unknown>)[name];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return fallback;
}

export interface TransformWrite {
  prop: string;
  value: number;
}

/**
 * Write transform properties, keyframing whichever ones are animated.
 *
 * Always writes the base prop too, so the static value stays correct for when
 * the track is later removed — the same thing `ports` does. `label`/`mergeKey`
 * feed the history entry; a shared mergeKey coalesces a drag into one undo step.
 *
 * Returns false when the node is missing, locked, or has no Transform — callers
 * that compute a compensation should check, rather than assume the write landed.
 */
export function writeTransformProps(
  nodeId: string,
  writes: readonly TransformWrite[],
  label = 'Transform',
  mergeKey?: string,
): boolean {
  const node = defaultSceneGraph.getNode(nodeId as ID);
  if (!node || node.locked) return false;
  const transComp = node.components.find((c) => c.type === 'Transform');
  if (!transComp) return false;

  const lt = layerTime(nodeId);
  const keyed: TransformWrite[] = [];
  let changed = false;

  for (const { prop, value } of writes) {
    if (!Number.isFinite(value)) continue;
    if (writesAsKeyframe(nodeId, prop)) keyed.push({ prop, value });
    defaultSceneGraph.writeProp(nodeId as ID, transComp.id, prop, value);
    changed = true;
  }

  if (keyed.length > 0) {
    runAnimEdit(
      label,
      () => {
        for (const k of keyed) defaultAnimation.setKeyframe(nodeId, k.prop, lt, k.value);
      },
      mergeKey ?? `${label}:${nodeId}:${lt}`,
    );
  }
  if (changed) bumpScene();
  return changed;
}
