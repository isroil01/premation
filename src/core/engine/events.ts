/**
 * Change events from a delta (ENGINE_API.md §8.1).
 *
 * The engine knows exactly which PARTS a request changed (state.ts). This turns
 * that set into the revisioned events the UI mirror applies: full records,
 * never deltas. Property- and keyframe-level events are found by comparing the
 * layer's current infos against what this builder last reported for it (its
 * view of the mirror); a layer it has never reported emits all of its
 * properties once. Upserts are idempotent, so an extra record is harmless and a
 * missing one is a bug — the builder errs on the side of reporting.
 */

import type { Event, ItemInfo, PropertyInfo } from '@motion/engine-api';
import { graph, compOfLayer, isCompItem, layerIdsOfComp } from './doc';
import type { Parts, ItemsPart, TimelinePart } from './state';
import {
  layerInfo,
  compSettings,
  compMarkers,
  layerMarkers,
  footageInfo,
  folderInfo,
  compItemInfo,
  propertyInfo,
  groupInfo,
  keyframeSets,
  barsOf,
} from './model';
import { catalogFor } from './props';
import { getProjectSettings, getRenderQueue } from '@core/project/documentExtras';
import type { SceneNode } from '@core/types';

export class EventBuilder {
  /** layer → path → JSON of the last PropertyInfo reported. */
  private props = new Map<string, Map<string, string>>();
  /** layer → path → JSON of the last keyframe list reported. */
  private keys = new Map<string, Map<string, string>>();
  /**
   * layer → paths whose keyframe list was reported before its cache row was
   * dropped (the layer was removed, or its bar moved). When the layer is next
   * reported, a path that is no longer animated gets its empty list: a mirror
   * that kept the old list (it need not drop a removed layer's keys) would
   * otherwise keep it forever — a multi-entry jumpToHistory that restores a
   * removed layer AND un-keys it sent no keyframesChanged for that path.
   */
  private dropped = new Map<string, Set<string>>();

  reset(): void {
    this.props.clear();
    this.keys.clear();
    this.dropped.clear();
  }

  /** Forget a layer (removed, or about to be re-reported whole). */
  forget(layerId: string): void {
    this.props.delete(layerId);
    this.dropKeys(layerId);
  }

  /** Re-report the layer's keyframe lists next time, remembering which paths were reported. */
  private dropKeys(layerId: string): void {
    const cache = this.keys.get(layerId);
    if (!cache) return;
    const paths = this.dropped.get(layerId) ?? new Set<string>();
    for (const path of cache.keys()) paths.add(path);
    this.dropped.set(layerId, paths);
    this.keys.delete(layerId);
  }

