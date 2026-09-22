/**
 * A text layer is named after what it says — After Effects' rule.
 *
 * Every Type-tool layer used to stay "Text" forever, so a title card's Layers
 * panel read Text, Text, Text, Text and the only way to find the tagline was to
 * click each one. AE names a text layer from its source text and keeps doing so
 * as the text changes, right up until the user renames the layer by hand; from
 * then on the name is theirs and editing the text leaves it alone.
 *
 * There is no "was renamed" flag to consult, and adding one would mean a new
 * persisted prop plus a migration for every existing document. It is not needed:
 * a name is still automatic exactly when it is the tool's default or is what
 * the PREVIOUS content would have generated. Anything else, someone typed.
 *
 * Pure — no scene graph, no stores — so the rule is testable on its own and the
 * overlay that applies it stays a caller.
 */

import { splitGraphemes } from './graphemes';

/** AE truncates long source text in the layer name; ~30 keeps a row readable. */
export const TEXT_LAYER_NAME_MAX = 30;

/** What the Type tools (and Layer ▸ New ▸ Text) call a layer before it says anything. */
const DEFAULT_NAME = /^(?:vertical )?text(?: \d+)?$/i;

/**
 * The layer name for `content`, or '' when the content has nothing to name a
 * layer with (empty / whitespace only — the caller keeps the current name).
 *
 * Line breaks collapse to single spaces, because a layer name is one line.
 * Truncation counts GRAPHEMES, the same unit every other text index here uses,
 * so an emoji sequence or an accented letter is never cut in half; a truncated
 * name ends in an ellipsis so it does not read as the whole sentence.
 */
export function textLayerNameFor(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const glyphs = splitGraphemes(flat);
  if (glyphs.length <= TEXT_LAYER_NAME_MAX) return flat;
  return `${glyphs.slice(0, TEXT_LAYER_NAME_MAX).join('').trimEnd()}…`;
}

/**
 * True while the layer's name is still ours to set: unnamed, a tool default, or
 * exactly what `previousContent` would have produced. False means the user
 * renamed it, and their name survives every later text edit.
 */
export function isAutoTextLayerName(name: string | undefined, previousContent: string): boolean {
  const current = (name ?? '').trim();
  if (!current || DEFAULT_NAME.test(current)) return true;
  return current === textLayerNameFor(previousContent);
}
