/**
 * Track Motion's document reads over the document MIRROR (B4) — the mirror
 * twins of what the tracker section and its apply helpers used to read from
 * the scene graph: the footage's display size, the layer's mask vertex count,
 * the layers offered as a track target, whether a layer may be parented to
 * the tracked null, the effect a plan keys, a member's current value, the
 * next "Tracked Null" name and the solve camera. Pure: they take a
 * `TrackingRead` (the app passes the document mirror) and never touch the
 * engine.
 *
 * The tracking WALKS and the apply PLANS (world transforms, drawn geometry,
 * the SfM solve) stay engine computations (core/tracking/*); these are only
 * the plain document facts around them.
 */

import { secondsToFlicks, type ItemInfo, type LayerInfo, type PropertyInfo, type Value } from '@motion/engine-api';
import { compLayersDeep } from './layerFields';
import { storedNumber, trackRefIn, type MirrorTreeLike } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface TrackingRead {
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly layers: readonly string[] } | undefined;
  item(id: string): ItemInfo | undefined;
  tree(id: string): MirrorTreeLike | undefined;
  property(layer: string, path: string): PropertyInfo | undefined;
  valueAt(layer: string, path: string, time: number): Value | undefined;
  layerIds(): readonly string[];
}

/**
 * The footage's DISPLAY size (pixel aspect applied to the width, the height
 * untouched — `sourceDisplaySize`'s convention), or null when the layer shows
 * no footage item or its size is unknown.
 */
export function footageDisplaySize(
  m: Pick<TrackingRead, 'layer' | 'item'>,
  layerId: string,
): { width: number; height: number } | null {
  const source = m.layer(layerId)?.source;
  const item = source ? m.item(source) : undefined;
  if (!item || item.kind !== 'footage') return null;
  const par = item.interpretation?.pixelAspect ?? 1;
  const width = Math.round(item.width * par);
  if (!(width > 0) || !(item.height > 0)) return null;
  return { width, height: item.height };
}

/** Every vertex of every mask on the layer (what Track mask tracks). */
export function maskVertexCount(m: Pick<TrackingRead, 'tree'>, layerId: string): number {
  const tree = m.tree(layerId);
  if (!tree) return 0;
  let n = 0;
  for (const mask of tree.nodes.get('masks')?.children ?? []) {
    const v = tree.nodes.get(`${mask}/path`)?.value;
    if (v?.kind === 'path') n += Math.floor(v.value.vertices.length / 2);
  }
  return n;
}

/**
 * The ids a layer's same-parent list is drawn from: its parent's children, or
 * the composition's stack when it sits at the top (filter those by `parent`
 * — a comp's stack may list nested layers too).
 */
export function siblingSourceIds(m: Pick<TrackingRead, 'layer' | 'comp'>, layerId: string): readonly string[] {
  const layer = m.layer(layerId);
  if (!layer) return NO_IDS;
  // The records' own arrays: the same identity while nothing changed.
  return (layer.parent ? m.layer(layer.parent)?.children : m.comp(layer.comp)?.layers) ?? NO_IDS;
}

const NO_IDS: readonly string[] = Object.freeze([]);

/**
 * Whether `childId` may be parented to `parentId` (the twin of
 * `core/scene/parenting.canReparent` for a layer or composition parent): not
 * itself, not one of its own descendants, and in the same composition —
 * parenting to the composition itself means "none".
 */
export function canParentTo(m: Pick<TrackingRead, 'layer' | 'comp'>, childId: string, parentId: string | null): boolean {
  const child = m.layer(childId);
  if (!child) return false;
  if (parentId === null) return true;
  if (parentId === childId) return false;
  if (m.comp(parentId)) return parentId === child.comp;
  const parent = m.layer(parentId);
  if (!parent) return false;
  // No loops: the new parent must not sit under the child.
  const seen = new Set<string>();
  for (let p: string | undefined = parentId; p && !seen.has(p); p = m.layer(p)?.parent) {
    if (p === childId) return false;
    seen.add(p);
  }
  return parent.comp === child.comp;
}

/** The id of the layer's first effect of `type` (`effects/<id>` whose matchName is the type), or undefined. */
export function firstEffectOfType(m: Pick<TrackingRead, 'tree'>, layerId: string, type: string): string | undefined {
  const tree = m.tree(layerId);
  for (const path of tree?.nodes.get('effects')?.children ?? []) {
    if (tree?.nodes.get(path)?.matchName === type) return path.slice(path.indexOf('/') + 1);
  }
  return undefined;
}

/**
 * A member track's STORED value at comp time `seconds` — its keyed value when
 * animated, else its static value (an expression on a static property does
 * not replace what is stored) — falling back to the property's default. What
 * a key write fills the members it does not set with.
 */
export function memberStoredAt(m: Pick<TrackingRead, 'layer' | 'tree' | 'valueAt'>, layerId: string, track: string, seconds: number): number {
  if (!m.layer(layerId)) return 0;
  const r = trackRefIn(m.tree(layerId), track);
  if (!r) return 0;
  const v = r.info.animated ? m.valueAt(layerId, r.path, secondsToFlicks(seconds)) : r.info.value;
  return storedNumber(r, v) ?? storedNumber(r, r.info.defaultValue) ?? 0;
}

const TRACKED_NULL = /^Tracked Null( \d+)?$/;

/** "Tracked Null", "Tracked Null 2", … counted over every layer of the document. */
export function nextTrackedNullNameIn(m: Pick<TrackingRead, 'layer' | 'layerIds'>): string {
  let prior = 0;
  for (const id of m.layerIds()) if (TRACKED_NULL.test(m.layer(id)?.name ?? '')) prior++;
  return prior === 0 ? 'Tracked Null' : `Tracked Null ${prior + 1}`;
}

/**
 * The camera a previous solve made (tagged `camera/trackerSolve`) among the
 * layers of composition `comp` — every layer of the document when no comp is
 * named (what the section passes: its comp settings carry no root id) — or null.
 */
export function findSolveCameraIn(m: Pick<TrackingRead, 'layer' | 'layerIds' | 'property' | 'comp'>, comp?: string): string | null {
  const ids = comp === undefined ? m.layerIds() : compLayersDeep(m, comp).map((l) => l.id);
  for (const id of ids) {
    if (m.layer(id)?.kind !== 'camera') continue;
    const v = m.property(id, 'camera/trackerSolve')?.value;
    if (v?.kind === 'bool' && v.value) return id;
  }
  return null;
}
