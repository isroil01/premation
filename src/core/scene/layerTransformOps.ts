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
 *   • Reset must REMOVE the tracks (AE's Reset on the Transform group clears the
 *     stopwatches), otherwise the renderer keeps reading the animated value and
 *     the static default written underneath it is invisible.
 *   • The numpad nudges are relative, so they must read the pose the RENDERER
 *     resolves (`readTransformProp`) — reading the base prop makes an animated
 *     layer teleport to its rest pose plus one degree.
 *
 * The pure halves (`negateKeyframes`, `resetTransformWrites`, `nudgedScale`,
 * `numpadStep`) carry the rules and are tested without a scene graph.
 *
 * Flip happens about the ANCHOR because scale does: the anchor is where the
 * layer's local origin sits (see `centreAnchorInContent`), so negating scale is
 * exactly AE's flip around the anchor point, with no position compensation.
 */

import type { Keyframe } from '@motion/animation';
import { defaultAnimation } from '@motion/animation';
import { Matrix } from '@motion/scene';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { is3DEnabled } from '@core/scene/threeD';
import { parentWorld2DAt } from '@core/scene/layerSpace';
import { readTransformProp, writeTransformProps, writeTransformBase, type TransformWrite } from '@core/scene/transformWrite';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { writeStaticPropertyValue } from '@core/inspector/propertyValue';
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
 * Flip one layer's scale on `axis`, keyframes included. No history of its own —
 * `flipLayers` wraps the whole selection in one document edit.
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

/** Flip every layer in `ids` — one undo step for the lot. Returns how many flipped. */
export function flipLayers(ids: ReadonlyArray<string>, axis: FlipAxis): number {
  let n = 0;
  runDocumentEdit(axis === 'horizontal' ? 'Flip Horizontal' : 'Flip Vertical', () => {
    for (const id of ids) if (flipLayer(id, axis)) n += 1;
  });
  return n;
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

/** Tracks a reset clears besides the ones it writes — the uniform scale shorthand. */
const RESET_ALIASES: Readonly<Record<string, readonly string[]>> = { scaleX: ['scale'] };

/**
 * Reset one layer's Transform group: remove its keyframes and write the
 * defaults. Expressions are left alone — AE's Reset keeps them too.
 */
export function resetInputFor(nodeId: string, node: SceneNode, comp: { width: number; height: number }): ResetTransformInput {
  // Comp centre → parent space: `x`/`y` are parent-space values. Identity on an
  // unparented layer.
  const inv = Matrix.invert(parentWorld2DAt(nodeId, playheadCompTime()));
  const centre = Matrix.transformPoint(inv, { x: comp.width / 2, y: comp.height / 2 });
  return {
    kind: readNodeKind(node),
    is3D: is3DEnabled(node),
    hasOpacity: node.components.some((c) => c.type === 'Style' || c.type === 'Text'),
    centre,
  };
}

export function resetLayerTransform(nodeId: string, comp: { width: number; height: number }): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked) return false;
  const t = transformComponentOf(node);
  if (!t) return false;

  const writes = resetTransformWrites(resetInputFor(nodeId, node, comp));

  for (const { prop, value } of writes) {
    defaultAnimation.removeTrack(nodeId, prop);
    for (const alias of RESET_ALIASES[prop] ?? []) defaultAnimation.removeTrack(nodeId, alias);
    // Opacity lives on whichever component already carries it (Style / Text);
    // everything else on the Transform component.
    const home = prop === 'opacity'
      ? node.components.find((c) => typeof (c.props as Record<string, unknown>).opacity === 'number') ?? t
      : t;
    // Tracks were removed just above, so a base write is the whole story.
    writeTransformBase(nodeId, [{ prop, value }], home.id);
  }
  // A stale uniform `scale` would fight the per-axis defaults in readers that
  // fall back to it.
  if (typeof (t.props as Record<string, unknown>).scale === 'number') {
    writeTransformBase(nodeId, [{ prop: 'scale', value: 1 }], t.id);
  }
  return true;
}

