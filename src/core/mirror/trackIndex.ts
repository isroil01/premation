/**
 * Today's track names ⇄ API property paths, from the MIRROR's property tree
 * (B4, docs/B4_MIRROR.md). Pure: no engine, no store.
 *
 * UI code still names properties by the TypeScript engine's track names
 * (`x`, `scaleX`, `opacity`, `effect.fx_1.radius`, `mask.m1.feather`,
 * `ta.0.s0.amount`, a Text field `fontSize`). The API names them by `/` paths
 * and whole values (Position is ONE vec2 in % / px / °). The property tree
 * carries each property's `matchName`, which is the track name for a scalar
 * and a fixed token for a merged vector (`Position`, `__static:scale`, …), so
 * the mapping needs nothing but the tree:
 *
 *   trackRefIn(tree, 'x')      → { path: 'transform/position', member: 0, factor: 1 }
 *   trackRefIn(tree, 'scaleY') → { path: 'transform/scale', member: 1, factor: 100 }
 *
 * `factor` converts: API number = stored number × factor (only transform
 * scale is stored as a multiplier — ENGINE_API.md §3.5). Values leave the
 * mirror in API units; `storedNumber()` hands a row the unit it has always
 * displayed from (its `displayScale` then applies as before).
 */

import type { PropertyInfo, Value } from '@motion/engine-api';

export interface MirrorTreeLike {
  readonly layer: string;
  readonly nodes: ReadonlyMap<string, PropertyInfo>;
}

export interface TrackRef {
  /** The API path of the property holding this track. */
  path: string;
  /** Which member of the property (X of Position → 0); 0 for a scalar. */
  member: number;
  /** Every member track of the property, in order. */
  members: readonly string[];
  /** API number = stored number × factor. */
  factor: number;
  info: PropertyInfo;
}

const PERCENT_MULTIPLIER = new Set(['scale', 'scaleX', 'scaleY', 'scaleZ']);

/** Members of the merged transform vectors, by their catalog match name. */
const VECTOR_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  Position: ['x', 'y', 'z'],
  '__static:position': ['x', 'y', 'z'],
  '__static:anchor': ['anchorX', 'anchorY', 'anchorZ'],
  '__static:scale': ['scaleX', 'scaleY', 'scaleZ'],
  '__static:orientation': ['orientationX', 'orientationY', 'orientationZ'],
  '__static:rotation': ['rotation', 'rotationX', 'rotationY'],
  '__static:opacity': ['opacity'],
};

const COLOR_CHANNELS = ['_r', '_g', '_b', '_a'] as const;

/** The member tracks of one property node. */
export function membersOf(info: PropertyInfo): readonly string[] {
  if (info.kind !== 'property') return [];
  const vec = VECTOR_MEMBERS[info.matchName];
  if (vec) return vec.slice(0, Math.max(1, info.dimensions));
  if (info.valueType === 'color') {
    const base = info.path === 'layer/fill' ? 'fill' : info.matchName;
    return COLOR_CHANNELS.map((c) => `${base}${c}`);
  }
  const mask = /^masks\/([^/]+)\/(feather|opacity|expansion)$/.exec(info.path);
  if (mask) return [`mask.${mask[1]}.${mask[2]}`];
  if (info.dimensions <= 1) return [info.matchName];
  return [];
}

const cache = new WeakMap<object, Map<string, TrackRef>>();

function indexOf(tree: MirrorTreeLike): Map<string, TrackRef> {
  let idx = cache.get(tree);
  if (idx) return idx;
  idx = new Map();
  for (const info of tree.nodes.values()) {
    if (info.kind !== 'property') continue;
    const members = membersOf(info);
    members.forEach((m, i) => {
      if (idx!.has(m)) return;
      idx!.set(m, {
        path: info.path,
        member: i,
        members,
        factor: info.valueType === 'color' ? 1 : PERCENT_MULTIPLIER.has(m) ? 100 : 1,
        info,
      });
    });
    // Also reachable by its own path and match name.
    if (!idx.has(info.path)) idx.set(info.path, { path: info.path, member: 0, members, factor: 1, info });
    if (!idx.has(info.matchName) && members.length !== 1) {
      idx.set(info.matchName, { path: info.path, member: 0, members, factor: 1, info });
    }
  }
  cache.set(tree, idx);
  return idx;
}

/** The property a track (or an API path) lives in on this layer, or null. */
export function trackRefIn(tree: MirrorTreeLike | undefined, track: string): TrackRef | null {
  if (!tree) return null;
  return indexOf(tree).get(track) ?? null;
}

/** Every track name this layer's tree answers for. */
export function tracksIn(tree: MirrorTreeLike | undefined): string[] {
  return tree ? [...indexOf(tree).keys()] : [];
}

// ── Values ─────────────────────────────────────────────────────────────

/** The numbers inside a numeric Value, in member order. */
export function numbersOfValue(v: Value | undefined): number[] {
  if (!v) return [];
  switch (v.kind) {
    case 'scalar':
    case 'int': return [v.value];
    case 'bool': return [v.value ? 1 : 0];
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y, v.value.z];
    case 'vec4': return [v.value.x, v.value.y, v.value.z, v.value.w];
    case 'color': return [v.value.r, v.value.g, v.value.b, v.value.a];
    default: return [];
  }
}

/** One member of an API value, in STORED units (what rows have always shown). */
export function storedNumber(ref: TrackRef, v: Value | undefined): number | undefined {
  const n = numbersOfValue(v)[ref.member];
  return typeof n === 'number' && Number.isFinite(n) ? n / ref.factor : undefined;
}

/** A string/choice/bool/json value as the plain JS value a control shows. */
export function plainValue(v: Value | undefined): unknown {
  if (!v) return undefined;
  switch (v.kind) {
    case 'scalar':
    case 'int':
    case 'bool':
    case 'string':
    case 'choice':
    case 'layer':
    case 'item':
      return v.value;
    case 'json':
      try {
        return JSON.parse(v.value) as unknown;
      } catch {
        return undefined;
      }
    case 'scalars':
      return v.value.values;
    default:
      return 'value' in v ? v.value : undefined;
  }
}
