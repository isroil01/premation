/**
 * The property catalog: API property paths (ENGINE_API.md §3.4) ⇄ today's
 * storage, for one layer.
 *
 * Built on the two seams the editor already trusts for "every property a layer
 * has": `buildStaticPropertyTree` (the timeline's row list, AE-ordered) and
 * `read/writeStaticPropertyValue` (the inspector's static value seam, which
 * already knows effects, layer styles, masks, path operators, text animators,
 * text path, font axes, paint and plain component props). A row's MEMBERS are
 * the scalar keyframe tracks behind it; a vector or colour property is several
 * members read and written together, one API keyframe per time.
 *
 * Groups are addressed by their stable ids (effect id, mask id, text animator
 * id, selector id, path-op id, style key, paint stroke id), never by index.
 */

import type {
  Value,
  ValueType,
  Easing,
  SpatialInterp,
  PropertyKind,
  BezierPath,
  PathVertexState,
} from '@motion/engine-api';
import {
  type MaskPath,
  type MaskPoint,
  type MaskKeyframe,
  type MaskPointEditState,
} from '@core/effects/mask';
/** A shape layer's whole-outline keyframe track (AE's Path property). */
export const SHAPE_PATH_TRACK = 'path.points';
import type { SceneNode } from '@core/types';
import { fail } from './errors';
import {
  rigMemberFactor,
} from './rigProps';

// ── Bindings ─────────────────────────────────────────────────────────

export type Special =
  | 'sourceText'
  | 'maskPath'
  | 'maskMode'
  | 'maskInverted'
  /** A mask's RotoBezier switch (`masks/<id>/rotoBezier`): static, held in every shape keyframe too. */
  | 'maskRotoBezier'
  /** A shape layer's drawn outline (`layer/path.points`): static Geometry points + Closed, keys on `path.points`. */
  | 'shapePath'
  | 'effectParam'
  /** A static field (fields.ts): text / animator / selector fields, style runs, the text path's mask. */
  | 'field'
  /** The layer's own solid fill colour (`layer/fill`, fields.ts), keyed through fill_r/_g/_b/_a. */
  | 'layerFill'
  /** The primary fill's colour stops (`layer/fillStops`, fillStops.ts): static on the paint, keys on `fill.stops`. */
  | 'fillStops'
  /** A puppet / skeleton property (rigProps.ts): static value on the rig, keys on its tracks. */
  | 'rig';

export interface GroupBinding {
  path: string;
  name: string;
  matchName: string;
  kind: PropertyKind;
  enabled: boolean;
  /** Direct child paths (groups and properties) in order. */
  children: string[];
}

// ── Value conversion ─────────────────────────────────────────────────

/**
 * API units are After Effects units (ENGINE_API.md §3.5): pixels, degrees and
 * PERCENT for opacity and scale. Every member this engine stores in the AE unit
 * already (opacity 0..100, rotation in degrees, pixels) has factor 1; transform
 * scale is stored as a multiplier (1 = 100 %) and is converted HERE, at the
 * seam, both ways — every value that crosses the API (setProperty, keyframe
 * values, getPropertyValues/Tree, sampleProperty, change events) goes through
 * `toApiNums`/`fromApiNums`. The C++ engine stores the AE unit directly.
 */
const PERCENT_MULTIPLIER_MEMBERS = new Set(['scale', 'scaleX', 'scaleY', 'scaleZ']);

/** API value = stored value × this, for one member track. */
export function apiUnitFactor(member: string | undefined): number {
  if (member === undefined) return 1;
  if (PERCENT_MULTIPLIER_MEMBERS.has(member)) return 100;
  // A pin's / bone's scale (multiplier → %), a bone's rotation (radians → °).
  return rigMemberFactor(member) ?? 1;
}

export function vectorValue(vt: ValueType, v: number[]): Value {
  switch (vt) {
    case 'scalar': return { kind: 'scalar', value: v[0] ?? 0 };
    case 'vec2': return { kind: 'vec2', value: { x: v[0] ?? 0, y: v[1] ?? 0 } };
    case 'vec3': return { kind: 'vec3', value: { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0 } };
    case 'vec4': return { kind: 'vec4', value: { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0, w: v[3] ?? 0 } };
    case 'color': return { kind: 'color', value: { r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0, a: v[3] ?? 1 } };
    default: return { kind: 'scalar', value: v[0] ?? 0 };
  }
}

