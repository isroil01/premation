/**
 * Turning name-based plugin bindings into id-based ones, once, on load.
 *
 * A proxy child used to reference its parent by NAME —
 * `layer('Hero depth', 'plugin.focal')` — resolved at evaluation time, every
 * frame. Rename the layer and every child silently reads 0, with the symptom
 * appearing nowhere near the rename that caused it.
 *
 * The fix is `#<id>` in the resolution layer (see `AnimationEngine`), which
 * fixes every name-taking API at once. This is the other half: documents
 * already written carry the fragile form, so they are repaired on load.
 *
 * ── Why only PLUGIN-authored expressions are rewritten ───────────────────────
 *
 * Because `authoredBy` tells us exactly which ones those are, and because the
 * user never wrote them and never reads them — rewriting the text costs
 * nothing.
 *
 * A user-authored `layer('Hero depth', 'x')` has the identical fragility and is
 * deliberately NOT rewritten. The source text is what they typed and what they
 * see when they open the expression editor; replacing a layer name with
 * `#n_a1b2c3` would make their own expression unreadable to them in order to
 * fix a problem they have not hit. The id form is available to them, and the
 * resolution layer treats both identically. That is a product decision, and it
 * is stated here rather than left as an omission.
 *
 * ── Unresolvable references are surfaced, never dropped ──────────────────────
 *
 * A name that resolves to nothing today is a binding that was already broken.
 * Rewriting it to `#undefined` would make it permanently broken and untraceable;
 * dropping it would delete a plugin's output silently. It is left exactly as it
 * is and reported, so the editor can say which layer and which property.
 *
 * The load-time pass itself (`migratePluginBindings`) is part of opening a
 * document — src/core/persistence/pluginBindingMigration.ts — not a plugin
 * write: it runs on the document before the engine takes it over.
 */

import { layerIdRef, mapLayerNameRefs } from '@motion/animation';

/**
 * Rewrite every `layer('<name>', …)` in `src` to `layer('#<id>', …)`.
 *
 * Used by both the authoring path (`proxySubtree`) and the load-time migration,
 * because they are the same operation on the same syntax. The grammar itself
 * lives in `@motion/animation` — see `mapLayerNameRefs` — so the rename path
 * cannot drift from this one.
 *
 * `resolve` returns null for a name that matches nothing, and such a reference
 * is left EXACTLY as it is: rewriting it to `#undefined` would turn an already
 * broken reference into a permanently broken and untraceable one. References
 * already in `#<id>` form are skipped, which is what makes running the
 * migration on every load idempotent.
 */
export function rewriteNameRefsToIds(
  src: string,
  resolve: (name: string) => string | null,
  onUnresolved?: (name: string) => void,
): { src: string; changed: boolean } {
  return mapLayerNameRefs(src, (name) => {
    const target = resolve(name);
    if (!target) { onUnresolved?.(name); return null; }
    return layerIdRef(target);
  });
}
