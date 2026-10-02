/**
 * pathEdits — the Mask and Shape Path verbs' and the Roto Brush's OUTLINE
 * writes over the engine API (B3, docs/B3_PATTERNS.md §1/§4/§6). Core-side
 * because their callers (`pathCommands.ts`, `rotoBrushTool.ts`) are core
 * modules.
 *
 * An outline is a path property: a mask's `masks/<id>/path`, or a drawn shape
 * layer's own `layer/path.points` (static: its Geometry points + Closed; keys:
 * the whole-outline `path.points` track). The BezierPath value carries the
 * per-vertex feathers (masks) and each vertex's editing state — split handles,
 * RotoBezier tension (`vertexStates`). A mask's keyframes are whole-mask
 * snapshots; each path property lists its keys with ids from the engine
 * (`getKeyframes`).
 *
 *   every state   Closed and RotoBezier's handles are STRUCTURAL: the static
 *                 outline of an unanimated one, or EVERY keyframe of an
 *                 animated one (`updateKeyframes` value patches — the static
 *                 shape under keys is not drawn, and the stopwatch rewrites it
 *                 from the keys when it goes off). Set First Vertex / Reverse
 *                 Path Direction are one `editPathTopology` each (the engine
 *                 replays them on every state).
 *   at the playhead   Alt+Shift+M's key and a pasted outline: `addKeyframes` /
 *                 `setProperty {time}` at the playhead (comp time; the engine
 *                 maps it onto the layer's keyframe axis)
 */

import type { BezierPath, Command, FeatherPoint, Keyframe, KeyframePatch, PropRef, Value } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { isLayer } from '@core/mirror/docFacts';
import { uiKindOf } from '@core/mirror/layerKinds';
import { documentMirror } from '@stores/documentMirror';
import { bezierToPoints } from '@core/engine/props';
import { compTime, paths, ref, values } from '@core/engine/propRefs';
import { vertexStatesOfPoints } from './toolEdits';

/** A drawn shape layer's own outline (the catalog's path value over Geometry points + `path.points`). */
export const SHAPE_PATH = 'layer/path.points';

/** An outline vertex as the tools hold it (absolute handles, optional per-vertex feather and editing state). */
export interface OutlinePoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  feather?: number;
  broken?: boolean;
  tension?: number;
}

/**
 * An outline as the API's path value. The feather points say every vertex's
 * own feather explicitly; when `points` carry none but the state they replace
 * (`prev`) did, the list is the "none" marker — an empty list would keep the
 * old feathers BY INDEX, which a reordered or pasted outline must not. The
 * vertex states are always authoritative (`vertexStatesOfPoints`). A shape
 * outline (`shape`) has no per-vertex feather: none is sent.
 */
export function outlinePathValue(
  points: ReadonlyArray<OutlinePoint>,
  closed: boolean,
  prev?: ReadonlyArray<OutlinePoint>,
  shape = false,
): Extract<Value, { kind: 'path' }> {
  const vertices: number[] = [];
  const inTangents: number[] = [];
  const outTangents: number[] = [];
  const featherPoints: FeatherPoint[] = [];
  points.forEach((p, i) => {
    vertices.push(p.x, p.y);
    inTangents.push(p.inX - p.x, p.inY - p.y);
    outTangents.push(p.outX - p.x, p.outY - p.y);
    if (!shape && typeof p.feather === 'number') featherPoints.push({ segment: i, t: 0, radius: p.feather, tension: 0 });
  });
  if (!shape && featherPoints.length === 0 && points.length > 0 && prev?.some((p) => typeof p.feather === 'number')) {
    featherPoints.push({ segment: 0, t: 0, radius: -1, tension: 0 });
  }
  return { kind: 'path', value: { vertices, inTangents, outTangents, closed, featherPoints, vertexStates: vertexStatesOfPoints(points) } };
}

/** A path value read back as outline points (absolute handles, per-vertex feathers and editing state). */
export function pathValuePoints(b: BezierPath): OutlinePoint[] {
  return bezierToPoints(b);
}

/** Which outline: a layer's mask, or (maskId null) the layer's own drawn path. */
export interface OutlineTarget {
  nodeId: string;
  maskId: string | null;
}

/** The outline's path property. */
export const outlineRef = (t: OutlineTarget): PropRef =>
  ref(t.nodeId, t.maskId !== null ? paths.mask(t.maskId, 'path') : SHAPE_PATH);