// Mask path ⇄ BezierPath (tangents relative, AE-style).
export function maskToBezier(p: MaskPath): BezierPath {
  const vertices: number[] = [];
  const inT: number[] = [];
  const outT: number[] = [];
  for (const pt of p.points) {
    vertices.push(pt.x, pt.y);
    inT.push(pt.inX - pt.x, pt.inY - pt.y);
    outT.push(pt.outX - pt.x, pt.outY - pt.y);
  }
  // Variable-width feather (B3z): a vertex's own feather is a feather point AT
  // that vertex (segment i, t 0); a vertex without one has none.
  const featherPoints: BezierPath['featherPoints'] = [];
  p.points.forEach((pt, i) => {
    if (typeof pt.feather === 'number') featherPoints.push({ segment: i, t: 0, radius: pt.feather, tension: 0 });
  });
  return { vertices, inTangents: inT, outTangents: outT, closed: p.closed, featherPoints, vertexStates: vertexStatesOf(p.points) };
}

/**
 * The per-vertex EDITING state stored points carry (B3, `BezierPath.vertexStates`):
 * one entry per vertex with a split handle pair (`broken`) or a RotoBezier
 * `tension`, in vertex order.
 */
export function vertexStatesOf(points: ReadonlyArray<object>): PathVertexState[] {
  const out: PathVertexState[] = [];
  points.forEach((p, i) => {
    const v = p as MaskPointEditState;
    const broken = v.broken === true;
    const tension = typeof v.tension === 'number' ? v.tension : undefined;
    if (broken || tension !== undefined) out.push({ vertex: i, broken, ...(tension !== undefined ? { tension } : {}) });
  });
  return out;
}

/**
 * The vertex states a path's `vertexStates` say, or null for an EMPTY list —
 * which keeps each vertex's current state by index (`prev`), exactly as an
 * empty `featherPoints` keeps the feathers. A non-empty list is the whole
 * answer: a vertex it does not list has no state.
 */
function statesByVertex(b: BezierPath, n: number): Map<number, PathVertexState> | null {
  const list = b.vertexStates ?? [];
  if (list.length === 0) return null;
  const out = new Map<number, PathVertexState>();
  for (const s of list) {
    if (!Number.isInteger(s.vertex) || s.vertex < 0 || s.vertex >= n) fail('invalidArgument', `vertex state ${s.vertex} is not a vertex of the ${n}-vertex path`);
    if (s.tension !== undefined && !(Number.isFinite(s.tension) && s.tension >= 0 && s.tension <= 1)) fail('outOfRange', 'a vertex tension must be within 0..1');
    if (out.has(s.vertex)) fail('invalidArgument', `two vertex states at vertex ${s.vertex}`);
    out.set(s.vertex, s);
  }
  return out;
}

/**
 * The per-vertex feathers a path's feather points say (B3z), or null for an
 * EMPTY list — which keeps each vertex's current feather by index (`prev`),
 * what a path write did before feather points existed (the viewport's reshape
 * and every client that builds a BezierPath without them rely on it). A
 * non-empty list is the whole answer: a vertex it does not list — or lists with
 * a negative radius, the "none" marker (`[{segment: 0, t: 0, radius: -1,
 * tension: 0}]` clears every vertex) — has no feather of its own. The model
 * holds one feather per VERTEX: `t` ≠ 0 or `tension` ≠ 0 is `unsupported`.
 */
function featherByVertex(b: BezierPath, n: number): Map<number, number | null> | null {
  const fps = b.featherPoints ?? [];
  if (fps.length === 0) return null;
  const out = new Map<number, number | null>();
  for (const f of fps) {
    if (!Number.isInteger(f.segment) || f.segment < 0 || f.segment >= n) fail('invalidArgument', `feather point segment ${f.segment} is not a vertex of the ${n}-vertex path`);
    if (!Number.isFinite(f.radius) || !Number.isFinite(f.t) || !Number.isFinite(f.tension)) fail('invalidArgument', 'feather point values must be finite');
    if (f.t !== 0 || f.tension !== 0) fail('unsupported', 'this engine stores one feather per vertex: feather points need t = 0 and tension = 0');
    if (out.has(f.segment)) fail('invalidArgument', `two feather points at vertex ${f.segment}`);
    out.set(f.segment, f.radius < 0 ? null : f.radius);
  }
  return out;
}

export function bezierToPoints(b: BezierPath, prev?: ReadonlyArray<MaskPoint>): MaskPoint[] {
  const n = Math.floor(b.vertices.length / 2);
  if (b.inTangents.length !== b.vertices.length && b.inTangents.length !== 0) fail('invalidArgument', 'path tangents must match vertices');
  if (b.outTangents.length !== b.vertices.length && b.outTangents.length !== 0) fail('invalidArgument', 'path tangents must match vertices');
  const feathers = featherByVertex(b, n);
  const states = statesByVertex(b, n);
  const out: MaskPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = b.vertices[2 * i]!;
    const y = b.vertices[2 * i + 1]!;
    const pt: MaskPoint & MaskPointEditState = {
      x, y,
      inX: x + (b.inTangents[2 * i] ?? 0), inY: y + (b.inTangents[2 * i + 1] ?? 0),
      outX: x + (b.outTangents[2 * i] ?? 0), outY: y + (b.outTangents[2 * i + 1] ?? 0),
    };
    const old = prev?.[i] as (MaskPoint & MaskPointEditState) | undefined;
    if (feathers) {
      const f = feathers.get(i);
      if (typeof f === 'number') pt.feather = f;
    } else if (old?.feather !== undefined) {
      pt.feather = old.feather;
    }
    if (states) {
      const s = states.get(i);
      if (s?.broken) pt.broken = true;
      if (s?.tension !== undefined) pt.tension = s.tension;
    } else {
      if (old?.broken !== undefined) pt.broken = old.broken;
      if (old?.tension !== undefined) pt.tension = old.tension;
    }
    out.push(pt);
  }
  return out;
}

