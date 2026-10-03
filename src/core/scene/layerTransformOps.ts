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
 *     resolves (the engine's evaluated value) — reading the base prop makes an
 *     animated layer teleport to its rest pose plus one degree.
 *
 * The pure halves (`negateKeyMember`, `resetTransformWrites`, `nudgedScale`,
 * `numpadStep`) carry the rules and are tested without a document. Every verb
 * reads the document mirror and is ONE engine entry (`flipLayersEdit`,
 * `nudgeRotationEdit`, `nudgeScaleEdit`).
 *
 * Flip happens about the ANCHOR because scale does: the anchor is where the
 * layer's local origin sits (see `centreAnchorInContent`), so negating scale is
 * exactly AE's flip around the anchor point, with no position compensation.
 */

import type { Command, Keyframe, PropertyWrite, Value } from '@motion/engine-api';
import type { TransformWrite } from '@core/scene/transformWrite';
import { memberWrites } from '@core/engine/propRefs';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { mirrorHasTransform } from '@core/mirror/layerFacts';
import { trackRefIn } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { trackValuesAt } from '@stores/trackValues';
import { useProjectStore } from '@stores/projectStore';

export type FlipAxis = 'horizontal' | 'vertical';

/** One dimension of a numeric value negated (other kinds unchanged). */
function negateMemberOf(v: Value, member: number): Value {
  switch (v.kind) {
    case 'scalar': return member === 0 ? { kind: 'scalar', value: -v.value } : v;
    case 'vec2': return { kind: 'vec2', value: { x: member === 0 ? -v.value.x : v.value.x, y: member === 1 ? -v.value.y : v.value.y } };
    case 'vec3': return { kind: 'vec3', value: { x: member === 0 ? -v.value.x : v.value.x, y: member === 1 ? -v.value.y : v.value.y, z: member === 2 ? -v.value.z : v.value.z } };
    default: return v;
  }
}

/**
 * Negate one dimension (`member`) of every key of a property: its value and
 * that dimension's spatial tangents (value-space offsets, so they flip too).
 * The other dimensions and the timing are untouched; ids are kept.
 */
export function negateKeyMember(keys: ReadonlyArray<Keyframe>, member: number): Keyframe[] {
  const flip = (a: readonly number[]): number[] => a.map((n, i) => (i === member ? -n : n));
  return keys.map((k) => ({ ...k, value: negateMemberOf(k.value, member), spatialIn: flip(k.spatialIn), spatialOut: flip(k.spatialOut) }));
}

function playheadCompTime(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

/** The layers of `ids` a transform verb acts on: known to the mirror, unlocked, with a Transform. */
async function transformTargets(ids: ReadonlyArray<string>): Promise<string[]> {
  const m = documentMirror();
  const out: string[] = [];
  for (const id of ids) {
    const layer = m.layer(id);
    if (!layer || layer.switches.locked) continue;
    if (mirrorHasTransform(await m.loadTree(id))) out.push(id);
  }
  return out;
}

/**
 * Flip Horizontal / Vertical as engine commands, read off the document
 * mirror: an animated Scale gets EVERY key's axis negated (`setKeyframes` on
 * the property, ids kept), a static one its value negated. Locked layers are
 * skipped. Null when a layer's Transform has no Scale the API addresses
 * (refused rather than half-flipped).
 */
export async function flipCommands(ids: ReadonlyArray<string>, axis: FlipAxis): Promise<Command[] | null> {
  const prop = axis === 'horizontal' ? 'scaleX' : 'scaleY';
  const m = documentMirror();
  const at = playheadCompTime();
  const out: Command[] = [];
  const writes: PropertyWrite[] = [];
  for (const id of await transformTargets(ids)) {
    const r = trackRefIn(m.tree(id), prop);
    if (!r) return null;
    const keys = m.keyframes(id, r.path);
    if (keys.length > 0) {
      out.push({ type: 'setKeyframes', prop: { layer: id, path: r.path }, keys: negateKeyMember(keys, r.member) });
      continue;
    }
    const [now = 1] = await trackValuesAt(id, [prop], at);
    const w = memberWrites(id, { [prop]: -now }, at);
    if (!w) return null;
    writes.push(...w);
  }
  if (writes.length > 0) out.push({ type: 'setProperties', writes } as Command);
  return out;
}

/** Flip every layer in `ids` — ONE engine entry. Resolves to whether it applied. */
export async function flipLayersEdit(ids: ReadonlyArray<string>, axis: FlipAxis): Promise<boolean> {
  const label = axis === 'horizontal' ? 'Flip Horizontal' : 'Flip Vertical';
  const cmds = await flipCommands(ids, axis);
  if (!cmds) {
    reportEngineError(label, { code: 'unsupported', message: 'a layer has no Scale the engine can flip' });
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
 * value ON SCREEN (evaluated by the engine at the playhead, `trackValuesAt`),
 * so an animated layer does not jump to its rest pose plus one degree.
 * Resolves to whether it applied.
 */
export function nudgeRotationEdit(ids: ReadonlyArray<string>, degrees: number): Promise<boolean> {
  return nudgeEdit('Rotate', ids, ['rotation'], ([r = 0]) => ({ rotation: r + degrees }));
}

/** Scale each layer by `deltaPercent` on both axes, keyframe-aware like rotation — ONE engine entry. */
export function nudgeScaleEdit(ids: ReadonlyArray<string>, deltaPercent: number): Promise<boolean> {
  return nudgeEdit('Scale', ids, ['scaleX', 'scaleY'], ([sx = 1, sy = 1]) => ({
    scaleX: nudgedScale(sx, deltaPercent),
    scaleY: nudgedScale(sy, deltaPercent),
  }));
}

async function nudgeEdit(
  label: string,
  ids: ReadonlyArray<string>,
  tracks: ReadonlyArray<string>,
  values: (now: Array<number | undefined>) => Record<string, number>,
): Promise<boolean> {
  const at = playheadCompTime();
  const writes: PropertyWrite[] = [];
  for (const id of await transformTargets(ids)) {
    const w = memberWrites(id, values(await trackValuesAt(id, tracks, at)), at);
    if (w) writes.push(...w);
  }
  if (writes.length === 0) return false;
  return (await edit(label, [{ type: 'setProperties', writes } as Command])).ok;
}
