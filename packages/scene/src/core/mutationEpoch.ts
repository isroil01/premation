/**
 * A monotonic counter bumped by every scene-data mutation.
 *
 * ## Why this exists, and why it is bumped HERE
 *
 * Render-path caches need to know "has anything in the document changed since I
 * computed this?". The obvious candidates were both unsafe:
 *
 *   - `SceneNode.updatedAt` is `Date.now()` — millisecond resolution, so two
 *     mutations inside one millisecond are indistinguishable.
 *   - `SceneNode.touch()` looks like the choke point but is NOT reliably called:
 *     `SceneGraph.setFx` (which backs ~30 setters — effects, fill, stroke, mask,
 *     blend mode, repeater, trim path), `setLocalTransform` and
 *     `setSeparateDimensions` all mutate component data without it.
 *
 * So this is bumped by the **mutation primitives themselves** — `DataComponent.set`,
 * and component add/remove — rather than by their callers. That is the whole
 * point: a cache keyed on this cannot go stale because someone forgot to
 * announce a write, because there is nothing to forget. Any new mutation path
 * that goes through the primitives is covered for free, and one that does not
 * cannot change component data in the first place.
 *
 * This is deliberately GLOBAL rather than per-node. A per-node counter would be
 * finer-grained, but the coarse counter is enough: no mutation happens during a
 * render pass, so a frame-scoped cache holds for the whole frame regardless, and
 * a global counter has no bookkeeping that can itself be wrong.
 *
 * Not exported from the package index — this is an internal seam between the
 * engine's mutation primitives and the app's render-path caches.
 */

let epoch = 0;

/** The current mutation epoch. Changes ⇒ some component data may have changed. */
export function sceneMutationEpoch(): number {
  return epoch;
}

/** Called by the mutation primitives. Not for general use. */
export function bumpSceneMutationEpoch(): void {
  epoch++;
}
