/**
 * Pinned properties — the user's own shortlist of a layer's properties,
 * stored IN THE DOCUMENT beside the Essential Properties bag.
 *
 * Why in the document and not in preferences: which of a rig's forty
 * properties matter is a fact about the project, not about the person. A
 * collaborator opening the file should find the same "Pinned" tab, exactly
 * as they find the same Essential Properties. Preferences would ship one
 * person's pins to no one.
 *
 * Storage: `__pinnedProps` on the node's first component — the same host and
 * the same write path (`writeProp` + `bumpScene`) as `__essentialProps` and
 * `__modifiers`, so undo, dirty tracking and serialisation see it for free.
 */

export const PINNED_PROPS = '__pinnedProps';

export interface PinnedEntry {
  prop: string;
  /** Pinned by hand, promoted as an Essential Property, or both. */
  pinned: boolean;
  essential: boolean;
}
