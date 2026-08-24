/**
 * Font-exact text outlines: the glyphs of a text layer as the font's own
 * Béziers, laid out the way the canvas draws them.
 *
 * Two halves. `loadLocalFace` finds the installed face that matches a family
 * + weight + style through the Local Font Access API and parses it
 * (`openType.ts`); it is null for a web font or without permission, and the
 * caller falls back to tracing. `outlineRuns` lays the text out — the same
 * per-line centring, `middle` baseline and letter-spacing the rasteriser
 * uses, with kerned pen positions from prefix measurement — and places each
 * glyph's contours in LAYER space, ready for a Geometry's `subpaths`.
 *
 * Kerning comes from the canvas (measuring prefixes), not from the font
 * tables, so the outlines land exactly where the rendered glyphs are.
 */

import { parseFont, type ParsedFont } from './openType';
import { weightFromStyle } from './fontCatalog';
import type { MeasuredTextStyle, MeasuredText } from './measureText';

interface LocalFontData {
  family?: string;
  style?: string;
  postscriptName?: string;
  blob?: () => Promise<Blob>;
}

const faceCache = new Map<string, Promise<ParsedFont | null>>();

/**
 * The installed face nearest to (family, weight, italic), parsed. Cached by
 * PostScript name so a second layer in the same face costs nothing.
 */
export async function loadLocalFace(family: string, weight: number, italic: boolean): Promise<ParsedFont | null> {
  const query = (globalThis as unknown as { queryLocalFonts?: () => Promise<ReadonlyArray<LocalFontData>> }).queryLocalFonts;
  if (typeof query !== 'function') return null;
  let faces: ReadonlyArray<LocalFontData>;
  try {
    faces = (await query.call(globalThis)) ?? [];
  } catch {
    return null; // permission refused — the trace fallback still works
  }
  const wanted = family.trim().toLowerCase();
  const candidates = faces.filter((f) => String(f.family ?? '').trim().toLowerCase() === wanted && typeof f.blob === 'function');
  if (candidates.length === 0) return null;
  // Nearest weight, then matching slant; ties go to the upright face.
  const scored = candidates
    .map((f) => {
      const style = String(f.style ?? 'Regular');
      const w = weightFromStyle(style);
      const it = /italic|oblique/i.test(style);
      return { f, score: Math.abs(w - weight) + (it === italic ? 0 : 1000) };
    })
    .sort((a, b) => a.score - b.score);
  const best = scored[0]!.f;
  const key = best.postscriptName ?? `${best.family}/${best.style}`;
  let p = faceCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        return parseFont(await (await best.blob!()).arrayBuffer());
      } catch {
        return null;
      }
    })();
    faceCache.set(key, p);
  }
  return p;
}

export interface OutlineRun {
  points: Array<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }>;
  open: false;
}

/**
 * Every glyph contour of the text, in layer space (centre origin, y down).
 *
 * `measure` must be the SAME 2D context configuration the rasteriser uses —
 * the caller sets the font on it. `boxes` positions the block so the result
 * coincides with what is drawn: the draw origin sits at (0, −ink.offsetY).
 */
export function outlineRuns(
  style: MeasuredTextStyle,
  boxes: MeasuredText,
  font: ParsedFont,
  measure: CanvasRenderingContext2D,
): OutlineRun[] {
  const s = style.fontSize / font.unitsPerEm;
  const lines = style.content.split('\n');
  const n = lines.length;
  const gap = style.fontSize * style.lineHeight + style.paragraphSpacing;
  const originY = -boxes.ink.offsetY;
  const runs: OutlineRun[] = [];

  for (let li = 0; li < n; li++) {
    const line = lines[li] ?? '';
    const chars = [...line];
    if (chars.length === 0) continue;
    const dy = (li - (n - 1) / 2) * gap;
    const m = measure.measureText(line);
    const spacingTotal = Math.max(0, chars.length - 1) * style.letterSpacing;
    const lineWidth = m.width + spacingTotal;
    // Centred line, as the rasteriser's `textAlign: 'center'` draws it.
    const penStart = -lineWidth / 2;
    // Alphabetic baseline below the `middle` baseline this line is drawn on.
    const ab = (m as TextMetrics & { alphabeticBaseline?: number }).alphabeticBaseline;
    const baselineY = originY + dy - (typeof ab === 'number' && Number.isFinite(ab) ? ab : 0);

    for (let ci = 0; ci < chars.length; ci++) {
      const cp = chars[ci]!.codePointAt(0)!;
      const glyph = font.glyphFor(cp);
      // Kerned pen: the width of the prefix as the canvas would draw it,
      // plus letter spacing for each gap crossed.
      const penX = penStart + measure.measureText(chars.slice(0, ci).join('')).width + ci * style.letterSpacing;
      if (!glyph || glyph.contours.length === 0) continue;
      for (const c of glyph.contours) {
        if (c.points.length < 2) continue;
        runs.push({
          open: false,
          points: c.points.map((p) => ({
            x: penX + p.x * s, y: baselineY - p.y * s,
            inX: penX + p.inX * s, inY: baselineY - p.inY * s,
            outX: penX + p.outX * s, outY: baselineY - p.outY * s,
          })),
        });
      }
    }
  }
  return runs;
}
