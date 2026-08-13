/**
 * Which layer kinds exist right now, and who may touch them.
 *
 * A kind is registered when its plugin becomes ENABLED and unregistered when it
 * stops. That is deliberately not the same as "is running": a declared kind has
 * to be creatable from a menu before its worker has ever booted, exactly as a
 * declared command is — otherwise every plugin has to start at launch just so
 * its layer type appears, which is the problem `activationEvents` exists to
 * solve.
 *
 * ── Own kinds only, enforced here ────────────────────────────────────────────
 *
 * A plugin may create, modify and observe only the kinds it declared. This is a
 * permission-class boundary, not a tidiness rule: a plugin that could write
 * another's layers could rewrite the authored interface of software the user
 * trusts differently, and a plugin that could observe them would see a document
 * it was never granted `scene:read` over in any meaningful sense.
 *
 * It is enforced in the HOST, on the resolved kind string, because the caller
 * is across a `postMessage` boundary and everything it sends is untrusted text.
 * A refusal is named and logged like any other refused call — silence here
 * would present to the author as "my createLayer does nothing".
 *
 * ── Unregistration is a real requirement ─────────────────────────────────────
 *
 * A stopped plugin's kinds must disappear. Leaving them registered means a menu
 * that offers to create a layer nothing can drive, and a document that gains a
 * reference to a plugin the user has already turned off.
 */

import type { LayerKindContribution } from './layerKindSchema';
import { splitKind } from './layerKindSchema';

interface RegisteredKind {
  pluginId: string;
  /** The plugin's display name, for undo labels and menus. */
  pluginName: string;
  kind: LayerKindContribution;
}

/** `<pluginId>.<kindId>` → what is registered for it. */
const byKind = new Map<string, RegisteredKind>();

type Listener = () => void;
const listeners = new Set<Listener>();
let revision = 0;

function changed(): void {
  revision += 1;
  for (const fn of listeners) fn();
}

/** Subscribe to registration changes — for menus and the layer tree. */
export function subscribeToLayerKinds(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Monotonic; for `useSyncExternalStore`. */
export function layerKindRevision(): number {
  return revision;
}

/** Register everything a plugin declares. Replaces any previous registration. */
export function registerLayerKinds(
  pluginId: string,
  pluginName: string,
  kinds: readonly LayerKindContribution[],
): void {
  unregisterLayerKinds(pluginId, { quiet: true });
  for (const kind of kinds) {
    byKind.set(`${pluginId}.${kind.id}`, { pluginId, pluginName, kind });
  }
  changed();
}

/** Drop every kind a plugin registered. */
export function unregisterLayerKinds(pluginId: string, opts: { quiet?: boolean } = {}): void {
  let removed = false;
  for (const [key, entry] of [...byKind]) {
    if (entry.pluginId !== pluginId) continue;
    byKind.delete(key);
    removed = true;
  }
  if (removed && !opts.quiet) changed();
}

/** Everything registered, for a menu. Sorted so the list does not reshuffle. */
export function allLayerKinds(): RegisteredKind[] {
  return [...byKind.values()].sort(
    (a, b) => a.pluginName.localeCompare(b.pluginName) || a.kind.label.localeCompare(b.kind.label),
  );
}

/** Look up by namespaced kind. Null when the plugin is absent or stopped. */
export function findLayerKind(kind: string): RegisteredKind | null {
  return byKind.get(kind) ?? null;
}

/** Look up by parts. The shape `customLayers.resolveCustomLayer` wants. */
export function findKindFor(pluginId: string, kindId: string): LayerKindContribution | null {
  return byKind.get(`${pluginId}.${kindId}`)?.kind ?? null;
}

/** True when a layer of this kind can be created right now. */
export function isCreatableKind(kind: string): boolean {
  return byKind.has(kind);
}

export type OwnershipCheck =
  | { ok: true; entry: RegisteredKind }
  | { ok: false; message: string };

/**
 * May `caller` act on `kind`?
 *
 * Every failure returns a message naming the actual problem, because all three
 * present identically to an author otherwise — a call that did nothing.
 */
export function checkOwnership(caller: string, kind: unknown): OwnershipCheck {
  if (typeof kind !== 'string' || !kind) {
    return { ok: false, message: 'A layer kind must be a string like "<pluginId>.<kindId>".' };
  }

  const split = splitKind(kind);
  if (!split) {
    return {
      ok: false,
      message: `"${kind}" is not a plugin layer kind. Use the full "<pluginId>.<kindId>" form.`,
    };
  }

  const entry = byKind.get(kind);
  if (!entry) {
    // Two very different situations, and the author needs to know which: a kind
    // they never declared, versus one belonging to a plugin that is not running.
    return split.pluginId === caller
      ? { ok: false, message: `This plugin does not declare a layer kind "${split.kindId}".` }
      : { ok: false, message: `No layer kind "${kind}" is registered. Its plugin may not be installed or enabled.` };
  }

  if (entry.pluginId !== caller) {
    return {
      ok: false,
      message: `"${kind}" belongs to "${entry.pluginId}". A plugin may only create, change or observe its own layer kinds.`,
    };
  }

  return { ok: true, entry };
}

/** Test seam. Never called by the app. */
export function resetLayerKindsForTests(): void {
  byKind.clear();
  revision = 0;
  listeners.clear();
}
