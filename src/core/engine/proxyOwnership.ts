/**
 * Proxy ownership rule (B5 round 2, docs/ENGINE_API.md §15.6) — an ENGINE
 * rule, the same in both engines (C++: session.cpp `detach_proxy_ownership`).
 *
 * A plugin's `render: 'proxy'` layer generates ordinary child layers, each
 * marked `__ownedByPlugin: <pluginId>` on a component (the Layers tree shows
 * it; `setProxyChildren` only regenerates a subtree it still owns). When an
 * edit that is not the plugin's own (origin other than `plugin`) changes an
 * EXISTING owned layer, the whole proxy subtree stops being managed: every
 * mark under the proxy layer is written `null` — inside the same command, so
 * it is part of the command's inverse (undo re-attaches) and of the command
 * log (a replay detaches identically).
 *
 * The unit is the SUBTREE, not the edited child: a half-owned subtree is a
 * state neither the user nor the next regeneration can reason about
 * (plugins/proxySubtree.ts). A layer the command created or deleted does not
 * count (a pasted copy of a generated child is not an edit of it).
 */

import type { Origin } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { jsonEqual } from '@core/commands/snapshotSharing';
import { graph } from './doc';
import type { Parts } from './state';

/** The generated-child mark (plugins/customLayers.ts `OWNED_BY_KEY`). */
export const OWNED_BY_PROP = '__ownedByPlugin';

function isOwned(node: SceneNode | undefined): boolean {
  return !!node && node.components.some((c) => typeof (c.props as Record<string, unknown>)[OWNED_BY_PROP] === 'string');
}

/** The proxy layer above `id`: the parent of its topmost owned ancestor-or-self. */
function proxyRootOf(id: string): string {
  let top = id;
  let cur = graph.getNode(id);
  for (let guard = 0; cur && guard < 256; guard += 1) {
    if (isOwned(cur)) top = cur.id;
    if (!cur.parent) break;
    cur = graph.getNode(cur.parent);
  }
  return graph.getNode(top)?.parent ?? top;
}

/**
 * The owned layers to detach after one command: every owned layer under the
 * proxy layer of each existing owned layer the command changed. Empty for a
 * plugin's own write. `before` / `after` are the command's node captures.
 */
export function proxyLayersToDetach(origin: Origin, before: Parts, after: Parts): string[] {
  if (origin === 'plugin') return [];
  const roots: string[] = [];
  for (const [key, b] of before) {
    if (!key.startsWith('node:') || b === undefined) continue;
    const a = after.get(key);
    if (a === undefined || !isOwned(a as SceneNode) || jsonEqual(b, a)) continue;
    const root = proxyRootOf(key.slice(5));
    if (!roots.includes(root)) roots.push(root);
  }
  const out: string[] = [];
  const walk = (id: string): void => {
    if (isOwned(graph.getNode(id)) && !out.includes(id)) out.push(id);
    for (const c of graph.getChildOrder(id)) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** Clear the mark on each layer (the first component carrying it as a string, written `null`). */
export function detachProxyLayers(ids: readonly string[]): void {
  for (const id of ids) {
    const node = graph.getNode(id);
    const c = node?.components.find((x) => typeof (x.props as Record<string, unknown>)[OWNED_BY_PROP] === 'string');
    // `null`, not undefined: the scene graph's write treats undefined as "no change".
    if (c) graph.writeProp(id, c.id, OWNED_BY_PROP, null);
  }
}
