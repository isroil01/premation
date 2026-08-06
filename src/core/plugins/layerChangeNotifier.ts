/**
 * Telling a plugin that one of its layers was AUTHORED.
 *
 * The whole contract lives in what this file refuses to do.
 *
 * An animatable property changes value every frame during playback. If those
 * changes reached a plugin, per-frame regeneration would be the steady state —
 * not an edge case, the normal case — and coalescing could not save it, because
 * coalescing protects against a burst that ENDS and animation never ends. So
 * the only thing that ever reaches a plugin from here is a user editing an
 * authored value: a drag, a typed number, a picked enum.
 *
 * Animated values reach the generated children a different way entirely: the
 * children hold expression bindings onto the parent's properties, and the
 * animation engine evaluates them. No plugin is involved at runtime, which is
 * also why a proxy subtree keeps animating in a document opened without the
 * plugin installed.
 *
 * Coalescing is still needed, for the case it actually fits: a drag emits a
 * change per pointer event, and a plugin should regenerate once when the drag
 * settles rather than sixty times on the way there.
 */

import { splitKind } from './layerKindSchema';

/** What a plugin is told. Deliberately small: an id and what changed. */
export interface LayerChangedEvent {
  layerId: string;
  kindId: string;
  /** Authored property names that changed since the last delivery. */
  props: string[];
}

type Listener = (event: LayerChangedEvent) => void;

/** `<pluginId>::<kindId>` → the plugin's callback. */
const listeners = new Map<string, Listener>();

/** Pending coalesced changes, per layer. */
const pending = new Map<string, { kind: string; props: Set<string> }>();
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long a burst is allowed to settle.
 *
 * Long enough that a drag is one regeneration; short enough that a single
 * click-and-release still feels immediate. The same order as the history
 * store's own coalescing window, deliberately — a regeneration that lands in a
 * different undo entry from the edit that caused it is a confusing undo.
 */
const COALESCE_MS = 120;

export function onLayerChanged(pluginId: string, kindId: string, fn: Listener): () => void {
  const key = `${pluginId}::${kindId}`;
  listeners.set(key, fn);
  return () => listeners.delete(key);
}

export function clearLayerChangeListeners(pluginId?: string): void {
  if (!pluginId) { listeners.clear(); return; }
  for (const key of [...listeners.keys()]) {
    if (key.startsWith(`${pluginId}::`)) listeners.delete(key);
  }
}

/**
 * An authored property on a custom layer changed.
 *
 * Call ONLY from an authored write path. There is deliberately no variant of
 * this that animation can reach — the safest way to keep a contract like this
 * is for the wrong call not to exist.
 */
export function notifyAuthoredChange(layerId: string, kind: string, propName: string): void {
  const entry = pending.get(layerId) ?? { kind, props: new Set<string>() };
  entry.props.add(propName);
  pending.set(layerId, entry);

  if (timer) return;
  timer = setTimeout(flush, COALESCE_MS);
}

/** Deliver everything pending. Exported so a test need not wait on a timer. */
export function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = [...pending];
  pending.clear();

  for (const [layerId, { kind, props }] of batch) {
    const split = splitKind(kind);
    if (!split) continue;
    const listener = listeners.get(`${split.pluginId}::${split.kindId}`);
    // No listener is the normal case — most plugins never register one, and a
    // pending entry for a plugin that is not listening must not accumulate.
    if (!listener) continue;
    try {
      listener({ layerId, kindId: split.kindId, props: [...props].sort() });
    } catch (err) {
      // A throwing listener must not take the others down with it, and must
      // not leave the batch half-delivered.
      console.warn(`[plugins] onLayerChanged listener for "${split.pluginId}" threw:`, err);
    }
  }
}

/** Anything waiting to be delivered? For tests and for a clean shutdown. */
export function pendingCount(): number {
  return pending.size;
}

export function resetNotifierForTests(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  pending.clear();
  listeners.clear();
}
