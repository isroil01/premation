/**
 * Find and Replace Text across layers — scope and counting.
 *
 * The string/run rules live in `findReplaceText.ts`; this module decides WHICH
 * text is searched. Replace All is engine commands (layout/Text/textEdits.ts).
 *
 * What is searched, per text layer:
 *   • its static content (the Text component's `content`), with its rich-text
 *     runs shifted so styling stays on the right characters;
 *   • every Source Text keyframe value — a keyframed layer shows those strings,
 *     not `content`, so a replace that skipped them would appear to do nothing.
 */

/** AE-style scopes: the selection, the active comp, or every comp in the project. */
export type FindScope = 'selected' | 'comp' | 'all';

export interface ScopeCount {
  /** Total matches, keyframe values included. */
  matches: number;
  /** Text layers with at least one match. */
  layers: number;
}
