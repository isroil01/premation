/**
 * The selected layers' property trees stay loaded (the document mirror's
 * `retainTree`) for as long as they are selected.
 *
 * Nearly every edit the UI makes acts on the selection, and composes its
 * commands from the selected layers' trees: which track a member names, what a
 * property's stored value is, whether it is animated. Over the pipe a tree the
 * mirror does not hold arrives a round trip after the first read, and an edit
 * reading it synchronously before then finds nothing and silently writes
 * nothing. Holding the selection's trees is what the Inspector did whenever
 * it was open; this makes it the session's rule instead of a panel's.
 *
 * A layer selected before the mirror knows it (just created) is held as soon
 * as its header lands.
 */

import { documentMirror } from './documentMirror';
import { useSelectionStore } from './selectionStore';

export function retainSelectionTrees(): () => void {
  const m = documentMirror();
  const held = new Map<string, () => void>();
  const sync = (): void => {
    const ids = new Set(useSelectionStore.getState().ids);
    for (const [id, release] of held) {
      if (ids.has(id)) continue;
      release();
      held.delete(id);
    }
    for (const id of ids) {
      if (held.has(id) || !m.layer(id)) continue;
      held.set(id, m.retainTree(id));
    }
  };
  sync();
  const offSelection = useSelectionStore.subscribe(sync);
  const offLayers = m.subscribe(['layers'], sync);
  return () => {
    offSelection();
    offLayers();
    for (const release of held.values()) release();
    held.clear();
  };
}
