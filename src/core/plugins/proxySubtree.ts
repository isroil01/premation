/**
 * Regenerating a `proxy` layer's children, and who owns them afterwards.
 *
 * ── The contract this rests on ───────────────────────────────────────────────
 *
 * `onLayerChanged` fires for AUTHORED property edits only, never for animated
 * value changes. An animatable prop changes every frame during playback, so
 * firing on values would make per-frame regeneration the steady state rather
 * than an edge case — and coalescing cannot help, because coalescing protects
 * against a burst that ends and animation never ends.
 *
 * So the division of labour is: the plugin regenerates when the AUTHORED schema
 * changes; the host animates what was already generated, through ordinary
 * expression bindings on the children (`layer('<parent>', 'plugin.focal')`).
 *
 * ── Regeneration DIFFS, it does not delete and recreate ──────────────────────
 *
 * The obvious implementation — drop every child, add the new ones — is wrong in
 * a way that shows up far from its cause. Layer ids are referenced by
 * selection, by parenting, by expressions in other layers, and by the undo
 * stack. Churn them on every parameter tweak and a user's selection jumps, a
 * `layer('Blur 3', …)` in an unrelated expression goes dead, and undo granularity
 * collapses. So children are matched by a stable `key` the plugin supplies, and
 * an unchanged child keeps its id.
 *
 * ── Who owns a generated child ───────────────────────────────────────────────
 *
 * **Manual edit DETACHES the whole subtree from plugin ownership.**
 *
 * The alternative — refuse the edit — was rejected. The entire point of
 * `render: 'proxy'` is that the output is ORDINARY layers; a plugin's subtree
 * the user may look at but not touch is a black box, and it would make the
 * plugin's output the plugin's property rather than the user's document.
 *
 * Detaching the WHOLE subtree rather than the one child edited is deliberate
 * too: a half-owned subtree is a state neither side can reason about, and the
 * next regeneration would have to diff around a hole the user created. Whole is
 * comprehensible — "you have taken this over" — and it is reversible, because
 * re-attaching is just another regeneration.
 *
 * Nothing is destroyed either way. Detaching only clears a mark.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { rewriteNameRefsToIds } from './bindingMigration';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { bumpScene } from '@stores/sceneStore';
import type { SceneNode } from '../types';
import { OWNED_BY_KEY, ownerOf } from './customLayers';

/** One child a plugin wants to exist under its layer. */
export interface ProxyChildSpec {
  /**
   * Stable across regenerations. The whole diff turns on this: a child whose
   * key is unchanged keeps its scene-graph id, and everything referencing that
   * id keeps working.
   */
  key: string;
  kind: string;
  name?: string;
  /** Written onto the child's Transform component. */
  props?: Record<string, unknown>;
  /** Expressions to bind, by property path. See `authoredBy` below. */
  expressions?: Record<string, string>;
}

export interface RegenerateResult {
  created: string[];
  updated: string[];
  removed: string[];
  /** Set when the subtree was detached and the plugin no longer owns it. */
  refused?: 'detached';
}

/*
 * Is a regeneration in progress?
 *
 * The one thing that distinguishes a plugin writing to its own children from a
 * USER writing to them — both go through the same scene-graph calls. Without
 * this flag, a regeneration would detach the very subtree it was regenerating
 * on its first write.
 */
let regenerating = 0;

export function isRegenerating(): boolean {
  return regenerating > 0;
}

function withRegeneration<T>(fn: () => T): T {
  regenerating += 1;
  try {
    return fn();
  } finally {
    regenerating -= 1;
  }
}

/**
 * A user touched a plugin-owned layer.
 *
 * Called from the scene-graph write path. Detaches the whole subtree, once —
 * subsequent edits are then ordinary edits on ordinary layers.
 */
export function noteManualEdit(nodeId: string): void {
  if (isRegenerating()) return;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const owner = ownerOf(node);
  if (!owner) return;

  /*
    Detach from the PROXY LAYER, not from the node that was edited.

    The unit of ownership is the subtree, so the walk goes up to the topmost
    owned node and then one step further, to its unowned parent — the custom
    layer these children belong to. Detaching from the edited node alone would
    leave its SIBLINGS owned, which is the half-owned state this rule exists to
    avoid: the next regeneration would find some children managed and some not.
  */
  detachSubtree(proxyRootOf(nodeId) ?? nodeId, owner);
}