/**
 * The outline's path property in the layer's mirror tree: a mask's
 * `masks/<id>/path`, or a drawn shape's `layer/path.points` (the catalog lists
 * it only for a shape with at least two stored vertices). Undefined while the
 * layer's tree is not loaded (`loadTree` first where that matters).
 */
function outlineInfo(t: OutlineTarget): Extract<Value, { kind: 'path' }> | undefined {
  const m = documentMirror();
  if (t.maskId === null && uiKindOf(m.layer(t.nodeId)) !== 'shape') return undefined;
  const v = m.tree(t.nodeId)?.nodes.get(outlineRef(t).path)?.value;
  return v?.kind === 'path' ? v : undefined;
}

/**
 * The outline as stored (static: the PropertyInfo value of an unanimated
 * outline — the only case its callers read it for), from the mirror, or
 * undefined.
 */
function storedOutline(t: OutlineTarget): { points: OutlinePoint[]; closed: boolean } | undefined {
  const v = outlineInfo(t);
  if (!v) return undefined;
  if (t.maskId === null && v.value.vertices.length < 4) return undefined;
  return { points: pathValuePoints(v.value), closed: v.value.closed };
}

/**
 * Whether the API addresses this outline: a composition layer's mask, or a
 * drawn shape layer's own outline (a shape with at least two stored vertices —
 * what the catalog lists as `layer/path.points`, a path value). Read from the
 * layer's mirror tree: a layer whose tree is not loaded yet answers false
 * (the viewport keeps the selection's trees loaded — ports.ts).
 */
export function outlineOnEngine(t: OutlineTarget): boolean {
  if (!isLayer(t.nodeId)) return false;
  return storedOutline(t) !== undefined;
}

/** Load the targets' trees (the mirror fetches them on demand) before reading their outlines. */
async function loadTrees(targets: ReadonlyArray<OutlineTarget>): Promise<void> {
  const m = documentMirror();
  await Promise.all([...new Set(targets.map((t) => t.nodeId))].map((id) => m.loadTree(id)));
}

/** The keyframes of each ref (engine ids and values), or null when the query failed (toasted). */
async function keysOf(label: string, refs: readonly PropRef[]): Promise<Keyframe[][] | null> {
  if (refs.length === 0) return [];
  const res = await engine().query({ type: 'getKeyframes', props: [...refs] });
  if (!res.ok) {
    reportEngineError(label, res.error);
    return null;
  }
  return refs.map((r) => res.value.sets.find((s) => s.prop.layer === r.layer && s.prop.path === r.path)?.keyframes ?? []);
}

/** One structural edit of one outline, applied to every state. */
export interface OutlineStateEdit extends OutlineTarget {
  /** The outline's closed state AFTER the edit. */
  closed: boolean;
  /** Each state's new points (null / absent = keep that state's points). */
  fn?: (points: OutlinePoint[], closed: boolean) => OutlinePoint[] | null;
}

/**
 * The commands for structural outline edits in EVERY state: a static
 * `setProperty` for an unanimated outline, one `updateKeyframes` value patch
 * per key of an animated one. Null when the keys could not be read.
 */
export async function everyStateCommands(label: string, edits: ReadonlyArray<OutlineStateEdit>): Promise<Command[] | null> {
  const refs = edits.map(outlineRef);
  const keys = await keysOf(label, refs);
  if (!keys) return null;
  await loadTrees(edits);
  const out: Command[] = [];
  const patches: KeyframePatch[] = [];
  edits.forEach((e, i) => {
    const shape = e.maskId === null;
    const next = (pts: OutlinePoint[]): OutlinePoint[] => (e.fn ? e.fn(pts, e.closed) ?? pts : pts);
    const kfs = keys[i]!;
    if (kfs.length === 0) {
      const stat = storedOutline(e);
      if (!stat) return;
      out.push({ type: 'setProperty', prop: refs[i]!, value: outlinePathValue(next(stat.points), e.closed, stat.points, shape) });
      return;
    }
    for (const k of kfs) {
      if (k.value.kind !== 'path') continue;
      const pts = pathValuePoints(k.value.value);
      patches.push({ id: k.id, value: outlinePathValue(next(pts), e.closed, pts, shape), spatialIn: [], spatialOut: [] });
    }
  });
  if (patches.length > 0) out.push({ type: 'updateKeyframes', patches });
  return out;
}

