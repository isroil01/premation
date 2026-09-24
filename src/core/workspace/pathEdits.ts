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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { isLayer } from '@core/engine/doc';
import { bezierToPoints } from '@core/engine/props';
import { compTime, paths, ref, values } from '@core/engine/propRefs';
import { readNodeMask, type MaskPath } from '@core/effects/mask';
import type { ID } from '@core/types';
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

/** The outline as stored (static), read directly (B3_PATTERNS §8), or undefined. */
function storedOutline(t: OutlineTarget): { points: OutlinePoint[]; closed: boolean } | undefined {
  const node = defaultSceneGraph.getNode(t.nodeId as ID);
  if (!node) return undefined;
  if (t.maskId !== null) {
    const p = readNodeMask(node)?.paths.find((x) => x.id === t.maskId);
    return p ? { points: p.points, closed: p.closed } : undefined;
  }
  const g = node.components.find((c) => c.type === 'Geometry');
  const pts = g?.props.points;
  if (!Array.isArray(pts) || pts.length < 2) return undefined;
  const full = (pts as Array<Partial<OutlinePoint> & { x: number; y: number }>).map((p) => ({
    ...p, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y,
  }));
  return { points: full, closed: g!.props.open !== true };
}

/**
 * Whether the API addresses this outline: a composition layer's mask, or a
 * drawn shape layer's own outline (a shape with at least two stored vertices —
 * what the catalog lists as `layer/path.points`, a path value).
 */
export function outlineOnEngine(t: OutlineTarget): boolean {
  if (!isLayer(t.nodeId)) return false;
  if (t.maskId !== null) return storedOutline(t) !== undefined;
  const node = defaultSceneGraph.getNode(t.nodeId as ID);
  return !!node && readNodeKind(node) === 'shape' && storedOutline(t) !== undefined;
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

/**
 * The Roto Brush's matte as the layer's roto mask — ONE entry: the tool's
 * previous paths (`drop`) go, the new outline is added at the end of the mask
 * list with its name and mode, and its feather is set on the new mask. The
 * feather needs the id `addMask` mints, so the two steps run inside one engine
 * gesture. Resolves to the new mask's id, or null (toasted) when it failed.
 */
export async function rotoMaskEdit(nodeId: string, drop: ReadonlyArray<string>, path: MaskPath, label = 'Roto Brush'): Promise<string | null> {
  if (!isLayer(nodeId)) return null;
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  const add: Command = {
    type: 'addMask', layer: nodeId, path: outlinePathValue(path.points, path.closed).value, mode: path.mode, inverted: path.inverted,
    ...(path.name ? { name: path.name } : {}),
  };
  const cmds: Command[] = [
    ...(drop.length > 0 ? [{ type: 'removePropertyGroups', groups: drop.map((id) => ref(nodeId, paths.maskGroup(id))) } as Command] : []),
    add,
  ];
  const res = await client.batch(label, cmds);
  let id: string | null = null;
  if (res.ok) {
    const groups = (res.value[res.value.length - 1] as { groups?: string[] } | undefined)?.groups ?? [];
    id = groups[0]?.split('/')[1] ?? null;
  } else {
    reportEngineError(label, res.error);
  }
  if (id && path.feather !== 0) {
    const fr = await client.execute({ type: 'setProperty', prop: ref(nodeId, paths.mask(id, 'feather')), value: values.scalar(path.feather) });
    if (!fr.ok) {
      reportEngineError(label, fr.error);
      id = null;
    }
  }
  const ended = await client.endGesture(opened.value.gesture, id !== null);
  if (!ended.ok) {
    reportEngineError(label, ended.error);
    return null;
  }
  return id;
}

/** Send `cmds` as one entry; false when there was nothing to send or it failed. */
export async function sendPathEdit(label: string, cmds: readonly Command[] | null): Promise<boolean> {
  if (!cmds || cmds.length === 0) return false;
  const res = await edit(label, cmds);
  return res.ok;
}
