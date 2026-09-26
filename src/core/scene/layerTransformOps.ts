/**
 * Layer ▸ Transform verbs that act on a whole transform rather than one value:
 * Flip Horizontal / Flip Vertical, Reset (the Transform group), and the numpad
 * rotate / scale nudges.
 *
 * ── Why the maths is split from the writes ────────────────────────────────
 * Every one of these has a keyframed case that is the NORMAL case in a motion
 * tool, and each gets it wrong in a different way if written naively:
 *
 *   • Flip on an animated Scale must negate EVERY keyframe on the axis. Writing
 *     `-current` at the playhead would add one flipped keyframe between two
 *     unflipped ones, and the layer would turn inside out and back on playback.
 *   • Reset's defaults (`resetTransformWrites`) are sent by the timeline's
 *     Reset (layout/Timeline/resetEdits.ts) — a key at the playhead on an
 *     animated property, as AE does.
 *   • The numpad nudges are relative, so they must read the pose the RENDERER
 *     resolves (`readTransformProp`) — reading the base prop makes an animated
 *     layer teleport to its rest pose plus one degree.
 *
 * The pure halves (`negateKeyframes`, `resetTransformWrites`, `nudgedScale`,
 * `numpadStep`) carry the rules and are tested without a scene graph. Every
 * verb is ONE engine entry (`flipLayersEdit`, `nudgeRotationEdit`,
 * `nudgeScaleEdit`).
 *
 * Flip happens about the ANCHOR because scale does: the anchor is where the
 * layer's local origin sits (see `centreAnchorInContent`), so negating scale is
 * exactly AE's flip around the anchor point, with no position compensation.
 */

import type { Keyframe } from '@motion/animation';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readTransformProp, writeTransformBase, type TransformWrite } from '@core/scene/transformWrite';
import type { Command, PropertyWrite } from '@motion/engine-api';
import { assistantKeyframeCommands } from '@core/engine/assistantKeys';
import { memberWrites } from '@core/engine/propRefs';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';

export type FlipAxis = 'horizontal' | 'vertical';

/** Negate a track's values. Spatial tangents are value-space offsets, so they flip too. */
export function negateKeyframes(kfs: ReadonlyArray<Keyframe>): Keyframe[] {
  return kfs.map((k) => ({
    ...k,
    value: -k.value,
    ...(k.si !== undefined ? { si: -k.si } : null),
    ...(k.so !== undefined ? { so: -k.so } : null),
  }));
}

function transformComponentOf(node: SceneNode): SceneNode['components'][number] | undefined {
  return node.components.find((c) => c.type === 'Transform');
}

function playheadCompTime(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

/**
 * Flip one layer's scale on `axis`, keyframes included — the SCRATCH builder:
 * `flipCommands` runs it off-document for an animated layer and sends the
 * negated keys (`setKeyframes`); a static layer's flip is a plain write.
 */
export function flipLayer(nodeId: string, axis: FlipAxis): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked) return false;
  const t = transformComponentOf(node);
  if (!t) return false;
  const prop = axis === 'horizontal' ? 'scaleX' : 'scaleY';
  const p = t.props as Record<string, unknown>;

  const own = defaultAnimation.getTrackKeyframes(nodeId, prop);
  if (own && own.length > 0) {
    defaultAnimation.setTrackKeyframes(nodeId, prop, negateKeyframes(own));
  } else {
    // A layer animated through the uniform `scale` shorthand has no per-axis
    // track. The renderer reads `scaleX ?? scale`, so a negated per-axis COPY
    // flips this axis and leaves the other still following `scale`.
    const uniform = defaultAnimation.getTrackKeyframes(nodeId, 'scale');
    if (uniform && uniform.length > 0) {
      defaultAnimation.setTrackKeyframes(nodeId, prop, negateKeyframes(uniform));
    }
  }

  const base = typeof p[prop] === 'number' ? (p[prop] as number) : typeof p.scale === 'number' ? (p.scale as number) : 1;
  // Base only: the track (if any) was negated above, so no keyframe on top.
  writeTransformBase(nodeId, [{ prop, value: -base }], t.id);
  return true;
}

function scaleAnimated(nodeId: string, prop: string): boolean {
  return (defaultAnimation.getTrackKeyframes(nodeId, prop)?.length ?? 0) > 0
    || (defaultAnimation.getTrackKeyframes(nodeId, 'scale')?.length ?? 0) > 0;
}

/**
 * Flip Horizontal / Vertical as engine commands: an animated Scale gets EVERY
 * key on the axis negated (`flipLayer` run off-document, sent as
 * `setKeyframes`), a static one its value negated. Locked layers are skipped.
 * Null when a layer's scale animation is on a track the API does not address
 * (refused rather than half-flipped).
 */
export function flipCommands(ids: ReadonlyArray<string>, axis: FlipAxis): Command[] | null {
  const prop = axis === 'horizontal' ? 'scaleX' : 'scaleY';
  const targets = ids.filter((id) => {
    const n = defaultSceneGraph.getNode(id);
    return !!n && !n.locked && !!transformComponentOf(n);
  });
  const animated = targets.filter((id) => scaleAnimated(id, prop));
  const out: Command[] = [];
  if (animated.length > 0) {
    const plan = assistantKeyframeCommands(animated, () => { for (const id of animated) flipLayer(id, axis); }, { allowNodeChanges: true });
    if (plan.unaddressed.length > 0) return null;
    out.push(...plan.cmds);
  }
  const at = playheadCompTime();
  const writes: PropertyWrite[] = [];
  for (const id of targets) {
    if (animated.includes(id)) continue;
    const w = memberWrites(id, { [prop]: -readTransformProp(id, prop, 1) }, at);
    if (!w) return null;
    writes.push(...w);
  }
  if (writes.length > 0) out.push({ type: 'setProperties', writes } as Command);
  return out;
}

