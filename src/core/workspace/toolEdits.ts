/**
 * Command builders for the viewport's document writes (B3, docs/B3_PATTERNS.md).
 *
 * Core-side so the workspace ports, camera navigation and the device handles
 * — which live in core — build the same commands the layout overlays do.
 * `layout/Workspace/viewportEdits.ts` re-exports them.
 *
 * Everything here RETURNS commands; nothing sends. A drag sends them through
 * its gesture (`viewportGesture.ts` ▸ `sendToolEdit`), a click through
 * `edit`. Every value is ABSOLUTE (start state + drag), never a delta.
 */

import type { Command, KeyframeInsert, PathVertexState, PropertyInfo, PropertyWrite, PropRef, Value } from '@motion/engine-api';
import type { MaskPoint } from '@core/effects/mask';
import { apiUnitFactor } from '@core/engine/props';
import { documentMirror } from '@stores/documentMirror';
import { numbersOfValue, trackRefIn, type MirrorTreeLike } from '@core/mirror/trackIndex';
import { compTime, valueOfNumbers } from '@core/engine/propRefs';

/** One layer's new values, by today's track names (`x`, `rotationX`, `effect.fx_1.tl_x`, `focusDistance`). */
export interface NodeTrackValues {
  nodeId: string;
  values: Readonly<Record<string, number>>;
}

export interface TrackValueOptions {
  /** Comp seconds of the write (the playhead). */
  seconds: number;
  /** The Auto-Keyframe preference: an unanimated property takes a key too. */
  autoKeyframe?: boolean;
}

/**
 * The viewport's write rule (ports' `applyGizmo3DTransforms` /
 * `applyNodePropsKeyframed`, `writeEffectParams`) as commands: an animated
 * property — and every property while Auto-Keyframe is on — gets a key at the
 * playhead; the rest a static value. Member tracks of one property (`x`/`y`/`z`
 * of Position, `scaleX`/`scaleY`) become ONE whole-value write; the members a
 * write does not name keep the value they have at that time. Values are STORED
 * units (scale as a multiplier) and converted to API units here.
 *
 * Locked and vanished layers are skipped (the legacy writers skipped them; the
 * engine would refuse the whole batch). Returns null when the API cannot
 * address the write — a node that is not a layer of a composition, or a track
 * with no API property on its layer — and the caller keeps its legacy writer
 * for that edit.
 */
export function trackValueCommands(items: ReadonlyArray<NodeTrackValues>, opts: TrackValueOptions): Command[] | null {
  const sets: PropertyWrite[] = [];
  const keys: KeyframeInsert[] = [];
  const time = compTime(opts.seconds);
  const m = documentMirror();
  for (const item of items) {
    const layer = m.layer(item.nodeId);
    // A vanished layer is skipped, as a locked one is (the engine would refuse the whole batch).
    if (!layer || layer.switches.locked) continue;
    const tree = m.tree(item.nodeId);
    if (!tree) return null;
    const groups = new Map<string, { prop: PropRef; valueType: Parameters<typeof valueOfNumbers>[0]; nums: number[]; animated: boolean }>();
    for (const [track, v] of Object.entries(item.values)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const r = memberRefIn(tree, track);
      if (!r) return null;
      let g = groups.get(r.info.path);
      if (!g) {
        g = {
          prop: { layer: item.nodeId, path: r.info.path },
          valueType: r.info.valueType,
          // The members this write does not name keep the value they have at that time.
          nums: currentNumbers(item.nodeId, r.info, time),
          animated: r.info.animated || m.keyframes(item.nodeId, r.info.path).length > 0,
        };
        groups.set(r.info.path, g);
      }
      g.nums[r.member] = v * apiUnitFactor(track);
    }
    for (const g of groups.values()) {
      const value = valueOfNumbers(g.valueType, g.nums);
      if (!g.animated && opts.autoKeyframe) keys.push({ prop: g.prop, time, value, spatialIn: [], spatialOut: [] });
      else sets.push({ prop: g.prop, value, time });
    }
  }
  const out: Command[] = [];
  if (sets.length > 0) out.push({ type: 'setProperties', writes: sets });
  if (keys.length > 0) out.push({ type: 'addKeyframes', keys });
  return out;
}

/**
 * The property a track lives in on the layer's mirror tree, and which member:
 * the tree's own index (`x` → Position member 0, `scaleY` → Scale member 1, a
 * scalar by its match name or path), else an effect / expression-control
 * param named the editor's way (`effect.<id>.<key>`, a point param's
 * `<key>_x` / `<key>_y`).
 */
function memberRefIn(tree: MirrorTreeLike, track: string): { info: PropertyInfo; member: number } | null {
  const r = trackRefIn(tree, track);
  if (r && r.info.kind === 'property') return { info: r.info, member: r.member };
  const fx = /^effect\.([^.]+)\.(.+)$/.exec(track);
  if (!fx) return null;
  const direct = tree.nodes.get(`effects/${fx[1]}/${fx[2]}`);
  if (direct?.kind === 'property') return { info: direct, member: 0 };
  const axis = /^(.+)_([xyz])$/.exec(fx[2]!);
  if (!axis) return null;
  const point = tree.nodes.get(`effects/${fx[1]}/${axis[1]}`);
  if (point?.kind !== 'property' || point.dimensions < 2) return null;
  return { info: point, member: 'xyz'.indexOf(axis[2]!) };
}

/**
 * A property's numbers at comp time `time` (flicks), API units: a static one's
 * stored value, an animated one's value there (the mirror's batched value at
 * that time; the last one it knows until that batch lands).
 */
function currentNumbers(layer: string, info: PropertyInfo, time: number): number[] {
  const nums = numbersOfValue(documentMirror().valueAt(layer, info.path, time) ?? info.value);
  const dims = Math.max(1, info.dimensions);
  while (nums.length < dims) nums.push(0);
  return nums;
}

/**
 * The per-vertex editing state of outline points as `BezierPath.vertexStates`
 * — AUTHORITATIVE: an outline whose vertices carry none says so with the
 * "none" marker (`[{vertex: 0, broken: false}]`), because an empty list would
 * keep the replaced state's split handles / tensions by index.
 */
export function vertexStatesOfPoints(points: ReadonlyArray<object>): PathVertexState[] {
  const out: PathVertexState[] = [];
  points.forEach((p, i) => {
    const v = p as { broken?: unknown; tension?: unknown };
    const broken = v.broken === true;
    const tension = typeof v.tension === 'number' ? v.tension : undefined;
    if (broken || tension !== undefined) out.push({ vertex: i, broken, ...(tension !== undefined ? { tension } : {}) });
  });
  if (out.length === 0 && points.length > 0) out.push({ vertex: 0, broken: false });
  return out;
}

/** An outline (a mask's, a shape's) as the API's BezierPath: tangents relative to their vertex, each vertex's editing state. */
export function maskPointsToPath(points: ReadonlyArray<MaskPoint>, closed: boolean): Value {
  const vertices: number[] = [];
  const inTangents: number[] = [];
  const outTangents: number[] = [];
  for (const p of points) {
    vertices.push(p.x, p.y);
    inTangents.push(p.inX - p.x, p.inY - p.y);
    outTangents.push(p.outX - p.x, p.outY - p.y);
  }
  return { kind: 'path', value: { vertices, inTangents, outTangents, closed, featherPoints: [], vertexStates: vertexStatesOfPoints(points) } };
}
