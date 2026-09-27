/**
 * Replace font families across the document — the run remapping behind
 * "Replace Fonts…" (missing-font warning) and Find and Replace Fonts. The
 * write is ONE engine batch (layout/Text/textEdits.ts
 * `replaceFontFamiliesEdit`: `text/fontFamily` + `text/styleRuns`).
 */

import type { RichRun } from '@core/text/textLayout';
import { familyKey } from './missingFonts';

/** `replacements` maps a lower-cased family key → the new family name. */
export function remapRunFonts(
  runs: ReadonlyArray<RichRun>,
  replacements: ReadonlyMap<string, string>,
): { runs: RichRun[]; changed: boolean } {
  let changed = false;
  const out = runs.map((r) => {
    const f = r.style.fontFamily;
    const next = typeof f === 'string' ? replacements.get(familyKey(f)) : undefined;
    if (next === undefined || next === f) return r;
    changed = true;
    return { ...r, style: { ...r.style, fontFamily: next } };
  });
  return { runs: out, changed };
}
