/**
 * The one place that knows what a cross-layer reference looks like in source.
 *
 * Two operations need to rewrite `layer('…')` inside expression TEXT: the
 * load-time migration that turns a plugin's name references into id references,
 * and the rename that keeps a person's own references pointing at the layer
 * they meant. They are the same edit to the same grammar, and two regexes over
 * an expression language drift in exactly the way that leaves half a document
 * rewritten and no error anywhere.
 *
 * It lives in the animation package because the grammar belongs to the
 * expression language, not to either caller.
 */

import { isLayerIdRef } from './AnimationEngine';

/**
 * A `layer(` / `layerAt(` call whose first argument is a quoted literal.
 *
 * Deliberately only literals. `layer(someVariable)` is not resolvable without
 * running the expression, and an editor that guessed would corrupt the one case
 * it cannot check.
 */
const NAME_REF = /\b(layer|layerAt)\(\s*(['"])((?:(?!\2).)*)\2/g;

/**
 * Rewrite each quoted layer reference in `src` through `map`.
 *
 * `map` returns the replacement reference, or null to leave that one exactly as
 * it is. Leaving it is the important half: a reference this operation cannot
 * confidently repair must survive untouched, because a wrong rewrite is
 * silent and permanent while an unrewritten one is merely the state we were
 * already in.
 *
 * References already in `#<id>` form are skipped without consulting `map` —
 * they are immune to renaming, which is why they exist.
 */
export function mapLayerNameRefs(
  src: string,
  map: (name: string) => string | null,
): { src: string; changed: boolean } {
  let changed = false;
  const out = src.replace(NAME_REF, (whole, fn: string, quote: string, ref: string) => {
    if (isLayerIdRef(ref)) return whole;
    const replacement = map(ref);
    if (replacement === null || replacement === ref) return whole;
    changed = true;
    return `${fn}(${quote}${replacement}${quote}`;
  });
  return { src: out, changed };
}

/** Every quoted, non-id layer name referenced by `src`, in order, deduplicated. */
export function layerNameRefsIn(src: string): string[] {
  const seen = new Set<string>();
  mapLayerNameRefs(src, (name) => {
    seen.add(name);
    return null;
  });
  return [...seen];
}
