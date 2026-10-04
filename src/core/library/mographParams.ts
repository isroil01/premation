/**
 * Editable parameters for an INSERTED motion-graphics element.
 *
 * A Motion GFX card drops a finished, choreographed group into the comp — and
 * then leaves the user with "Name Surname", "Title / Role" and a fixed accent
 * colour, reachable only by hunting through the layer tree for the right child
 * and finding the one prop on it that is safe to touch. The element is a
 * template in every sense except that nothing exposed its blanks.
 *
 * This derives those blanks from the built subtree instead of asking each of
 * the catalog's items to declare them, so items added later are covered without
 * anyone remembering to maintain a manifest. Two rules, matching how the items
 * are actually built:
 *
 *   • a child with a Text component → its `content` is a text field
 *   • a child with a Style.fill string → that fill is a colour field
 *
 * Fields come out as `TemplateField`s so they are written through
 * `writeTemplateField` — the same path the fill-in-the-blanks template panel
 * uses — rather than a second, subtly different write.
 *
 * ## What is deliberately NOT exposed
 *
 * Text driven by a `text.source` DATA TRACK (the number counters and the
 * word-swap kinetic titles) is skipped. Those nodes have their content
 * regenerated per frame from hold keyframes, so a typed-in value is overwritten
 * on the next evaluation — an edit box that silently discards what you type is
 * worse than no edit box. Same reasoning as the transform-write routing rule:
 * a raw prop write to an animated property is discarded.
 */

import { partLabel } from '@core/mirror/mographFields';

/** Stamped on an inserted group's meta component so the subtree can be
 *  recognised as one element later. Underscore-prefixed like the other internal
 *  scene props, which keeps it out of the generic inspector. */
export const MOGRAPH_ID_PROP = '__mographId';

/**
 * A readable label for a built child, from the id suffix the catalog authored
 * — pure, shared with the mirror reader (core/mirror/mographFields.ts) so the
 * Inspector field and the Layers row agree.
 */
export { partLabel };