/** Flip every layer in `ids` — ONE engine entry. Resolves to whether it applied. */
export async function flipLayersEdit(ids: ReadonlyArray<string>, axis: FlipAxis): Promise<boolean> {
  const label = axis === 'horizontal' ? 'Flip Horizontal' : 'Flip Vertical';
  let cmds: Command[] | null;
  try {
    cmds = flipCommands(ids, axis);
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return false;
  }
  if (!cmds) {
    reportEngineError(label, { code: 'unsupported', message: 'a layer animates its scale on a track the engine cannot flip' });
    return false;
  }
  if (cmds.length === 0) return false;
  return (await edit(label, cmds)).ok;
}

// ── Reset Transform ─────────────────────────────────────────────────────────

export interface ResetTransformInput {
  kind: string;
  is3D: boolean;
  /** Layer carries an Opacity property (a Style or Text component). */
  hasOpacity: boolean;
  /** The composition centre, already expressed in the layer's PARENT space. */
  centre: { x: number; y: number };
}

/**
 * The defaults AE's Reset puts back, per the centred-origin convention new
 * layers are born with (`placeInComp`): anchor 0,0 (the content centre),
 * position at the comp centre, scale 100 %, rotation 0, opacity 100 %.
 *
 * Cameras carry no anchor, scale or 2D rotation (see `transformRows`) and have
 * no "comp centre" home — only their orientation resets.
 */
export function resetTransformWrites(input: ResetTransformInput): TransformWrite[] {
  const out: TransformWrite[] = [];
  const isCamera = input.kind === 'camera';
  if (!isCamera) {
    out.push({ prop: 'anchorX', value: 0 }, { prop: 'anchorY', value: 0 });
    if (input.is3D) out.push({ prop: 'anchorZ', value: 0 });
    out.push({ prop: 'x', value: input.centre.x }, { prop: 'y', value: input.centre.y });
    if (input.is3D) out.push({ prop: 'z', value: 0 });
    out.push({ prop: 'scaleX', value: 1 }, { prop: 'scaleY', value: 1 });
    if (input.is3D) out.push({ prop: 'scaleZ', value: 1 });
    out.push({ prop: 'rotation', value: 0 });
    if (input.is3D) out.push({ prop: 'rotationX', value: 0 }, { prop: 'rotationY', value: 0 });
  }
  if (input.is3D || isCamera) {
    out.push({ prop: 'orientationX', value: 0 }, { prop: 'orientationY', value: 0 }, { prop: 'orientationZ', value: 0 });
  }
  if (input.hasOpacity && !isCamera) out.push({ prop: 'opacity', value: 100 });
  return out;
}

// ── Reset one property (the timeline row's right-click Reset) ───────────────

/**
 * The value a single property's Reset writes: the Transform-group default when
 * the prop is one (so Position resets to the comp centre, not to 0), else the
 * property registry's numeric rest value. Undefined = nothing numeric to put
 * back (a mask shape, Source Text) — the row offers Reset disabled.
 */
export function propertyResetValue(
  prop: string,
  transformDefaults: ReadonlyArray<TransformWrite>,
  registryDefault: unknown,
): number | undefined {
  const t = transformDefaults.find((w) => w.prop === prop);
  if (t) return t.value;
  return typeof registryDefault === 'number' ? registryDefault : undefined;
}

// ── Numpad rotate / scale ───────────────────────────────────────────────────

/** AE: Numpad +/- steps 1 (Shift: 10) — degrees for rotation, percent for scale. */
export function numpadStep(direction: 1 | -1, shift: boolean): number {
  return direction * (shift ? 10 : 1);
}

/**
 * Scale a (possibly flipped) scale factor by a percentage step. The step grows
 * the MAGNITUDE, so a flipped layer grows rather than shrinks, and it never
 * crosses zero into an accidental flip.
 */
export function nudgedScale(current: number, deltaPercent: number): number {
  const sign = current < 0 ? -1 : 1;
  const mag = Math.max(0, Math.abs(current) + deltaPercent / 100);
  return sign * mag;
}

/**
 * Rotate each layer by `degrees` — ONE engine entry. Animated Rotation gets a
 * key at the playhead (AE); a static one is set. The step is added to the
 * value ON SCREEN (`readTransformProp`), so an animated layer does not jump to
 * its rest pose plus one degree. Resolves to whether it applied.
 */
export function nudgeRotationEdit(ids: ReadonlyArray<string>, degrees: number): Promise<boolean> {
  return nudgeEdit('Rotate', ids, (id) => ({ rotation: readTransformProp(id, 'rotation', 0) + degrees }));
}

/** Scale each layer by `deltaPercent` on both axes, keyframe-aware like rotation — ONE engine entry. */
export function nudgeScaleEdit(ids: ReadonlyArray<string>, deltaPercent: number): Promise<boolean> {
  return nudgeEdit('Scale', ids, (id) => ({
    scaleX: nudgedScale(readTransformProp(id, 'scaleX', 1), deltaPercent),
    scaleY: nudgedScale(readTransformProp(id, 'scaleY', 1), deltaPercent),
  }));
}

async function nudgeEdit(label: string, ids: ReadonlyArray<string>, values: (id: string) => Record<string, number>): Promise<boolean> {
  const at = playheadCompTime();
  const writes: PropertyWrite[] = [];
  for (const id of ids) {
    const n = defaultSceneGraph.getNode(id);
    if (!n || n.locked || !transformComponentOf(n)) continue;
    const w = memberWrites(id, values(id), at);
    if (w) writes.push(...w);
  }
  if (writes.length === 0) return false;
  return (await edit(label, [{ type: 'setProperties', writes } as Command])).ok;
}
