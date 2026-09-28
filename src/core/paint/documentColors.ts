/**
 * The colours a document PAINTS with (B4 round 5) — the engine's
 * `getDocumentColors` answer (src/core/engine/itemFactsQueries.ts; the C++ twin
 * is native/engine/src/core/document_colors.cpp) and the swatch store's tests.
 *
 * PURE: it reads the nodes handed to it and touches no graph, no store and no
 * clock.
 *
 * Covers fills (including each gradient stop), the fill STACK, strokes and
 * gradient strokes. Light colours arrive for free: a light stores its colour as
 * a plain `fill` string on its style component, and `readNodeFills` resolves
 * exactly that through its legacy single-colour path — so lights need no case
 * of their own here, and adding one would double-count them.
 *
 * Layer LABEL colours (`node.color`) are deliberately excluded. They tint the
 * timeline row, not the picture; offering them beside the real paint would put
 * chrome into a palette of content.
 */

import { readNodeFills, type FillPaint } from '@core/paint/fill';
import { readNodeStrokes } from '@core/paint/stroke';
import type { SceneNode } from '@core/types';

/**
 * Normalise a colour into the canonical hex the palette compares by, or null if
 * it is not a hex colour at all.
 *
 * Canonicalising is what makes deduplication honest: `#FFF`, `#ffffff` and
 * `#FFFFFFFF` are one colour, and a strip that showed them as three would be
 * reporting its own storage format rather than the document's palette. The
 * fully-opaque alpha byte is dropped for the same reason.
 *
 * Non-hex paints (the `rgba(...)` strings `sampleGradientColor` produces) are
 * rejected rather than parsed: nothing STORES that form, so accepting it would
 * be widening the contract for a case that cannot occur.
 */
export function canonicalHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const body = (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase();
  if (!/^[0-9a-f]+$/.test(body)) return null;
  let full: string;
  if (body.length === 3) full = body.split('').map((c) => c + c).join('');
  else if (body.length === 4) full = body.split('').map((c) => c + c).join('');
  else if (body.length === 6 || body.length === 8) full = body;
  else return null;
  // A trailing `ff` is "opaque", which is what a 6-digit hex already means.
  if (full.length === 8 && full.endsWith('ff')) full = full.slice(0, 6);
  return `#${full}`;
}

function pushColor(raw: unknown, out: string[], seen: Set<string>, limit: number): void {
  if (out.length >= limit) return;
  const hex = canonicalHex(raw);
  if (!hex || seen.has(hex)) return;
  seen.add(hex);
  out.push(hex);
}

/** Push every colour a paint carries (solid colour, or every gradient stop). */
function pushPaint(paint: FillPaint | undefined, out: string[], seen: Set<string>, limit: number): void {
  if (!paint) return;
  if (paint.type === 'solid') {
    pushColor(paint.color, out, seen, limit);
    return;
  }
  // A malformed stored gradient with no stop list paints nothing (it used to throw here).
  if (!Array.isArray(paint.stops)) return;
  for (const stop of paint.stops) pushColor(stop?.color, out, seen, limit);
}

/**
 * Every distinct colour the given nodes paint with, in first-seen order, at
 * most `limit` of them (the walk stops there).
 */
export function collectDocumentColors(nodes: readonly SceneNode[], limit = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (out.length >= limit) break;
    for (const fill of readNodeFills(node)) pushPaint(fill, out, seen, limit);
    for (const stroke of readNodeStrokes(node)) {
      // The gradient paint OVERRIDES `color` when present, but `color` remains
      // the fallback every non-gradient renderer draws — both are in the file,
      // so both are colours the document uses.
      pushColor(stroke.color, out, seen, limit);
      pushPaint(stroke.paint, out, seen, limit);
    }
  }
  return out;
}