/** The proxy layer whose subtree contains `nodeId`, or null. */
function proxyRootOf(nodeId: string): string | null {
  let current = defaultSceneGraph.getNode(nodeId);
  let topmostOwned: SceneNode | null = null;
  let guard = 0;
  while (current && guard < 64) {
    if (ownerOf(current)) topmostOwned = current;
    const parentId = current.parent;
    if (!parentId) break;
    current = defaultSceneGraph.getNode(parentId);
    guard += 1;
  }
  if (!topmostOwned) return null;
  // The parent of the topmost owned node is the custom layer itself, which is
  // never marked owned — it belongs to the user, only its output is generated.
  return topmostOwned.parent ?? topmostOwned.id;
}

/** Clear plugin ownership from a node and everything under it. */
export function detachSubtree(nodeId: string, owner: string): void {
  const touched: string[] = [];
  const walk = (id: string): void => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return;
    if (ownerOf(node)) touched.push(id);
    for (const child of defaultSceneGraph.getChildren(id)) walk(child.id);
  };
  walk(nodeId);
  if (touched.length === 0) return;

  withRegeneration(() => {
    for (const id of touched) {
      const node = defaultSceneGraph.getNode(id);
      const component = node?.components.find(
        (c) => (c.props as Record<string, unknown>)[OWNED_BY_KEY] !== undefined,
      );
      // Written as `null`, not `undefined`: the scene graph's write path
      // treats undefined as "no change", so the mark would survive.
      // `isPluginOwned` tests for a STRING, so null reads as unowned.
      if (node && component) defaultSceneGraph.writeProp(id, component.id, OWNED_BY_KEY, null);
    }
  });
  console.info(`[plugins] "${owner}" no longer manages this subtree — you edited it.`);
  bumpScene();
}

/*
 * Regeneration rate limit, per plugin.
 *
 * A plugin that regenerates in response to its own regeneration is a loop the
 * HOST has to stop, not something to leave to author discipline — the failure
 * mode is a wedged editor, and the author's own testing is exactly where a
 * one-plugin loop is least likely to show up.
 */
const MAX_REGENERATIONS_PER_WINDOW = 20;
const WINDOW_MS = 1000;
const recent = new Map<string, number[]>();

export function regenerationAllowed(pluginId: string, now: number): boolean {
  const times = (recent.get(pluginId) ?? []).filter((t) => now - t < WINDOW_MS);
  times.push(now);
  recent.set(pluginId, times);
  return times.length <= MAX_REGENERATIONS_PER_WINDOW;
}

export function resetRateLimitForTests(): void {
  recent.clear();
}

/**
 * Bring a proxy layer's children into line with what the plugin asked for.
 *
 * One `runDocumentEdit` entry for the whole thing — a regeneration is one
 * conceptual action, and a user undoing "Depth Image: update layers" should not
 * have to press Ctrl+Z once per generated child.
 */
export function regenerateProxyChildren(
  parentId: string,
  pluginId: string,
  pluginName: string,
  specs: readonly ProxyChildSpec[],
  now = 0,
): RegenerateResult {
  const parent = defaultSceneGraph.getNode(parentId);
  if (!parent) return { created: [], updated: [], removed: [] };

  // The user has taken this subtree over. Refused rather than overwritten:
  // silently overwriting is exactly what the ownership mark exists to prevent.
  const existingChildren = defaultSceneGraph.getChildren(parentId);
  const anyOwned = existingChildren.some((c) => ownerOf(c) === pluginId);
  if (existingChildren.length > 0 && !anyOwned) {
    return { created: [], updated: [], removed: [], refused: 'detached' };
  }

  if (!regenerationAllowed(pluginId, now)) {
    console.warn(
      `[plugins] "${pluginId}" regenerated too often and was stopped. `
      + 'A plugin that regenerates in response to its own regeneration is a loop.',
    );
    return { created: [], updated: [], removed: [] };
  }

  const result: RegenerateResult = { created: [], updated: [], removed: [] };
  // Captured once: the diff may rename children, and every binding in this
  // pass must resolve against the same parent.
  const parentRef = { id: parentId, name: parent.name ?? parentId };

  runDocumentEdit(`${pluginName}: update layers`, () => {
    withRegeneration(() => {
      const byKey = new Map<string, SceneNode>();
      for (const child of existingChildren) {
        const key = keyOf(child);
        if (key !== null) byKey.set(key, child);
      }

      const wanted = new Set(specs.map((s) => s.key));

      // Gone from the plugin's answer.
      for (const [key, child] of byKey) {
        if (wanted.has(key)) continue;
        defaultSceneGraph.removeNode(child.id);
        result.removed.push(child.id);
      }

      for (const spec of specs) {
        const existing = byKey.get(spec.key);
        if (existing) {
          // Matched: keep the ID. Everything referencing it — selection,
          // parenting, another layer's expression — keeps working.
          applySpec(existing.id, spec, pluginId, parentRef);
          result.updated.push(existing.id);
          continue;
        }
        const id = `${parentId}__${sanitiseKey(spec.key)}`;
        defaultSceneGraph.addChild(parentId, buildChild(id, spec, pluginId));
        applySpec(id, spec, pluginId, parentRef);
        result.created.push(id);
      }
    });
    bumpScene();
  });

  return result;
}