/** `bezierToPoints` for a shape outline, which has no per-vertex feather (a listed one is refused). */
export function shapePoints(b: BezierPath, prev: ReadonlyArray<MaskPoint> | undefined, path: string): MaskPoint[] {
  if ((b.featherPoints ?? []).some((f) => f.radius >= 0)) fail('unsupported', `'${path}' has no per-vertex feather`, { path });
  return bezierToPoints({ ...b, featherPoints: [] }, prev).map((p) => {
    const { feather: _f, ...rest } = p;
    return rest;
  });
}

/** Stored outline points (a shape's Geometry points / `path.points` key) as a path value. */
export function shapePathValue(points: ReadonlyArray<Partial<MaskPoint> & { x: number; y: number }>, closed: boolean): BezierPath {
  const full = points.map((p) => ({ ...p, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y }));
  return { ...maskToBezier({ points: full, closed } as unknown as MaskPath), featherPoints: [] };
}

/** A shape outline's Closed switch (`Geometry.open` marks an open path; closed stores nothing). */
export function shapeClosed(node: SceneNode): boolean {
  return node.components.find((c) => c.type === 'Geometry')?.props.open !== true;
}

export const asPoints = (v: unknown): Array<MaskPoint> | null =>
  Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && typeof (v[0] as { x?: unknown }).x === 'number'
    ? (v as MaskPoint[]) : null;

// ── Keyframes ────────────────────────────────────────────────────────

/** A keyframe as the engine sees one property: one entry per time, values per member. */
export interface KeyAt {
  /** Stored (keyframe-axis) seconds. */
  t: number;
  id: string;
  value: Value;
  easing: Easing;
  bezier?: [number, number, number, number];
  continuous: boolean;
  roving: boolean;
  spatialInterp: SpatialInterp;
  spatialIn: number[];
  spatialOut: number[];
  label: number;
  /** Per-dimension temporal interpolation when the dimensions differ (Keyframe.dims); empty = uniform. */
  dims: KeyDimAt[];
}

/** One dimension's temporal fields (the API's KeyframeDim). */
export interface KeyDimAt {
  easing: Easing;
  bezier?: [number, number, number, number];
  continuous: boolean;
}

/** The positional fallback id for a key that has no stable id yet (legacy / pre-API writes). */
export function fallbackKeyId(layerId: string, member: string, t: number): string {
  return `@${layerId}|${member}|${t}`;
}

export function parseFallbackKeyId(id: string): { layer: string; member: string; t: number } | null {
  const m = /^@(.+)\|(.+)\|(-?[0-9.eE+-]+)$/.exec(id);
  if (!m) return null;
  const t = Number(m[3]);
  return Number.isFinite(t) ? { layer: m[1]!, member: m[2]!, t } : null;
}

export function maskKeyId(layerId: string, k: MaskKeyframe, maskId: string): string {
  const id = (k as MaskKeyframe & { id?: string }).id;
  return id ? `${id}@${maskId}` : fallbackKeyId(layerId, `mask:${maskId}`, k.t);
}

// ── Keyframe writes (all go through these) ───────────────────────────

/** One key to put on a property, in stored seconds. `id` is kept when replacing. */
export interface KeyWrite {
  t: number;
  id: string;
  value?: Value;
  easing?: Easing;
  bezier?: [number, number, number, number] | null;
  continuous?: boolean;
  roving?: boolean;
  spatialInterp?: SpatialInterp;
  spatialIn?: number[] | null;
  spatialOut?: number[] | null;
  label?: number;
  /**
   * Per-dimension temporal fields (Keyframe.dims): member i takes dims[i]'s easing,
   * handles (absent = cleared) and continuity instead of `easing` / `bezier` /
   * `continuous`. Ignored unless it has one entry per member.
   */
  dims?: ReadonlyArray<{ easing: Easing; bezier?: [number, number, number, number]; continuous: boolean }>;
  /** KeyframePatch.dim: `easing` / `bezier` / `continuous` reach only this member. */
  dim?: number;
}
