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
import { bumpScene } from '@stores/sceneStore';
import type { Command } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { compOfLayer, layerSubtree } from '@core/engine/doc';
import { buildLayerFragment, type BuiltLayers } from '@core/engine/offDocument';
import { propRefForTrack } from '@core/engine/propRefs';
import { activePlayheadSeconds, propWriteCommand } from '@core/engine/trackWrites';
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
 * ONE engine batch for the whole thing (B5, origin plugin) — a regeneration is
 * one conceptual action, and a user undoing "Depth Image: update layers"
 * should not have to press Ctrl+Z once per generated child:
 *
 *   gone       `deleteLayers` of the children the plugin no longer lists;
 *   matched    keep their ids — `renameLayer`, a `setProperty` per changed
 *              prop, a `setExpression` (owner: the plugin) per changed binding;
 *   new        built off-document (marked, props and bindings in place) and
 *              inserted with ONE `pasteLayers` into the proxy layer — the
 *              engine mints their ids.
 *
 * A prop or binding the engine API does not address on a matched child is
 * refused (the whole regeneration, before anything is sent) rather than
 * written around the engine.
 */
export async function regenerateProxyChildren(
  parentId: string,
  pluginId: string,
  pluginName: string,
  specs: readonly ProxyChildSpec[],
  now = 0,
): Promise<RegenerateResult> {
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

  const comp = compOfLayer(parentId);
  if (!comp) throw new Error(`"${parent.name ?? parentId}" is not a layer of a composition, so its children cannot be generated.`);

  const result: RegenerateResult = { created: [], updated: [], removed: [] };
  // Captured once: the diff may rename children, and every binding in this
  // pass must resolve against the same parent.
  const parentRef = { id: parentId, name: parent.name ?? parentId };

  const byKey = new Map<string, SceneNode>();
  for (const child of existingChildren) {
    const key = keyOf(child);
    if (key !== null) byKey.set(key, child);
  }
  const wanted = new Set(specs.map((s) => s.key));

  const cmds: Command[] = [];
  // Gone from the plugin's answer.
  const doomed: string[] = [];
  for (const [key, child] of byKey) {
    if (wanted.has(key)) continue;
    for (const id of layerSubtree(child.id) ?? [child.id]) if (!doomed.includes(id)) doomed.push(id);
    result.removed.push(child.id);
  }
  if (doomed.length > 0) cmds.push({ type: 'deleteLayers', layers: doomed } as Command);

  // Matched: keep the ID. Everything referencing it — selection, parenting,
  // another layer's expression — keeps working.
  const refused: string[] = [];
  const fresh: ProxyChildSpec[] = [];
  for (const spec of specs) {
    const existing = byKey.get(spec.key);
    if (!existing) { fresh.push(spec); continue; }
    cmds.push(...updateCommands(existing, spec, pluginId, parentRef, refused));
    result.updated.push(existing.id);
  }
  if (refused.length > 0) {
    throw new Error(`These generated values are not properties the engine can set: ${refused.join(', ')}.`);
  }

  // New: built whole, off-document, and pasted into the proxy layer.
  let built: BuiltLayers | null = null;
  if (fresh.length > 0) {
    // Regenerating: the scratch writes are not a user's edit (no detach).
    regenerating += 1;
    try {
      built = buildLayerFragment(comp, () => {
        for (const spec of fresh) {
          const id = `${parentId}__${sanitiseKey(spec.key)}`;
          defaultSceneGraph.addChild(parentId, buildChild(id, spec, pluginId));
          // Props and bindings in place (SCRATCH writes: the build is off-document).
          const t = defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Transform');
          for (const [name, value] of Object.entries(spec.props ?? {})) {
            if (name.startsWith('__') || !t) continue; // Bookkeeping is the host's.
            defaultSceneGraph.writeProp(id, t.id, name, value);
          }
          for (const [prop, src] of Object.entries(bindByStableId(spec.expressions ?? {}, parentRef.id, parentRef.name))) {
            defaultAnimation.setExpression(id, prop, src, pluginId);
          }
        }
      });
    } finally {
      regenerating -= 1;
    }
    if (built) {
      cmds.push({
        type: 'pasteLayers', comp, fragment: built.fragment, index: built.index, ...(built.parent ? { parent: built.parent } : {}),
      } as Command);
    }
  }
  if (cmds.length === 0) return result;

  // The engine's own writes are not a user's edit either (no detach).
  regenerating += 1;
  const res = await engine()
    .batch(`${pluginName}: update layers`, cmds, { origin: 'plugin' })
    .finally(() => { regenerating -= 1; });
  if (!res.ok) throw new Error(res.error.message || res.error.code);
  if (built) {
    const pasted = res.value[res.value.length - 1] as { layers?: string[] } | undefined;
    const ids = pasted?.layers ?? [];
    // The fragment's top layers are the new children, in build order.
    for (const top of built.tops) {
      const at = built.scratchIds.indexOf(top);
      const id = at >= 0 ? ids[at] : undefined;
      if (id) result.created.push(id);
    }
  }
  return result;
}

/** A matched child's changes as engine commands (props that did not change send nothing). */
function updateCommands(
  child: SceneNode,
  spec: ProxyChildSpec,
  pluginId: string,
  parent: { id: string; name: string },
  refused: string[],
): Command[] {
  const out: Command[] = [];
  const t = child.components.find((c) => c.type === 'Transform');
  if (!t) return out;
  const name = spec.name?.slice(0, 80);
  if (name && child.name !== name) out.push({ type: 'renameLayer', layer: child.id, name } as Command);
  const at = activePlayheadSeconds();
  const props = t.props as Record<string, unknown>;
  for (const [key, value] of Object.entries(spec.props ?? {})) {
    if (key.startsWith('__')) continue; // Bookkeeping is the host's.
    if (Object.is(props[key], value)) continue;
    const cmds = propWriteCommand(child, t.id, key, value, at);
    if (cmds) out.push(...cmds);
    else refused.push(`${spec.key}.${key}`);
  }
  /*
    Bindings, with provenance (`owner`): this is how a proxy layer ANIMATES —
    the child references the parent's animated property and the engine
    evaluates it, so the subtree keeps animating in a document opened with the
    plugin uninstalled. Proxy output is expression-bearing by design, so a
    document ends up full of expressions the user did not write; the origin
    label is what keeps "why does this layer have an expression" answerable.
  */
  for (const [prop, src] of Object.entries(bindByStableId(spec.expressions ?? {}, parent.id, parent.name))) {
    if (defaultAnimation.getExpressionSrc(child.id, prop) === src && defaultAnimation.expressionsAuthoredBy(pluginId).some((e) => e.nodeId === child.id && e.prop === prop)) continue;
    const r = propRefForTrack(child.id, prop);
    if (!r || !r.members.includes(prop)) { refused.push(`${spec.key}.${prop} (expression)`); continue; }
    const enabled = defaultAnimation.hasExpression(child.id, prop) ? defaultAnimation.isExpressionEnabled(child.id, prop) : true;
    out.push({
      type: 'setExpression', prop: r.ref, source: src, enabled, owner: pluginId,
      ...(r.members.length > 1 ? { member: r.member } : {}),
    } as Command);
  }
  return out;
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
