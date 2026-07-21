/**
 * textEditStore — which text layer is being edited on-canvas, and what part of
 * it is selected.
 *
 * Text editing used to be a `window.prompt`, which Electron's Chromium refuses
 * to show — so double-clicking a text layer in the desktop app (what this
 * ships as) did nothing at all. This drives a real on-canvas editor instead.
 *
 * The selection is what makes per-character styling addressable: the inspector
 * reads it to decide whether an edit means "this layer" or "these characters".
 * Offsets are indices into `[...content]` — code points, the same index space
 * runs and animator selectors use — NOT `string.length`.
 */

import { create } from 'zustand';

export interface TextSelection {
  /** Inclusive start, in code points. */
  start: number;
  /** Exclusive end, in code points. `start === end` is a caret, not a range. */
  end: number;
}

interface TextEditState {
  /** The text layer currently being edited, or null. */
  nodeId: string | null;
  /** The live selection within that layer, or null when not editing. */
  selection: TextSelection | null;
  begin: (nodeId: string) => void;
  end: () => void;
  setSelection: (selection: TextSelection | null) => void;
}

export const useTextEditStore = create<TextEditState>((set) => ({
  nodeId: null,
  selection: null,
  begin: (nodeId) => set({ nodeId, selection: null }),
  end: () => set({ nodeId: null, selection: null }),
  setSelection: (selection) => set({ selection }),
}));

/** True when a range (not just a caret) is selected. */
export function hasRange(selection: TextSelection | null): selection is TextSelection {
  return selection !== null && selection.end > selection.start;
}
