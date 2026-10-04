/* eslint-disable no-restricted-syntax -- F11: SAFE, verified.
 * Mutates a plain snapshot built in `copySelection` (getters read off the live
 * view, props structuredClone'd) — not a live graph node. Nudging the pasted
 * copy by 20px is applied before the clone is inserted. */
/**
 * Edit ▸ Cut / Copy / Paste for keyframes and layers.
 *
 * Time discipline: the clipboard stores times RELATIVE to the earliest copied
 * keyframe, and every engine call uses LAYER time. Mixing layer and comp time
 * here silently drops easing on any layer that doesn't start at frame 0,
 * because the lookup misses and the setter returns without complaint.
 */

/**
 * Pull the first `<svg>…</svg>` element out of `raw`, wherever it sits.
 *
 * Depth-aware, not a lazy regex: an exported document can NEST `<svg>` (Figma
 * frames, sprite sheets, Illustrator symbols), and `<svg[\s\S]*?</svg>` would
 * cut it off at the inner close tag and hand the importer a broken document.
 * Returns null when there is no complete element.
 */
export function extractSvgMarkup(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const openRe = /<svg\b/gi;
  const start = text.search(openRe);
  if (start < 0) return null;
  // Walk tags from the first `<svg`, counting opens and closes.
  const tagRe = /<(\/?)svg\b[^>]*?(\/?)>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    const closing = m[1] === '/';
    const selfClosing = !closing && m[2] === '/';
    if (selfClosing) {
      if (depth === 0) return m[0]; // `<svg …/>` on its own: empty document
      continue;
    }
    depth += closing ? -1 : 1;
    if (depth === 0) return text.slice(start, m.index + m[0].length);
  }
  return null;
}

/**
 * Is this PLAIN TEXT an SVG document (as opposed to prose or code that merely
 * mentions an `<svg>` somewhere)? Trimmed text must START as one: `<svg …`, an
 * XML prolog followed by `<svg`, or an SVG doctype. This is the strict gate for
 * `text/plain`, which is also how Illustrator hands over its markup.
 */
export function isSvgDocumentText(raw: string): boolean {
  const text = raw.trim();
  if (/^<svg[\s>/]/i.test(text)) return true;
  if (/^<\?xml\b/i.test(text) || /^<!DOCTYPE\s+svg\b/i.test(text)) {
    // Only prolog / doctype / comments may precede the root `<svg`.
    const afterPrologue = text.replace(/^(?:<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->|\s)+/i, '');
    return /^<svg[\s>/]/i.test(afterPrologue);
  }
  return false;
}

/** One flavour of what the OS clipboard holds, already read to text. */
export interface ClipboardTextItem {
  type: string;
  text: string;
}

/**
 * Decide whether a clipboard read is an SVG paste, and which markup to import.
 *
 * Pure — the decision is the part worth testing, and it needs no clipboard.
 * Flavours are tried in order of how much they promise:
 *
 *  1. `image/svg+xml` — declared SVG (Figma, Chrome, Inkscape). Whole payload.
 *  2. `text/html` — SVG wrapped in HTML (browsers prefix `<meta charset>`,
 *     Figma wraps in a `<div>`). The `<svg>` is pulled out from wherever it is.
 *  3. `text/plain` — only when the text IS an SVG document (Illustrator's
 *     "copy as SVG"). Prose or source code that happens to contain an inline
 *     `<svg>` icon is NOT an SVG paste and must reach the app's other paste
 *     targets untouched.
 *
 * Returns the markup to import, or null when this is not an SVG paste.
 */
export function detectClipboardSvg(items: ReadonlyArray<ClipboardTextItem>): string | null {
  const byType = (t: string) => items.filter((i) => i.type === t);
  for (const item of byType('image/svg+xml')) {
    const svg = extractSvgMarkup(item.text);
    if (svg) return svg;
  }
  for (const item of byType('text/html')) {
    const svg = extractSvgMarkup(item.text);
    if (svg) return svg;
  }
  for (const item of byType('text/plain')) {
    if (!isSvgDocumentText(item.text)) continue;
    const svg = extractSvgMarkup(item.text);
    if (svg) return svg;
  }
  return null;
}

/** The clipboard flavours we read; anything else (PNG, files…) is not ours. */
const SVG_CLIPBOARD_TYPES = ['image/svg+xml', 'text/html', 'text/plain'] as const;

/**
 * Read SVG markup from the OS clipboard, if any.
 *
 * Reads EVERY textual flavour of every item, then lets `detectClipboardSvg`
 * choose. This used to stop at the first flavour an item listed, so an item
 * carrying `text/html` (no SVG) alongside `image/svg+xml` lost its SVG.
 */
export async function readOsClipboardSvg(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return null;

  const collected: ClipboardTextItem[] = [];
  try {
    const read = navigator.clipboard.read?.bind(navigator.clipboard);
    if (read) {
      const items = await read();
      for (const item of items) {
        for (const type of SVG_CLIPBOARD_TYPES) {
          if (!item.types.includes(type)) continue;
          try {
            collected.push({ type, text: await (await item.getType(type)).text() });
          } catch {
            // A flavour that fails to materialise is skipped, not fatal.
          }
        }
      }
    }
  } catch {
    // Permission denied or unsupported — readText below still has a chance.
  }

  const typed = detectClipboardSvg(collected);
  if (typed) return typed;

  try {
    const text = await navigator.clipboard.readText();
    return detectClipboardSvg([{ type: 'text/plain', text }]);
  } catch {
    return null;
  }
}

export type PasteResult = 'keyframes' | 'layers' | 'svg' | 'path' | null;
