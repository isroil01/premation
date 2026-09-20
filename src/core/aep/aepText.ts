/**
 * What a text layer says.
 *
 * A text layer's source lives in a `btdk` blob written in COS (`cos.ts`). The
 * schema is Adobe's and is keyed by ordinals, so what follows is the result of
 * reading real documents rather than of reading a spec: the paths below were
 * located in AE-authored files and each one is named with what it was observed
 * to hold.
 *
 * The document tree, for the parts that matter:
 *
 *     root
 *       /0                       the RESOURCE dictionary
 *         /1 /0 [ … ]              the font table: one entry per font used
 *       /1                       the DOCUMENT
 *         /1 [0] /0
 *           /0                     the text itself
 *           /5 …                   paragraph styles, one run per paragraph
 *           /6 …                   character styles, one run per span
 *
 * and a character style is a dictionary whose `/0` is an INDEX into that font
 * table, `/1` is the point size, and `/53` is the fill paint (stored `[alpha,
 * r, g, b]`, alpha first).
 *
 * Note that the body is an UNWRAPPED dictionary — it begins on a key, with no
 * `<<` — which `parseCos` handles and which is worth knowing before wondering
 * why a path that is plainly in the bytes resolves to nothing.
 *
 * ## Deliberately partial, and honest about it
 *
 * Per-character animators, paragraph composition, kinsoku tables and variable
 * font axes are all in there too. This reads the string, the font, the size,
 * the colour and the justification — the things whose absence makes a text
 * layer arrive wrong rather than merely plain — and the importer reports the
 * rest as "styling simplified" instead of silently dropping it. Guessing at an
 * undocumented ordinal is how an importer starts setting tracking from a
 * kinsoku flag.
 */

import { cosArray, cosGet, cosNumber, cosString, cosWalk, parseCos, type CosValue } from './cos';
import type { AepTextDocument } from './aepModel';

/** AE's justification ordinals, as observed on left/centre/right documents. */
const JUSTIFICATION: Record<number, AepTextDocument['justification']> = {
  0: 'left',
  1: 'right',
  2: 'center',
};

/**
 * The font table: display names in table order, so a style's `/0` index can be
 * resolved back to a name.
 *
 * Each entry is `{ /0: { /99: /CoolTypeFont, /0: { /0: (PostScript name) } } }`.
 * The PostScript name is what AE matches on, and it is what we hand the text
 * layer — the font resolver here does the same "close enough" matching it does
 * for every other import.
 */
function readFontTable(root: CosValue): string[] {
  const table = cosArray(cosGet(root, '0', '1', '0')) ?? [];
  return table.map((entry) => cosString(cosGet(entry, '0', '0', '0')) ?? '');
}

/** The document node: everything about the text hangs off this. */
const documentOf = (root: CosValue): CosValue | undefined => cosGet(root, '1', '1', 0, '0');

/**
 * The first run's character style, and the first paragraph's.
 *
 * A document can carry many runs; the importer applies ONE style to the layer,
 * because that is what this editor's text layer models. The first run is what
 * the user sees first and is right for the overwhelming majority of real text
 * layers — a single style, set once — and a layer with mixed styling gets a
 * warning rather than a silent flattening.
 */
function readFirstStyle(root: CosValue): CosValue | undefined {
  return cosGet(documentOf(root), '6', '0', 0, '0', '0', '6');
}

function readFirstParagraph(root: CosValue): CosValue | undefined {
  return cosGet(documentOf(root), '5', '0', 0, '0', '0', '5');
}

/** How many character-style runs the document has. */
function styleRunCount(root: CosValue): number {
  return cosArray(cosGet(documentOf(root), '6', '0'))?.length ?? 0;
}

/** `[a, r, g, b]` in 0–1, as AE's `SimplePaint` stores it. */
function readPaint(style: CosValue | undefined, key: string): AepTextDocument['fillColor'] {
  const channels = cosArray(cosGet(style, key, '0', '1'));
  if (!channels || channels.length < 4) return undefined;
  const [, r, g, b] = channels.map((c) => cosNumber(c) ?? 0);
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}

/**
 * Last-resort search for the source string.
 *
 * When the expected path is absent — an older AE, or a document shape not seen
 * here — the string is still in the blob. A text document's string is the one
 * that is the `/0` of a dictionary that ALSO carries a `/5` style block, which
 * is what distinguishes it from a font name or a kinsoku set.
 */
function findTextByShape(root: CosValue): string | undefined {
  for (const node of cosWalk(root)) {
    if (node.kind !== 'dict') continue;
    const text = cosString(node.entries.get('0'));
    if (text === undefined) continue;
    if (!node.entries.has('5')) continue;
    if (text.length === 0) continue;
    return text;
  }
  return undefined;
}

/**
 * Decode a `btdk` body into a text document, or null when there is no text in
 * it at all.
 *
 * AE terminates paragraphs with CR; this editor's text layers use LF, so the
 * conversion happens here rather than leaving a stray carriage return to show
 * up as a box glyph.
 */
export function readTextDocument(btdk: Uint8Array): AepTextDocument | null {
  const root = parseCos(btdk);
  const raw = cosString(cosGet(documentOf(root), '0')) ?? findTextByShape(root);
  if (raw === undefined) return null;

  const text = raw.replace(/\r\n?/g, '\n');
  const fonts = readFontTable(root);
  const style = readFirstStyle(root);

  const fontIndex = cosNumber(cosGet(style, '0'));
  const font = fontIndex !== undefined ? fonts[fontIndex] : undefined;
  const fontSize = cosNumber(cosGet(style, '1'));
  const tracking = cosNumber(cosGet(style, '8'));
  // Leading is only meaningful when auto-leading is off; AE stores 0 with the
  // auto flag set, and a 0 line height would collapse a paragraph to one line.
  const leading = cosNumber(cosGet(style, '13'));
  const justificationCode = cosNumber(cosGet(readFirstParagraph(root), '0'));

  const boolAt = (key: string): boolean | undefined => {
    const node = cosGet(style, key);
    return node?.kind === 'bool' ? node.value : undefined;
  };
  const faux = { bold: boolAt('2'), italic: boolAt('3') };

  return {
    text,
    styleRuns: styleRunCount(root),
    ...(font ? { font } : {}),
    ...(fontSize !== undefined && fontSize > 0 ? { fontSize } : {}),
    ...(tracking !== undefined && tracking !== 0 ? { tracking } : {}),
    ...(leading !== undefined && leading > 0 ? { leading } : {}),
    ...(justificationCode !== undefined && JUSTIFICATION[justificationCode]
      ? { justification: JUSTIFICATION[justificationCode] }
      : {}),
    ...(readPaint(style, '53') ? { fillColor: readPaint(style, '53') } : {}),
    ...(faux.bold || faux.italic ? { faux } : {}),
  };
}
