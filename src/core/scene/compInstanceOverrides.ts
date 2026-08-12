/**
 * Essential Properties — per-INSTANCE overrides of a placed composition's
 * layers. AE calls the source-side half "master properties"; this is the half
 * that makes two instances of one comp able to differ at all.
 *
 * ## Why this needs more than a value bag
 *
 * `expandCompInstances` builds render-only clones that share the original's
 * `components` BY REFERENCE, and `buildSnapshot`'s `srcId` routes every
 * animation read to the ORIGINAL node. So there are two places a value can come
 * from, and they do not agree:
 *
 *   static  → `readBase(clone)`, which scans the clone's components.
 *   animated→ `valuesOf(id)` → `evaluateNode(srcId(id))`, i.e. the ORIGINAL's
 *             tracks, and every consumer reads it as `a?.has(p) ? a.get(p) : base.p`.
 *
 * Patching only the components therefore produces a control that works on a
 * static layer and **silently does nothing the moment that layer is
 * keyframed** — the animated value wins, per-frame, with no error. That is the
 * exact shape of the four dead controls this repo has already found (the spot
 * cone on a 2D layer, three light params that stopped at the CPU, `frameBlend`,
 * Auto-Orient). It is why this module exports BOTH halves and why
 * `compInstanceOverrides.test.ts` asserts the animated case specifically.
 *
 * The resolution rule, matching AE: **an override REPLACES the value**, it does
 * not fight the track. `overriddenPropsFor` is how `buildSnapshot` drops the
 * animated entry so the static patch is what remains.
 *
 * ## Why the Transform component is REPLACED, not appended to
 *
 * `readBase` scans every component and lets the last write win; other readers
 * (`transformComponent` in `threeD.ts`) use `find`, i.e. the FIRST match.
 * Appending a second Transform carrying the overrides would satisfy the first
 * reader and be invisible to the second — the same value disagreeing with
 * itself depending on who asked. So the clone gets a rebuilt component list
 * with the existing Transform's props merged.
 *
 * Fields are read explicitly rather than spread: graph node views expose
 * `props` through prototype getters, and a spread drops them.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { renderComponentsOf } from './SceneGraph';
import { bumpScene } from '@stores/sceneStore';

/** Stored on the instance's fx component, alongside `__compRef`. */
export const COMP_OVERRIDES_PROP = '__compOverrides';

/**
 * The properties an instance may override.
 *
 * Deliberately the numeric Transform set and nothing else: these are the ones
 * `readBase` sources from the Transform component AND `evaluateNode` can carry
 * as a track, so both halves of the resolution rule above apply to all of them
 * uniformly. Widening this list means checking that BOTH paths exist for the
 * new property — a colour or a text string does not travel through
 * `evaluateNode`, which returns `Map<PropPath, number>`.
 */
export const OVERRIDABLE_PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'] as const;
export type OverridableProp = (typeof OVERRIDABLE_PROPS)[number];

export function isOverridableProp(p: string): p is OverridableProp {
  return (OVERRIDABLE_PROPS as ReadonlyArray<string>).includes(p);
}

/** Key for one override: the ORIGINAL node's id, and the property path. */
export function overrideKey(origNodeId: string, prop: string): string {
  return `${origNodeId}/${prop}`;
}

/** Split a key back into its parts. Node ids never contain `/`. */
export function parseOverrideKey(key: string): { origNodeId: string; prop: string } | null {
  const i = key.lastIndexOf('/');
  if (i <= 0 || i === key.length - 1) return null;
  return { origNodeId: key.slice(0, i), prop: key.slice(i + 1) };
}

/** Every override stored on this instance. Empty map for a non-instance. */
export function readCompOverrides(node: SceneNode | undefined): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (!node) return out;
  for (const c of renderComponentsOf(node)) {
    const bag = (c.props as Record<string, unknown>)[COMP_OVERRIDES_PROP];
    if (!bag || typeof bag !== 'object') continue;
    for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && parseOverrideKey(k)) out.set(k, v);
    }
  }
  return out;
}

/** One override's value, or undefined when the instance does not override it. */
export function readCompOverride(
  node: SceneNode | undefined,
  origNodeId: string,
  prop: string,
): number | undefined {
  return readCompOverrides(node).get(overrideKey(origNodeId, prop));
}

