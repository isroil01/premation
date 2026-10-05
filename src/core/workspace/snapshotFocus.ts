/**
 * Focus Mode's ghosting predicate: which layers read as dim references while
 * the user works inside a focused set (layout/focus/useFocusContext).
 *
 * The engine draws the ghosts in its viewport frames (setViewportFocus,
 * layout/focus/useEngineFocus); this predicate drives the page's own chrome.
 */
export interface SnapshotFocus {
  /** Returns true when a node should render as a dim ghost reference. */
  isGhost: (nodeId: string) => boolean;
}
