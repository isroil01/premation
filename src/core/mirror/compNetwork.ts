/**
 * The composition network over the document mirror (B4) — what the
 * Composition Mini-Flowchart and nested-comp navigation read, the mirror twin
 * of `@core/composition/compNetwork` / `compNavigation.nestedTargetOf`. Pure:
 * it takes a mirror reader and never touches the engine.
 *
 * The comps immediately UPSTREAM of a comp are the ones its layers show (a
 * placed composition: `LayerInfo.source` naming a comp; a legacy in-place
 * precomp GROUP: a `precomp` layer with no source, which opens as its own
 * comp). Immediately DOWNSTREAM are the comps whose layers show it. The
 * mirror's `MirrorComp.layers` already stops at every composition boundary
 * (`layerIdsOfComp`), and a legacy group that carries a settings record is a
 * composition of its own there, so an instance inside such a group belongs to
 * the GROUP. A legacy group WITHOUT a record (never opened in a tab) lists no
 * members in getDocument — it still opens, but shows no upstream of its own.
 *
 * A comp used several times appears ONCE, carrying every layer that uses it.
 */

import type { LayerInfo } from '@motion/engine-api';

/** What the network needs from the mirror. `DocumentMirror` is one. */
export interface MirrorNetworkRead {
  readonly compIds: readonly string[];
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly settings: { readonly name: string }; readonly layers: readonly string[] } | undefined;
}

export interface NetworkEntry {
  /** The composition (or precomp group) this entry opens. */
  compId: string;
  name: string;
  /** The layers that carry the link, frontmost first. */
  layerIds: string[];
  /** Stack position of the frontmost of them (0 = top) — the layer-order sort key. */
  order: number;
}

export interface CompNetwork {
  compId: string;
  name: string;
  upstream: NetworkEntry[];
  downstream: NetworkEntry[];
}

export type UpstreamSort = 'name' | 'layer';

/** What double-clicking a layer opens, when it opens anything. */
export interface NestedTarget {
  compId: string;
  title: string;
  /** `instance` = a placed composition; `group` = a group opened as its own tab. */
  kind: 'instance' | 'group';
}

/** A comp's display name: its record, else the (group) layer's name, else the id. */
export function mirrorCompName(m: MirrorNetworkRead, id: string): string {
  return m.comp(id)?.settings.name ?? m.layer(id)?.name ?? id;
}

/** Whether `id` is still something a tab can show: a composition, or a (group) layer. */
export function mirrorCompExists(m: MirrorNetworkRead, id: string): boolean {
  return !!(m.comp(id) || m.layer(id));
}

/** A legacy in-place precomp group: a `precomp` layer that places no composition. */
function isLegacyGroup(l: LayerInfo): boolean {
  return l.kind === 'precomp' && !l.source;
}

/**
 * The composition a layer opens into, or null for one that has none (a
 * shape, text, footage, a comp instance whose source is gone).
 */
export function mirrorNestedTarget(m: MirrorNetworkRead, layerId: string): NestedTarget | null {
  const l = m.layer(layerId);
  if (!l) return null;
  if (l.kind === 'precomp' && l.source) {
    return m.comp(l.source) ? { compId: l.source, title: mirrorCompName(m, l.source), kind: 'instance' } : null;
  }
  if (l.kind === 'group' || isLegacyGroup(l)) return { compId: l.id, title: l.name || l.id, kind: 'group' };
  return null;
}

function collect(m: MirrorNetworkRead, into: Map<string, NetworkEntry>, compId: string, layerId: string, order: number): void {
  const e = into.get(compId);
  if (e) {
    e.layerIds.push(layerId);
    e.order = Math.min(e.order, order);
  } else {
    into.set(compId, { compId, name: mirrorCompName(m, compId), layerIds: [layerId], order });
  }
}

/** The network around `compId`. Upstream sorted by `sort`; downstream always by name (AE). */
export function mirrorCompNetwork(m: MirrorNetworkRead, compId: string, sort: UpstreamSort = 'name'): CompNetwork {
  const upstream = new Map<string, NetworkEntry>();
  (m.comp(compId)?.layers ?? []).forEach((id, i) => {
    const l = m.layer(id);
    if (!l) return;
    if (l.kind === 'precomp' && l.source) {
      if (m.comp(l.source)) collect(m, upstream, l.source, id, i);
    } else if (isLegacyGroup(l)) {
      collect(m, upstream, id, id, i);
    }
  });

  const downstream = new Map<string, NetworkEntry>();
  const self = m.layer(compId);
  if (self) {
    // A group opened as a comp is shown by its own place in the comp around it.
    if (self.comp) collect(m, downstream, self.comp, compId, 0);
  } else {
    for (const outer of m.compIds) {
      if (outer === compId) continue;
      (m.comp(outer)?.layers ?? []).forEach((id, i) => {
        const l = m.layer(id);
        if (l && l.kind === 'precomp' && l.source === compId) collect(m, downstream, outer, id, i);
      });
    }
  }

  const byName = (a: NetworkEntry, b: NetworkEntry): number => a.name.localeCompare(b.name);
  return {
    compId,
    name: mirrorCompName(m, compId),
    upstream: [...upstream.values()].sort(sort === 'layer' ? (a, b) => a.order - b.order : byName),
    downstream: [...downstream.values()].sort(byName),
  };
}