/**
 * Set (or, with `value === undefined`, clear) one override.
 *
 * Writes the whole bag back rather than mutating it in place: the props object
 * on a component is shared with the stored document, and an in-place mutation
 * would not be seen by change detection.
 */
export function setCompOverride(
  instanceId: string,
  origNodeId: string,
  prop: string,
  value: number | undefined,
): void {
  const node = defaultSceneGraph.getNode(instanceId);
  if (!node) return;
  const fx = node.components.find((c) => c.type === 'fx');
  if (!fx) return;
  const next: Record<string, number> = {};
  for (const [k, v] of readCompOverrides(node)) next[k] = v;
  const key = overrideKey(origNodeId, prop);
  if (value === undefined || !Number.isFinite(value)) delete next[key];
  else next[key] = value;
  defaultSceneGraph.writeProp(instanceId, fx.id, COMP_OVERRIDES_PROP, next);
  bumpScene();
}

/** Drop every override an instance holds for one source layer. */
export function clearCompOverridesFor(instanceId: string, origNodeId: string): void {
  const node = defaultSceneGraph.getNode(instanceId);
  if (!node) return;
  const fx = node.components.find((c) => c.type === 'fx');
  if (!fx) return;
  const next: Record<string, number> = {};
  for (const [k, v] of readCompOverrides(node)) {
    if (parseOverrideKey(k)?.origNodeId !== origNodeId) next[k] = v;
  }
  defaultSceneGraph.writeProp(instanceId, fx.id, COMP_OVERRIDES_PROP, next);
  bumpScene();
}

/**
 * The props this expansion overrides for one source node.
 *
 * `buildSnapshot` deletes these from the clone's evaluated (animated) values,
 * which is what makes an override REPLACE a keyframed property instead of being
 * silently outvoted by it every frame. Returns null — not an empty set — when
 * there is nothing to do, so the hot path can bail without allocating.
 */
export function overriddenPropsFor(
  overrides: ReadonlyMap<string, number>,
  origNodeId: string,
): ReadonlySet<string> | null {
  if (overrides.size === 0) return null;
  let out: Set<string> | null = null;
  for (const k of overrides.keys()) {
    const parsed = parseOverrideKey(k);
    if (parsed?.origNodeId !== origNodeId) continue;
    (out ??= new Set()).add(parsed.prop);
  }
  return out;
}

/**
 * The clone's component list with this source node's overrides merged into its
 * Transform. Returns the input array unchanged when nothing applies, so an
 * expansion with no overrides allocates nothing.
 */
export function applyOverridesToComponents(
  components: SceneNode['components'],
  overrides: ReadonlyMap<string, number>,
  origNodeId: string,
): SceneNode['components'] {
  if (overrides.size === 0) return components;

  // Which component to patch is NOT "the Transform". `readBase` scans every
  // component and lets the LAST write win, and the props are not all on one:
  // x/y/rotation/scale sit on Transform, but `opacity` sits on Style. Patching
  // Transform put an opacity override *before* Style's own value, so it lost
  // every time — the control worked for position and silently did nothing for
  // opacity, which is the single property people reach for first.
  //
  // So each prop is written to the LAST component that already declares it,
  // which is by construction the one `readBase` would have believed. A prop no
  // component declares falls back to Transform.
  const patches = new Map<number, Record<string, number>>();
  const transformIdx = components.findIndex((c) => c.type === 'Transform');
  for (const prop of OVERRIDABLE_PROPS) {
    const v = overrides.get(overrideKey(origNodeId, prop));
    if (v === undefined) continue;
    let idx = -1;
    for (let i = 0; i < components.length; i++) {
      if (prop in (components[i]!.props as Record<string, unknown>)) idx = i;
    }
    if (idx === -1) idx = transformIdx;
    if (idx === -1) continue; // nothing to write to
    (patches.get(idx) ?? patches.set(idx, {}).get(idx)!)[prop] = v;
  }
  if (patches.size === 0) return components;

  return components.map((c, i) => {
    const patch = patches.get(i);
    return patch
      ? { id: c.id, type: c.type, props: { ...(c.props as Record<string, unknown>), ...patch } }
      : c;
  }) as SceneNode['components'];
}
