/**
 * Comp instances — a composition used as a LAYER inside another composition,
 * AE's core organizing model. An instance is a real scene node (kind `comp`)
 * flagged as a precomp and carrying a `__compRef` to the referenced comp's
 * root. It has no graph children of its own: at snapshot time the renderer
 * expands it into render-only CLONES of the referenced comp's subtree, routed
 * through the existing precomp texture path. The clones' ids are prefixed per
 * instance (`<instanceId>::<origId>`) so one comp can be placed many times;
 * animation and timeline clips are sampled from the ORIGINAL nodes via
 * `instanceSourceOf`.
 *
 * Cycle-safe: expansion tracks the stack of comp roots being expanded and
 * refuses to re-enter one (A ⊂ B ⊂ A renders A's copy of B with the nested A
 * instance empty), plus a hard depth cap.
 */

import type { SceneNode } from '@core/types';
import type SceneGraphT from './DefaultSceneGraph';
import { renderComponentsOf } from './SceneGraph';

type SceneGraph = typeof SceneGraphT;

/** Stored on the instance's fx component alongside the precomp flag. */
export const COMP_REF_PROP = '__compRef';

/** Max nesting depth for instance-in-instance expansion. */
const MAX_INSTANCE_DEPTH = 8;

/** The referenced composition root id, when `node` is a comp instance. */
export function readCompRef(node: SceneNode): string | null {
  // `renderComponentsOf`, not `node.components`: `expandCompInstances` calls this
  // for every node of the composition, every frame, on live views — see
  // `readNodeKind`. Read-only.
  for (const c of renderComponentsOf(node)) {
    const v = (c.props as Record<string, unknown>)[COMP_REF_PROP];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** The ORIGINAL node id a render-only clone was expanded from (id-indirection
 *  for animation/clip sampling), or null for real nodes. */
export function instanceSourceOf(node: SceneNode | undefined): string | null {
  const v = node && (node as unknown as Record<string, unknown>).__instanceSource;
  return typeof v === 'string' ? v : null;
}

/**
 * Expand every comp-instance node in `nodes` (a flattened composition, DFS
 * order) by appending render-only clones of the referenced comp's subtree
 * directly after it. Returns the input array unchanged when there are no
 * instances, so single-comp documents pay nothing.
 *
 * `activeRootId` seeds the cycle stack — an instance of the comp it sits in
 * expands to nothing.
 */
export function expandCompInstances(
  graph: SceneGraph,
  nodes: SceneNode[],
  activeRootId?: string,
): SceneNode[] {
  if (!nodes.some((n) => readCompRef(n) !== null)) return nodes;

  const out: SceneNode[] = [];

  const cloneSubtree = (
    origs: ReadonlyArray<SceneNode>,
    parentId: string,
    prefix: string,
    stack: ReadonlyArray<string>,
    depth: number,
  ): void => {
    if (depth > MAX_INSTANCE_DEPTH) return;
    for (const orig of origs) {
      const cid = `${prefix}${orig.id}`;
      // Explicit field reads, NOT an object spread: graph node views expose
      // `components` etc. through prototype getters, which a spread drops —
      // the clone would arrive at the renderer with no components at all.
      const clone = {
        id: cid,
        name: orig.name,
        parent: parentId,
        children: [],
        transform: orig.transform,
        visible: orig.visible,
        locked: orig.locked,
        // Solo must not leak across comps: a soloed node in the source comp
        // would otherwise blank every OTHER layer of the host comp.
        solo: false,
        components: orig.components,
        __instanceSource: orig.id,
      } as unknown as SceneNode;
      out.push(clone);

      const ref = readCompRef(orig);
      if (ref !== null) {
        // A nested instance inside the referenced comp: expand ITS reference
        // (deeper prefix), unless that would re-enter a comp already open.
        if (!stack.includes(ref) && graph.getNode(ref)) {
          cloneSubtree(graph.getChildren(ref), cid, `${cid}::`, [...stack, ref], depth + 1);
        }
      } else {
        cloneSubtree(graph.getChildren(orig.id), cid, prefix, stack, depth);
      }
    }
  };

  for (const node of nodes) {
    out.push(node);
    const ref = readCompRef(node);
    if (ref === null) continue;
    if (ref === activeRootId || !graph.getNode(ref)) continue; // self/dangling
    const stack = activeRootId ? [activeRootId, ref] : [ref];
    cloneSubtree(graph.getChildren(ref), node.id, `${node.id}::`, stack, 1);
  }
  return out;
}

/**
 * Would placing an instance of `refCompId` inside `hostCompId` create a
 * reference cycle? True when `hostCompId` is reachable from `refCompId`
 * through existing instance references.
 */
export function wouldCreateCompCycle(
  graph: SceneGraph,
  hostCompId: string,
  refCompId: string,
): boolean {
  if (hostCompId === refCompId) return true;
  const seen = new Set<string>();
  const reaches = (compId: string): boolean => {
    if (compId === hostCompId) return true;
    if (seen.has(compId)) return false;
    seen.add(compId);
    const root = graph.getNode(compId);
    if (!root) return false;
    let found = false;
    const walk = (n: SceneNode): void => {
      if (found) return;
      const ref = readCompRef(n);
      if (ref !== null && reaches(ref)) { found = true; return; }
      for (const c of graph.getChildren(n.id)) walk(c);
    };
    for (const c of graph.getChildren(compId)) walk(c);
    return found;
  };
  return reaches(refCompId);
}