  build(changed: readonly string[], before: Parts, after: Parts): Event[] {
    const events: Event[] = [];
    const touched = new Set<string>();
    const removedByComp = new Map<string, string[]>();
    const orderComps = new Set<string>();
    const compsChanged = new Set<string>();
    const markerComps = new Set<string>();
    let itemsDirty = false;
    let projectDirty = false;
    let rqDirty = false;
    let allComps = false;

    const compOfRemoved = (id: string): string | null => {
      let cur = before.get(`node:${id}`) as SceneNode | undefined;
      const seen = new Set<string>();
      while (cur?.parent && !seen.has(cur.id)) {
        seen.add(cur.id);
        const p = cur.parent;
        if (isCompItem(p) || before.has(`comp:${p}`)) return p;
        cur = (graph.getNode(p) as SceneNode | undefined) ?? (before.get(`node:${p}`) as SceneNode | undefined);
      }
      return null;
    };

    for (const key of changed) {
      const colon = key.indexOf(':');
      const kind = colon < 0 ? key : key.slice(0, colon);
      const id = colon < 0 ? '' : key.slice(colon + 1);
      switch (kind) {
        case 'node': {
          const live = graph.getNode(id);
          if (live && !live.parent) {
            // A composition root: its child list is the stack order.
            if (isCompItem(id)) orderComps.add(id);
            break;
          }
          if (live) {
            touched.add(id);
            const b = before.get(key) as SceneNode | undefined;
            const comp = compOfLayer(id);
            if (comp && (!b || b.parent !== live.parent || JSON.stringify(b.children) !== JSON.stringify(live.children))) orderComps.add(comp);
            if (!b && comp) orderComps.add(comp);
          } else if (before.get(key) !== undefined) {
            const comp = compOfRemoved(id);
            if (comp) {
              const list = removedByComp.get(comp) ?? [];
              list.push(id);
              removedByComp.set(comp, list);
              orderComps.add(comp);
            }
            this.forget(id);
          }
          break;
        }
        case 'anim':
          if (graph.getNode(id)?.parent) touched.add(id);
          break;
        case 'clips': {
          const b = (before.get(key) ?? {}) as Record<string, unknown>;
          const a = (after.get(key) ?? {}) as Record<string, unknown>;
          for (const nodeId of new Set([...Object.keys(b), ...Object.keys(a)])) {
            if (JSON.stringify(b[nodeId]) !== JSON.stringify(a[nodeId]) && graph.getNode(nodeId)?.parent) {
              touched.add(nodeId);
              this.dropKeys(nodeId); // comp times of its keys moved with the bar
            }
          }
          break;
        }
        case 'tl': {
          const b = before.get(key) as TimelinePart | undefined;
          const a = after.get(key) as TimelinePart | undefined;
          if (isCompItem(id)) compsChanged.add(id);
          if (JSON.stringify(b?.markers) !== JSON.stringify(a?.markers)) markerComps.add(id);
          const bl = b?.layerMarkers ?? {};
          const al = a?.layerMarkers ?? {};
          for (const bar of new Set([...Object.keys(bl), ...Object.keys(al)])) {
            if (JSON.stringify(bl[bar]) === JSON.stringify(al[bar])) continue;
            const nodeId = bar.startsWith('clip:') ? bar.slice(5).replace(/:\d+$/, '') : null;
            if (nodeId && graph.getNode(nodeId)?.parent) touched.add(nodeId);
          }
          break;
        }
        case 'comp': {
          if (isCompItem(id)) compsChanged.add(id);
          itemsDirty = true;
          break;
        }
        case 'order': break;
        case 'items': itemsDirty = true; break;
        case 'project': projectDirty = true; break;
        case 'rq': rqDirty = true; break;
        case 'mb': allComps = true; break;
        default: break;
      }
    }

    // Items (compositions, footage, folders).
    if (itemsDirty) {
      const beforeItems = itemsOf(before);
      const afterItems = new Map<string, ItemInfo>();
      const itemsPart = after.get('items') as ItemsPart | undefined;
      if (itemsPart) {
        for (const f of itemsPart.folders) afterItems.set(f.id, folderInfo(f));
        for (const a of itemsPart.assets) afterItems.set(a.id, footageInfo(a));
      }
      for (const key of changed) {
        if (!key.startsWith('comp:')) continue;
        const id = key.slice(5);
        if (isCompItem(id)) afterItems.set(id, compItemInfo(id));
      }
      const upserts: ItemInfo[] = [];
      const removed: string[] = [];
      for (const [id, info] of afterItems) {
        const prev = beforeItems.get(id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(info)) upserts.push(info);
      }
      for (const id of beforeItems.keys()) if (!afterItems.has(id) && !isCompItem(id)) removed.push(id);
      for (const key of changed) {
        if (!key.startsWith('comp:')) continue;
        const id = key.slice(5);
        if (before.get(key) !== undefined && !isCompItem(id) && !removed.includes(id)) removed.push(id);
      }
      if (upserts.length > 0) events.push({ type: 'itemsChanged', items: upserts });
      if (removed.length > 0) events.push({ type: 'itemsRemoved', items: removed });
    }

    if (projectDirty) events.push({ type: 'projectSettingsChanged', settings: getProjectSettings() });

    if (allComps) for (const c of layerCompsAll()) compsChanged.add(c);
    for (const comp of compsChanged) {
      if (isCompItem(comp)) events.push({ type: 'compositionChanged', comp, settings: compSettings(comp) });
    }

    for (const [comp, layers] of removedByComp) events.push({ type: 'layersRemoved', comp, layers });

    // Layer headers, then their properties / groups / keyframes.
    const headerIds = [...touched].filter((id) => graph.getNode(id)?.parent);
    if (headerIds.length > 0) events.push({ type: 'layersChanged', layers: headerIds.map(layerInfo) });
    for (const comp of orderComps) {
      if (isCompItem(comp)) events.push({ type: 'layerOrderChanged', comp, layers: layerIdsOfComp(comp) });
    }
    const keyframeSetsOut: Array<{ prop: { layer: string; path: string }; keyframes: import('@motion/engine-api').Keyframe[] }> = [];
    for (const id of headerIds) {
      this.layerProperties(id, events);
      keyframeSetsOut.push(...this.layerKeyframes(id));
    }
    if (keyframeSetsOut.length > 0) events.push({ type: 'keyframesChanged', sets: keyframeSetsOut });

    for (const comp of markerComps) {
      if (isCompItem(comp)) events.push({ type: 'markersChanged', owner: { comp }, markers: compMarkers(comp) });
    }
    for (const id of headerIds) {
      const comp = compOfLayer(id);
      if (comp && barsOf(id, comp).some((b) => b.markers.size > 0 || true)) {
        // Layer markers ride in the header too; a dedicated event lets a
        // marker panel follow without re-reading headers.
        const touchedMarkers = changed.some((k) => k === `tl:${comp}` || k === `clips:${comp}`);
        if (touchedMarkers) events.push({ type: 'markersChanged', owner: { comp, layer: id }, markers: layerMarkers(id) });
      }
    }
    if (rqDirty) events.push({ type: 'renderQueueChanged', items: getRenderQueue() });
    return events;
  }

