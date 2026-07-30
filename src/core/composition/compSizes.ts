/**
 * Composition dimensions by root id — the lookup `buildSnapshot` needs to render
 * a composition placed as a layer at ITS OWN size.
 *
 * The renderer cannot import the project store: it has to stay callable from
 * export, the offline renderer, thumbnails and tests, none of which have a live
 * editor around them. So the lookup is injected, and this is the one
 * implementation of it that reads real project state — a single function rather
 * than a repeated inline closure, so the several call sites cannot drift into
 * resolving comp sizes differently.
 *
 * A comp root id that is not a registered composition (a plain precomp group, a
 * synthetic template root) returns undefined, and the renderer falls back to the
 * host's size — the behaviour before instances had a size of their own.
 */

import { useProjectStore } from '@stores/projectStore';
import type { CompSourceLookup } from '@core/source/sourceInfo';

export function compSizeOf(compRootId: string): { width: number; height: number } | undefined {
  const c = useProjectStore.getState().comps[compRootId];
  return c ? { width: c.width, height: c.height } : undefined;
}

/**
 * The same lookup, widened to everything that makes a composition a SOURCE —
 * its rate and duration as well as its size. `compSizeOf` is now the size-only
 * projection of this, kept because the renderer's injection point only ever
 * needed the size.
 *
 * This is what lets a comp instance answer "how long are you?" — the fact whose
 * absence made compositions unbounded on the timeline while footage was
 * correctly bounded by its own length.
 */
export const compSourceOf: CompSourceLookup = (compRootId) => {
  const c = useProjectStore.getState().comps[compRootId];
  return c ? { width: c.width, height: c.height, fps: c.fps, durationSeconds: c.durationSeconds } : undefined;
};
