/** Helpers shared by the edit handlers. */

import { defaultAnimation } from '@motion/animation';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { ClipGeometry } from '@core/commands/snapshotSharing';
import { readNodeMaskAnim } from '@core/effects/mask';
import { fail } from '../errors';
import { graph, compOfLayer, requireLayer, layerIdsOfComp, requireComp } from '../doc';
import { barsOf } from '../model';
import { K, newScope, scopeLayer, scopeTimeline, type Scope } from '../state';
import type { HandlerCtx } from '../handler';

export function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${n} ${noun}s`;
}

/** Build a composition's timeline now (before capture), so a command never captures it half-born. */
export function ensureTimeline(comp: string): void {
  getTimelineController().timelineForComp(comp);
}

export function geomsOf(layerId: string, comp = compOfLayer(layerId)): ClipGeometry[] {
  return barsOf(layerId, comp ?? undefined).map((b) => b.clip.toJSON());
}

/** Write one layer's bar geometry exactly (silently; the engine owns the entry). */
export function writeGeoms(comp: string, layerId: string, geoms: ClipGeometry[]): void {
  getTimelineController().applyClipGeometry({ [comp]: { [layerId]: geoms } });
  getTimelineController().invalidateLayerIndex();
}

/** Layers in the same composition, validated. Returns their shared comp. */
export function requireLayersInOneComp(ids: readonly string[]): string {
  if (ids.length === 0) fail('invalidArgument', 'no layers given');
  let comp: string | null = null;
  for (const id of ids) {
    requireLayer(id);
    const c = compOfLayer(id);
    if (!c) fail('notFound', `no layer '${id}'`, { layer: id });
    if (comp && c !== comp) fail('invalidArgument', 'all layers must be in the same composition', { layer: id });
    comp = c;
  }
  if (new Set(ids).size !== ids.length) fail('invalidArgument', 'a layer is listed twice');
  return comp!;
}

/** Scope: these layers (node+anim), their comp's timeline, and the comp root. */
export function layersScope(ids: readonly string[], comp: string, s: Scope = newScope()): Scope {
  for (const id of ids) scopeLayer(s, id);
  scopeTimeline(s, comp);
  s.keys.add(K.node(comp));
  return s;
}

/**
 * Give every stable keyframe id a layer carries a FRESH id — after a copy
 * (duplicate, paste, split) the copy must not share ids with the original
 * (ids are unique per document, §3.1).
 */
export function remintKeyIds(layerId: string, ctx: HandlerCtx): void {
  const snap = defaultAnimation.snapshotNode(layerId);
  if (snap) {
    let changed = false;
    // Dimension tracks of one combined key share an id; the copies keep sharing.
    const byOld = new Map<string, string>();
    for (const kfs of Object.values(snap.tracks)) {
      for (const k of kfs) {
        if (!k.id) continue;
        const fresh = byOld.get(k.id) ?? ctx.mintKeyId();
        byOld.set(k.id, fresh);
        k.id = fresh;
        changed = true;
      }
    }
    for (const t of Object.values(snap.data)) {
      for (const k of t.keyframes) if (k.id) { k.id = ctx.mintKeyId(); changed = true; }
    }
    if (changed) defaultAnimation.restoreNode(layerId, snap);
  }
  const node = graph.getNode(layerId);
  if (node) {
    const anim = readNodeMaskAnim(node);
    if (anim.some((k) => (k as { id?: string }).id)) {
      graph.setMaskAnim(layerId, anim.map((k) => ((k as { id?: string }).id ? { ...k, id: ctx.mintKeyId() } : k)));
    }
  }
}

/**
 * Move `ids` (siblings under one parent, kept in their relative stack order) so
 * the first lands at `toIndex` of the composition's stack (0 = top). Parenting
 * is nesting in this graph, so a stack index is honoured among the siblings: the
 * layers go before the first remaining sibling whose stack index is ≥ toIndex.
 */
export function moveInStack(comp: string, ids: readonly string[], toIndex: number, ignore?: ReadonlySet<string>): void {
  const parent = graph.getNode(ids[0]!)?.parent;
  if (!parent) fail('notFound', `no layer '${ids[0]}'`);
  for (const id of ids) {
    if (graph.getNode(id)?.parent !== parent) fail('invalidArgument', 'layers moved together must share a parent (parenting is nesting in this engine)', { layer: id });
  }
  const moving = new Set(ids);
  const kids = graph.getChildOrder(parent); // back → front
  const frontFirst = [...kids].reverse();
  const movingOrdered = frontFirst.filter((id) => moving.has(id));
  const rest = frontFirst.filter((id) => !moving.has(id));
  // `ignore`: layers that do not count toward `toIndex` (pasteLayers: the
  // pasted tops' own descendants, which sit in the stack beside them).
  const stack = layerIdsOfComp(comp).filter((id) => !moving.has(id) && !ignore?.has(id));
  let insertAt = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (stack.indexOf(rest[i]!) >= toIndex) {
      insertAt = i;
      break;
    }
  }
  const nextFrontFirst = [...rest.slice(0, insertAt), ...movingOrdered, ...rest.slice(insertAt)];
  if (!graph.setChildOrder(parent, [...nextFrontFirst].reverse())) fail('internal', 'stack reorder refused');
}

export function requireCompId(id: string): string {
  requireComp(id);
  return id;
}