/** One mask's outline at the playhead, as the viewport shows it. */
export interface MaskOutlineAt {
  maskId: string;
  points: ReadonlyArray<OutlinePoint>;
  closed: boolean;
}

/**
 * Alt+Shift+M on a layer's masks: a Mask Path key at comp time `seconds`
 * holding each mask's current shape. The masks of a layer are keyed together
 * (one snapshot per key), so every mask gets its key — with the shape the
 * viewport draws there, the interpolated one between keys.
 */
export function maskKeyAtCommands(nodeId: string, masks: ReadonlyArray<MaskOutlineAt>, seconds: number): Command[] {
  if (masks.length === 0) return [];
  const time = compTime(seconds);
  return [{
    type: 'addKeyframes',
    keys: masks.map((m) => ({
      prop: outlineRef({ nodeId, maskId: m.maskId }), time, value: outlinePathValue(m.points, m.closed), spatialIn: [], spatialOut: [],
    })),
  }];
}

/** Alt+Shift+M on a shape layer's own outline: a Path key at comp time `seconds` holding the shape drawn there. */
export function shapeKeyAtCommand(nodeId: string, points: ReadonlyArray<OutlinePoint>, closed: boolean, seconds: number): Command {
  return {
    type: 'addKeyframes',
    keys: [{ prop: outlineRef({ nodeId, maskId: null }), time: compTime(seconds), value: outlinePathValue(points, closed, undefined, true), spatialIn: [], spatialOut: [] }],
  };
}

/**
 * Paste an outline onto masks / shape outlines: its shape at the playhead (a
 * key there when the outline is animated, AE setValueAtTime) and its closed
 * state in EVERY state — an outline cannot be closed at one key and open at
 * the next (a shape's Closed is the whole outline's; a mask's keys each carry
 * one, patched here).
 */
export async function pasteCommands(
  label: string,
  targets: ReadonlyArray<OutlineTarget>,
  points: ReadonlyArray<OutlinePoint>,
  closed: boolean,
  seconds: number,
): Promise<Command[] | null> {
  const refs = targets.map(outlineRef);
  const keys = await keysOf(label, refs.filter((_, i) => targets[i]!.maskId !== null));
  if (!keys) return null;
  await loadTrees(targets);
  const patches: KeyframePatch[] = [];
  const sets: Command[] = [];
  let mi = 0;
  targets.forEach((t, i) => {
    const shape = t.maskId === null;
    if (!shape) {
      for (const k of keys[mi++]!) {
        if (k.value.kind !== 'path' || k.value.value.closed === closed) continue;
        const pts = pathValuePoints(k.value.value);
        patches.push({ id: k.id, value: outlinePathValue(pts, closed, pts), spatialIn: [], spatialOut: [] });
      }
    }
    const prev = storedOutline(t)?.points;
    sets.push({ type: 'setProperty', prop: refs[i]!, value: outlinePathValue(points, closed, prev, shape), time: compTime(seconds) });
  });
  return [...(patches.length > 0 ? [{ type: 'updateKeyframes', patches } as Command] : []), ...sets];
}

/** A structural edit of one outline in every state (the engine replays it: `editPathTopology`). */
export function topologyCommand(t: OutlineTarget, op: Extract<Command, { type: 'editPathTopology' }>['op'], closed?: boolean): Command {
  return { type: 'editPathTopology', prop: outlineRef(t), ...(op ? { op } : {}), ...(closed !== undefined ? { closed } : {}) };
}

/** The outline's RotoBezier switch: `masks/<id>/rotoBezier`, or a shape's `layer/pathRotoBezier`. */
export function rotoBezierCommand(t: OutlineTarget, on: boolean): Command {
  const path = t.maskId !== null ? paths.mask(t.maskId, 'rotoBezier') : 'layer/pathRotoBezier';
  return { type: 'setProperty', prop: ref(t.nodeId, path), value: values.bool(on) };
}

/** Send `cmds` as one entry; false when there was nothing to send or it failed. */
export async function sendPathEdit(label: string, cmds: readonly Command[] | null): Promise<boolean> {
  if (!cmds || cmds.length === 0) return false;
  const res = await edit(label, cmds);
  return res.ok;
}
