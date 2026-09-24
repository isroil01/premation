/**
 * pathEdits — the Mask and Shape Path verbs' and the Roto Brush's MASK writes
 * over the engine API (B3, docs/B3_PATTERNS.md §1/§4/§6). Core-side because
 * their callers (`pathCommands.ts`, `rotoBrushTool.ts`) are core modules.
 *
 * A mask outline is `masks/<id>/path`, a BezierPath value whose
 * `featherPoints` carry the per-vertex feathers. A mask's keyframes are
 * whole-mask snapshots; each mask's path property lists them, with ids from
 * the engine (`getKeyframes`).
 *
 *   every state   Closed / Set First Vertex / Reverse Path Direction are
 *                 STRUCTURAL: the static outline of an unanimated mask, or
 *                 EVERY keyframe of an animated one (`updateKeyframes` value
 *                 patches — the static shape under keys is not drawn, and the
 *                 stopwatch rewrites it from the keys when it goes off)
 *   at the playhead   Alt+Shift+M's key and a pasted outline: `addKeyframes` /
 *                 `setProperty {time}` at the playhead (comp time; the engine
 *                 maps it onto the layer's keyframe axis)
 *
 * What a BezierPath cannot carry keeps the caller's legacy writer (see
 * `maskPathOnEngine`): per-vertex `broken` / `tension` editing state, and
 * the mask-level RotoBezier switch.
 */

import type { BezierPath, Command, FeatherPoint, Keyframe, KeyframePatch, PropRef, Value } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { isLayer } from '@core/engine/doc';
import { bezierToPoints } from '@core/engine/props';
import { compTime, paths, ref, values } from '@core/engine/propRefs';
import { readNodeMask, readNodeMaskAnim, type MaskPath } from '@core/effects/mask';
import type { ID } from '@core/types';
import { hasVertexEditState } from './toolEdits';

/** An outline vertex as the tools hold it (absolute handles, optional per-vertex feather). */
export interface OutlinePoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  feather?: number;
}

/**
 * An outline as the API's path value. The feather points say every vertex's
 * own feather explicitly; when `points` carry none but the state they replace
 * (`prev`) did, the list is the "none" marker — an empty list would keep the
 * old feathers BY INDEX, which a reordered or pasted outline must not.
 */
export function outlinePathValue(
  points: ReadonlyArray<OutlinePoint>,
  closed: boolean,
  prev?: ReadonlyArray<OutlinePoint>,
): Extract<Value, { kind: 'path' }> {
  const vertices: number[] = [];
  const inTangents: number[] = [];
  const outTangents: number[] = [];
  const featherPoints: FeatherPoint[] = [];
  points.forEach((p, i) => {
    vertices.push(p.x, p.y);
    inTangents.push(p.inX - p.x, p.inY - p.y);
    outTangents.push(p.outX - p.x, p.outY - p.y);
    if (typeof p.feather === 'number') featherPoints.push({ segment: i, t: 0, radius: p.feather, tension: 0 });
  });
  if (featherPoints.length === 0 && points.length > 0 && prev?.some((p) => typeof p.feather === 'number')) {
    featherPoints.push({ segment: 0, t: 0, radius: -1, tension: 0 });
  }
  return { kind: 'path', value: { vertices, inTangents, outTangents, closed, featherPoints, vertexStates: [] } };
}

/** A path value read back as outline points (absolute handles, per-vertex feathers). */
export function pathValuePoints(b: BezierPath): OutlinePoint[] {
  return bezierToPoints(b);
}

const maskPathRef = (nodeId: string, maskId: string): PropRef => ref(nodeId, paths.mask(maskId, 'path'));

/**
 * Whether the API can say every edit of this mask outline: a layer's mask
 * whose stored states (static + every keyframe) carry no per-vertex `broken` /
 * `tension` state — a BezierPath has no field for it, and a write through the
 * API would silently re-join split handles.
 */
