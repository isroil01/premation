/**
 * Turning a cloner config into actual renderables.
 *
 * `cloner.ts` decides where clone `i` goes; this puts N copies of the layer
 * into the node list for the renderer to walk. It is the same shape as
 * `expandCompInstances` — flat list in, longer flat list out, ids prefixed so a
 * clone can never collide with the original — and deliberately so: two
 * expansion mechanisms that behave differently about ids, parents or subtrees
 * would be two sets of bugs.
 *
 * ── What gets cloned ────────────────────────────────────────────────────────
 *
 * The layer AND its descendants. Cloning the layer alone would silently drop
 * the children of any group, so a cloned group would render as an empty box —
 * and groups are the obvious thing to clone.
 *
 * ── Where the offset lands ──────────────────────────────────────────────────
 *
 * Only on the clone ROOT, as `__cloneOffset`. Descendants inherit it through
 * the ordinary parent composition the renderer already does; writing it onto
 * every descendant too would apply it once per level of nesting.
 *
 * The offset is ADDITIVE (multiplicative for scale and opacity), and
 * `buildSnapshot` applies it to the RESOLVED transform. That is the whole
 * reason it is a separate field rather than a component patch: a cloner offsets
 * what the layer already animates to, so patching a component would be outvoted
 * by a keyframed x, and suppressing the track instead would throw the animation
 * away. Clones are meant to move WITH the layer and spread apart from each
 * other.
 */

import type { SceneNode } from '@core/types';
import { renderComponentsOf } from './SceneGraph';
import { clonerPlan, cloneCount, DEFAULT_CLONER, type ClonerConfig, type CloneTransform } from './cloner';

/** Stored on the layer's fx component. */
export const CLONER_PROP = '__cloner';
/** Carried on an expanded clone root; read by buildSnapshot. */
export const CLONE_OFFSET_PROP = '__cloneOffset';

/** The cloner config on a node, or null when it has none / is disabled. */
export function readNodeCloner(node: SceneNode | undefined): ClonerConfig | null {
  if (!node) return null;
  for (const c of renderComponentsOf(node)) {
    const raw = (c.props as Record<string, unknown>)[CLONER_PROP];
    if (!raw || typeof raw !== 'object') continue;
    const cfg = { ...DEFAULT_CLONER, ...(raw as Partial<ClonerConfig>) };
    // Nested objects merge too, or a config saved before a field existed would
    // arrive with `step`/`random`/`falloff` partially undefined and every read
    // of them would be NaN.
    cfg.step = { ...DEFAULT_CLONER.step, ...(cfg.step ?? {}) };
    cfg.random = { ...DEFAULT_CLONER.random, ...(cfg.random ?? {}) };
    cfg.falloff = { ...DEFAULT_CLONER.falloff, ...(cfg.falloff ?? {}) };
    return cfg.enabled ? cfg : null;
  }
  return null;
}

/** The clone offset carried on an expanded node, or null. */
export function cloneOffsetOf(node: SceneNode | undefined): CloneTransform | null {
  return (node as unknown as { [CLONE_OFFSET_PROP]?: CloneTransform })?.[CLONE_OFFSET_PROP] ?? null;
}

/** Ids of `rootId` and everything under it, in list order. */
function subtreeOf(nodes: ReadonlyArray<SceneNode>, rootId: string): SceneNode[] {
  const ids = new Set([rootId]);
  const out: SceneNode[] = [];
  for (const n of nodes) {
    if (n.id === rootId || (n.parent !== null && n.parent !== undefined && ids.has(n.parent))) {
      ids.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/**
 * Replace every cloner layer in `nodes` with its clones.
 *
 * The ORIGINAL is dropped: a cloner set to 5 shows five clones, not five plus
 * the source sitting under clone 0. (Clone 0 of a default config sits exactly
 * where the source did, so keeping it would read as a stuck duplicate that
 * cannot be selected.)
 *
 * Returns the input array unchanged when no node carries a cloner, so the
 * common case allocates nothing.
 */
export function expandCloners(nodes: SceneNode[]): SceneNode[] {
  const cloners = nodes.filter((n) => readNodeCloner(n) !== null);
  if (cloners.length === 0) return nodes;

  // A cloner INSIDE another cloner's subtree is skipped: its layers are already
  // being multiplied by the outer one, and expanding both would multiply the
  // counts together — 20×20 renderables from two innocuous-looking controls.
  const consumed = new Set<string>();
  for (const c of cloners) {
    for (const n of subtreeOf(nodes, c.id)) {
      if (n.id !== c.id) consumed.add(n.id);
    }
  }
  const active = cloners.filter((c) => !consumed.has(c.id));
  if (active.length === 0) return nodes;

  const activeIds = new Set(active.map((c) => c.id));
  const dropped = new Set<string>();
  const subtrees = new Map<string, SceneNode[]>();
  for (const c of active) {
    const sub = subtreeOf(nodes, c.id);
    subtrees.set(c.id, sub);
    for (const n of sub) dropped.add(n.id);
  }

  const out: SceneNode[] = [];
  for (const node of nodes) {
    if (!activeIds.has(node.id)) {
      // Everything not part of a cloner subtree passes straight through.
      if (!dropped.has(node.id)) out.push(node);
      continue;
    }
    const cfg = readNodeCloner(node)!;
    const plan = clonerPlan(cfg);
    const sub = subtrees.get(node.id)!;
    for (const clone of plan) {
      const prefix = `${node.id}~c${clone.index}::`;
      for (const orig of sub) {
        const isRoot = orig.id === node.id;
        // Explicit field reads, NOT a spread: graph node views expose these
        // through prototype getters and a spread drops them — the clone would
        // reach the renderer with no components at all. Same trap as
        // expandCompInstances.
        out.push({
          id: isRoot ? `${prefix}root` : `${prefix}${orig.id}`,
          name: orig.name,
          parent: isRoot ? orig.parent : (orig.parent === node.id ? `${prefix}root` : `${prefix}${orig.parent}`),
          children: [],
          transform: orig.transform,
          visible: orig.visible,
          locked: orig.locked,
          solo: false,
          components: orig.components,
          // Source id, so animation reads route to the ORIGINAL's tracks —
          // every clone animates, rather than only the one whose id survived.
          __instanceSource: orig.id,
          ...(isRoot ? { [CLONE_OFFSET_PROP]: clone } : {}),
        } as unknown as SceneNode);
      }
    }
  }
  return out;
}

/** Clone count a config would produce — for the inspector's cost readout. */
export { cloneCount };