export function resetTransforms(ids: ReadonlyArray<string>, comp: { width: number; height: number }): number {
  let n = 0;
  runDocumentEdit('Reset Transform', () => {
    for (const id of ids) if (resetLayerTransform(id, comp)) n += 1;
  });
  return n;
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

/** True when every prop behind a row has a numeric rest value to reset to. */
export function canResetProperties(nodeId: string, props: ReadonlyArray<string>): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked || props.length === 0) return false;
  const defaults = resetTransformWrites(resetInputFor(nodeId, node, { width: 0, height: 0 }));
  return props.every((p) => propertyResetValue(p, defaults, resolvePropertyMeta(p, nodeId).defaultValue) !== undefined);
}

/**
 * Reset the props behind ONE timeline row: remove their keyframes and write the
 * default. No history of its own — `resetProperties` wraps it. Expressions are
 * kept, as with the group Reset.
 */
export function resetLayerProperties(
  nodeId: string,
  props: ReadonlyArray<string>,
  comp: { width: number; height: number },
): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked) return false;
  const defaults = resetTransformWrites(resetInputFor(nodeId, node, comp));
  let any = false;
  for (const prop of props) {
    const value = propertyResetValue(prop, defaults, resolvePropertyMeta(prop, nodeId).defaultValue);
    if (value === undefined) continue;
    defaultAnimation.removeTrack(nodeId, prop);
    for (const alias of RESET_ALIASES[prop] ?? []) defaultAnimation.removeTrack(nodeId, alias);
    if (!writeStaticPropertyValue(nodeId, prop, value)) {
      const t = transformComponentOf(node);
      if (t) writeTransformBase(nodeId, [{ prop, value }], t.id);
    }
    any = true;
  }
  return any;
}

/** One undo step: Reset the props behind a timeline row. */
export function resetProperties(
  nodeId: string,
  props: ReadonlyArray<string>,
  comp: { width: number; height: number },
  label = 'Reset Property',
): boolean {
  let ok = false;
  runDocumentEdit(label, () => {
    ok = resetLayerProperties(nodeId, props, comp);
  });
  return ok;
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
 * One burst of presses is one undo step, like the arrow-key nudge: presses less
 * than this far apart share a merge key.
 */
const BURST_MS = 700;
let burstSeq = 0;
let lastPress = 0;
function burstKey(kind: string, nodeId: string, now: number): string {
  if (now - lastPress > BURST_MS) burstSeq += 1;
  lastPress = now;
  return `numpad:${kind}:${nodeId}:${burstSeq}`;
}

/**
 * Rotate each layer by `degrees`. Animated Rotation gets a keyframe at the
 * playhead (AE); a static one is set. Returns how many layers changed.
 */
export function nudgeRotation(ids: ReadonlyArray<string>, degrees: number, now = Date.now()): number {
  let n = 0;
  for (const id of ids) {
    const current = readTransformProp(id, 'rotation', 0);
    if (writeTransformProps(id, [{ prop: 'rotation', value: current + degrees }], 'Rotate', burstKey('rotate', id, now))) n += 1;
  }
  return n;
}

/** Scale each layer by `deltaPercent` on both axes, keyframe-aware like rotation. */
export function nudgeScale(ids: ReadonlyArray<string>, deltaPercent: number, now = Date.now()): number {
  let n = 0;
  for (const id of ids) {
    const sx = nudgedScale(readTransformProp(id, 'scaleX', 1), deltaPercent);
    const sy = nudgedScale(readTransformProp(id, 'scaleY', 1), deltaPercent);
    if (writeTransformProps(id, [{ prop: 'scaleX', value: sx }, { prop: 'scaleY', value: sy }], 'Scale', burstKey('scale', id, now))) n += 1;
  }
  return n;
}