/** The stable key a generated child was created with. */
function keyOf(node: SceneNode): string | null {
  for (const c of node.components ?? []) {
    const key = (c.props as Record<string, unknown>)?.__proxyKey;
    if (typeof key === 'string') return key;
  }
  return null;
}

/** Ids appear in expressions and selectors, so keep them boring. */
function sanitiseKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

function buildChild(id: string, spec: ProxyChildSpec, pluginId: string): SceneNode {
  return {
    id,
    name: spec.name?.slice(0, 80) || spec.key,
    children: [],
    parent: null,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{
      id: `${id}_t`,
      type: 'Transform',
      props: {
        __kind: spec.kind,
        __proxyKey: spec.key,
        // Marked in the DOCUMENT, not only in the UI: a user opening this
        // project on another machine has to be able to see that these layers
        // are managed, and the layer tree reads the same field.
        [OWNED_BY_KEY]: pluginId,
        x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100,
      },
    }],
  };
}

function applySpec(id: string, spec: ProxyChildSpec, pluginId: string, parent?: { id: string; name: string }): void {
  const node = defaultSceneGraph.getNode(id);
  const component = node?.components.find((c) => c.type === 'Transform');
  if (!node || !component) return;

  // Re-marked on every pass: a child that somehow lost its mark and is still
  // being generated is a child the plugin still owns.
  defaultSceneGraph.writeProp(id, component.id, OWNED_BY_KEY, pluginId);
  defaultSceneGraph.writeProp(id, component.id, '__proxyKey', spec.key);
  if (spec.name) node.name = spec.name.slice(0, 80);

  for (const [name, value] of Object.entries(spec.props ?? {})) {
    if (name.startsWith('__')) continue; // Bookkeeping is the host's.
    defaultSceneGraph.writeProp(id, component.id, name, value);
  }

  /*
    Bindings, with provenance.

    This is how a proxy layer ANIMATES: the child references the parent's
    animated property (`layer('Depth Image', 'plugin.focal')`) and the engine
    evaluates it, so the subtree keeps animating in a document opened with the
    plugin uninstalled — no plugin involved at runtime.

    `authoredBy` is not decoration. Proxy output is expression-bearing by
    design, so a document ends up full of expressions the user did not write.
    Without an origin label, "why does this layer have an expression on it"
    becomes unanswerable months later, and the answer is not recoverable from
    anything else in the file.
  */
  const bound = parent
    ? bindByStableId(spec.expressions ?? {}, parent.id, parent.name)
    : (spec.expressions ?? {});
  for (const [prop, src] of Object.entries(bound)) {
    defaultAnimation.setExpression(id, prop, src, pluginId);
  }
}

/**
 * Rewrite a plugin's `layer('<name>', …)` references to `#<id>`, at AUTHORING
 * time.
 *
 * A plugin naturally writes its parent's NAME — it is what the author sees and
 * what reads naturally. Resolving that to a stable id here, once, is what makes
 * the binding survive a rename: nothing at evaluation time ever looks a layer
 * up by name again.
 *
 * A name that resolves to nothing is left alone rather than rewritten to
 * `#undefined`, which would turn an already-broken reference into a
 * permanently broken and untraceable one.
 */
function bindByStableId(
  expressions: Record<string, string>,
  parentId: string,
  parentName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [prop, src] of Object.entries(expressions)) {
    // The shared rewrite, so the authoring path and the load-time migration
    // cannot disagree about what a reference looks like.
    out[prop] = rewriteNameRefsToIds(src, (ref) => (
      // The overwhelmingly common case first: the plugin named its own layer.
      ref === parentName ? parentId : findNodeIdByName(ref)
    )).src;
  }
  return out;
}

function findNodeIdByName(name: string): string | null {
  let found: string | null = null;
  defaultSceneGraph.traverse((n) => {
    if (found === null && n.name === name) found = n.id;
  });
  return found;
}