  private layerProperties(layerId: string, events: Event[]): void {
    let cat;
    try {
      cat = catalogFor(layerId);
    } catch {
      return;
    }
    const cache = this.props.get(layerId) ?? new Map<string, string>();
    const changedInfos: PropertyInfo[] = [];
    const seen = new Set<string>();
    for (const b of cat.props) {
      const info = propertyInfo(layerId, cat, b);
      const json = JSON.stringify(info);
      seen.add(b.path);
      if (cache.get(b.path) !== json) {
        changedInfos.push(info);
        cache.set(b.path, json);
      }
    }
    // Group structure: the ordered child list under each parent.
    const parents = new Map<string, string[]>();
    parents.set('', [...cat.roots]);
    for (const [path, g] of cat.groups) parents.set(path, [...g.children]);
    for (const [parent, children] of parents) {
      const key = `#children:${parent}`;
      const json = JSON.stringify(children) + JSON.stringify(parent ? cat.groups.get(parent)?.enabled : true) + (parent ? cat.groups.get(parent)?.name : '');
      seen.add(key);
      if (cache.get(key) === json) continue;
      const hadBefore = cache.has(key);
      cache.set(key, json);
      if (!hadBefore && parent !== '' && !this.props.has(layerId)) continue;
      const infos = children.map((c) => (cat.groups.has(c) ? groupInfo(cat, c) : cat.byPath.has(c) ? propertyInfo(layerId, cat, cat.byPath.get(c)!) : null))
        .filter((x): x is PropertyInfo => x !== null);
      events.push({ type: 'propertyGroupsChanged', layer: layerId, parent, children: infos });
    }
    // A group that disappeared: its parent's child list above already says so;
    // drop the stale cache rows so a re-added group with the same id reports.
    for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
    this.props.set(layerId, cache);
    if (changedInfos.length > 0) events.push({ type: 'propertiesChanged', layer: layerId, properties: changedInfos });
  }

  private layerKeyframes(layerId: string): Array<{ prop: { layer: string; path: string }; keyframes: import('@motion/engine-api').Keyframe[] }> {
    let sets;
    try {
      sets = keyframeSets(layerId);
    } catch {
      return [];
    }
    const cache = this.keys.get(layerId) ?? new Map<string, string>();
    const out: Array<{ prop: { layer: string; path: string }; keyframes: import('@motion/engine-api').Keyframe[] }> = [];
    const live = new Set<string>();
    for (const s of sets) {
      live.add(s.prop.path);
      const json = JSON.stringify(s.keyframes);
      if (cache.get(s.prop.path) !== json) {
        out.push(s);
        cache.set(s.prop.path, json);
      }
    }
    for (const path of [...cache.keys()]) {
      if (live.has(path)) continue;
      // No longer animated: an empty list.
      out.push({ prop: { layer: layerId, path }, keyframes: [] });
      cache.delete(path);
    }
    // Reported before the cache row was dropped and not animated now: empty too.
    for (const path of [...(this.dropped.get(layerId) ?? [])].sort()) {
      if (!live.has(path)) out.push({ prop: { layer: layerId, path }, keyframes: [] });
    }
    this.dropped.delete(layerId);
    this.keys.set(layerId, cache);
    return out;
  }
}

function itemsOf(parts: Parts): Map<string, ItemInfo> {
  const out = new Map<string, ItemInfo>();
  const items = parts.get('items') as ItemsPart | undefined;
  if (items) {
    for (const f of items.folders) out.set(f.id, folderInfo(f));
    for (const a of items.assets) out.set(a.id, footageInfo(a));
  }
  for (const [key, v] of parts) {
    if (key.startsWith('comp:') && v !== undefined) out.set(key.slice(5), { id: key.slice(5) } as ItemInfo);
  }
  return out;
}

function layerCompsAll(): string[] {
  const out = new Set<string>();
  graph.traverse((n) => {
    if (!n.parent && isCompItem(n.id)) out.add(n.id);
  });
  return [...out];
}