export function maskPathOnEngine(nodeId: string, maskId: string): boolean {
  if (!isLayer(nodeId)) return false;
  const node = defaultSceneGraph.getNode(nodeId as ID);
  if (!node) return false;
  const stat = readNodeMask(node)?.paths.find((p) => p.id === maskId);
  if (!stat || hasVertexEditState(stat.points)) return false;
  return !readNodeMaskAnim(node).some((k) => {
    const p = k.mask.paths.find((x) => x.id === maskId);
    return !!p && hasVertexEditState(p.points);
  });
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

/** One structural edit of one mask outline, applied to every state. */
export interface MaskStateEdit {
  nodeId: string;
  maskId: string;
  /** The outline's closed state AFTER the edit. */
  closed: boolean;
  /** Each state's new points (null / absent = keep that state's points). */
  fn?: (points: OutlinePoint[], closed: boolean) => OutlinePoint[] | null;
}

/**
 * The commands for structural mask edits in EVERY state: a static
 * `setProperty` for an unanimated mask, one `updateKeyframes` value patch per
 * key of an animated one. Null when the keys could not be read.
 */
export async function maskEveryStateCommands(label: string, edits: ReadonlyArray<MaskStateEdit>): Promise<Command[] | null> {
  const refs = edits.map((e) => maskPathRef(e.nodeId, e.maskId));
  const keys = await keysOf(label, refs);
  if (!keys) return null;
  const out: Command[] = [];
  const patches: KeyframePatch[] = [];
  edits.forEach((e, i) => {
    const next = (pts: OutlinePoint[]): OutlinePoint[] => (e.fn ? e.fn(pts, e.closed) ?? pts : pts);
    const kfs = keys[i]!;
    if (kfs.length === 0) {
      const node = defaultSceneGraph.getNode(e.nodeId as ID);
      const stat = node ? readNodeMask(node)?.paths.find((p) => p.id === e.maskId) : undefined;
      if (!stat) return;
      out.push({ type: 'setProperty', prop: refs[i]!, value: outlinePathValue(next(stat.points), e.closed, stat.points) });
      return;
    }
    for (const k of kfs) {
      if (k.value.kind !== 'path') continue;
      const pts = pathValuePoints(k.value.value);
      patches.push({ id: k.id, value: outlinePathValue(next(pts), e.closed, pts), spatialIn: [], spatialOut: [] });
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
      prop: maskPathRef(nodeId, m.maskId), time, value: outlinePathValue(m.points, m.closed), spatialIn: [], spatialOut: [],
    })),
  }];
}

/**
 * Paste an outline onto a mask: its shape at the playhead (a key there when
 * the mask is animated, AE setValueAtTime) and its closed state in EVERY state
 * — an outline cannot be closed at one key and open at the next.
 */
export async function maskPasteCommands(
  label: string,
  targets: ReadonlyArray<{ nodeId: string; maskId: string }>,
  points: ReadonlyArray<OutlinePoint>,
  closed: boolean,
  seconds: number,
): Promise<Command[] | null> {
  const refs = targets.map((t) => maskPathRef(t.nodeId, t.maskId));
  const keys = await keysOf(label, refs);
  if (!keys) return null;
  const patches: KeyframePatch[] = [];
  const sets: Command[] = [];
  targets.forEach((t, i) => {
    for (const k of keys[i]!) {
      if (k.value.kind !== 'path' || k.value.value.closed === closed) continue;
      const pts = pathValuePoints(k.value.value);
      patches.push({ id: k.id, value: outlinePathValue(pts, closed, pts), spatialIn: [], spatialOut: [] });
    }
    const node = defaultSceneGraph.getNode(t.nodeId as ID);
    const prev = node ? readNodeMask(node)?.paths.find((p) => p.id === t.maskId)?.points : undefined;
    sets.push({ type: 'setProperty', prop: refs[i]!, value: outlinePathValue(points, closed, prev), time: compTime(seconds) });
  });
  return [...(patches.length > 0 ? [{ type: 'updateKeyframes', patches } as Command] : []), ...sets];
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
