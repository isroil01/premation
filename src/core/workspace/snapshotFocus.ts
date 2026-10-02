/**
 * Focus Mode's ghosting predicate: which layers read as dim references while
 * the user works inside a focused set (layout/focus/useFocusContext).
 *
 * The page renderer drew the ghosts; the C++ engine does not take this
 * predicate yet (docs/TS_ENGINE_REMOVAL.md, engine gaps), so today it drives
 * only the page's own chrome.
 */
export interface SnapshotFocus {
  /** Returns true when a node should render as a dim ghost reference. */
  isGhost: (nodeId: string) => boolean;
}
