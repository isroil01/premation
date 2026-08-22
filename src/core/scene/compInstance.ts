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
import { applyOverridesToComponents, overriddenPropsFor, readCompOverrides, type OverrideValue } from './compInstanceOverrides';

/** Shared empty map — an expansion with no Essential Properties allocates none. */
const EMPTY_OVERRIDES: ReadonlyMap<string, OverrideValue> = new Map();

type SceneGraph = typeof SceneGraphT;

/** Stored on the instance's fx component alongside the precomp flag. */
export const COMP_REF_PROP = '__compRef';

/** Collapse Transformations (AE's sunburst switch). Stored on the same fx. */
export const COMP_COLLAPSE_PROP = 'collapseTransforms';

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
 * Collapse Transformations: the placed composition does NOT flatten to a
 * texture. Its layers are spliced straight into the host, so they meet the
 * host's camera, its 3D depth sort and its lights as ordinary layers.
 *
 * This is the bridge between 2D and 3D composition, and without it a nested comp
 * is a hard 2D barrier: build a 3D scene out of reusable comps and every one of
 * them collapses to a flat card the moment it is placed. It is also why a
 * collapsed comp is deliberately NOT cropped to its own frame — there is no
 * intermediate frame to crop against, which matches After Effects.
 */
export function readCompCollapse(node: SceneNode): boolean {
  if (readCompRef(node) === null) return false;
  for (const c of renderComponentsOf(node)) {
    if ((c.props as Record<string, unknown>)[COMP_COLLAPSE_PROP] === true) return true;
  }
  return false;
}

/**
 * True for a clone that sits DIRECTLY under a comp instance — the top of an
 * expanded composition.
 *
 * A referenced composition's layers are authored in ITS OWN coordinate space,
 * not the host's. The instance node is their `parent` so that precomp routing
 * and time-remap inheritance (both of which walk `parent`) still find the
 * container, but its TRANSFORM must not compose into them: the instance's
 * position is applied once, to the container, and applying it again per child
 * added the two together. A comp centred at (540, 960) placed at (960, 540)
 * landed at (1500, 1500) — off the bottom of a 1080-tall host frame.
 *
 * `buildSnapshot.parentOf` stops the transform chain here; nothing else does.
 */
export function isCompInstanceRoot(node: SceneNode | undefined): boolean {
  return !!node && (node as unknown as Record<string, unknown>).__compInstanceRoot === true;
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
  /**
   * Which instances to expand INLINE. Defaults to all of them.
   *
   * The renderer passes `readCompCollapse`, because the two kinds of placed
   * composition want opposite treatment: a COLLAPSED one belongs in the host's
   * walk (that is what lets its layers meet the host's camera and depth sort),
   * while a sealed one is rendered by its own recursive `buildSnapshot` pass —
   * through its OWN camera, at its own size — and must therefore be left in the
   * list as an un-expanded `comp` node for that walk to pick up.
   */
  expandIf: (node: SceneNode) => boolean = () => true,
): SceneNode[] {
  if (!nodes.some((n) => readCompRef(n) !== null)) return nodes;

  const out: SceneNode[] = [];

  const cloneSubtree = (
    origs: ReadonlyArray<SceneNode>,
    parentId: string,
    prefix: string,
    stack: ReadonlyArray<string>,
    depth: number,
    /** True for the top level of an expansion — see {@link isCompInstanceRoot}. */
    atInstanceRoot = false,
    /**
     * Essential Properties for the instance whose expansion this is. Scoped to
     * that instance rather than accumulated down the tree: a nested instance
     * starts a fresh set (its own), so an override always belongs to exactly
     * one placement and two instances of one comp cannot read each other's.
     */
    overrides: ReadonlyMap<string, OverrideValue> = EMPTY_OVERRIDES,
  ): void => {
    if (depth > MAX_INSTANCE_DEPTH) return;
    for (const orig of origs) {
      const cid = `${prefix}${orig.id}`;
      const ovProps = overriddenPropsFor(overrides, orig.id);
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
        // Essential Properties: the STATIC half. The animated half is
        // `buildSnapshot` dropping these props from the clone's evaluated
        // values — without it a keyframed layer ignores its override every
        // frame. See compInstanceOverrides.ts.
        components: applyOverridesToComponents(orig.components, overrides, orig.id),
        __instanceSource: orig.id,
        // Carried on the CLONE rather than looked up by id in buildSnapshot:
        // the clone's id encodes its instance chain, so re-deriving the owning
        // instance there would mean re-parsing `::` prefixes — a second place
        // that has to agree with this one about what an id means.
        ...(ovProps ? { __overriddenProps: ovProps } : {}),
        ...(atInstanceRoot ? { __compInstanceRoot: true } : {}),
      } as unknown as SceneNode;
      out.push(clone);

      const ref = readCompRef(orig);
      if (ref !== null) {
        // A nested instance inside the referenced comp: expand ITS reference
        // (deeper prefix), unless that would re-enter a comp already open.
        // An instance the predicate rejects stays a bare `comp` node, which the
        // renderer's walk then renders through its own recursive pass.
        if (expandIf(orig) && !stack.includes(ref) && graph.getNode(ref)) {
          // Collapsed ⇒ NOT a transform barrier: the whole point is that the
          // inner layers' transforms compose through into the host.
          // A nested instance carries its OWN overrides, not the outer one's.
          cloneSubtree(
            graph.getChildren(ref), cid, `${cid}::`, [...stack, ref], depth + 1,
            !readCompCollapse(orig), readCompOverrides(orig),
          );
        }
      } else {
        // Descendants keep composing normally — only the TOP of an expansion is
        // a transform barrier.
        cloneSubtree(graph.getChildren(orig.id), cid, prefix, stack, depth, false, overrides);
      }
    }
  };

  for (const node of nodes) {
    out.push(node);
    const ref = readCompRef(node);
    if (ref === null) continue;
    if (!expandIf(node)) continue; // rendered by its own pass, not expanded here
    if (ref === activeRootId || !graph.getNode(ref)) continue; // self/dangling
    const stack = activeRootId ? [activeRootId, ref] : [ref];
    cloneSubtree(
      graph.getChildren(ref), node.id, `${node.id}::`, stack, 1,
      !readCompCollapse(node), readCompOverrides(node),
    );
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
