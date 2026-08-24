/**
 * Is this font file a VARIABLE font?
 *
 * A variable font carries an `fvar` table — the axis definitions `wght`,
 * `wdth`, `slnt` that the text inspector already keyframes. Reading the table
 * DIRECTORY is enough to know the table exists, and the directory sits in the
 * first few hundred bytes of the file, so the probe only needs a short slice,
 * never the whole face.
 *
 * Pure over an ArrayBuffer, so it is testable with a hand-built header and
 * usable on whatever the Local Font Access API hands back.
 */

const TAG_FVAR = 0x66766172; // 'fvar'
const TAG_TTCF = 0x74746366; // 'ttcf'

/**
 * Read the table directory of one sfnt at `offset` and report an `fvar`.
 * Tolerant of truncated buffers: a directory that runs past the slice just
 * reports false, which is the right answer for "could not tell".
 */
function sfntHasFvar(view: DataView, offset: number): boolean {
  if (offset + 12 > view.byteLength) return false;
  const numTables = view.getUint16(offset + 4);
  const recordsStart = offset + 12;
  for (let i = 0; i < numTables; i++) {
    const rec = recordsStart + i * 16;
    if (rec + 4 > view.byteLength) return false;
    if (view.getUint32(rec) === TAG_FVAR) return true;
  }
  return false;
}

/**
 * True when the font data declares variation axes. Handles single faces
 * (TrueType `00010000`, `true`, CFF `OTTO`) and collections (`ttcf`), where
 * the first face's directory is consulted — a collection's faces share axes
 * in practice, and the picker needs one answer per family.
 */
export function hasVariableAxes(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const view = new DataView(buf);
  const tag = view.getUint32(0);
  if (tag === TAG_TTCF) {
    // TTC header: tag, version, numFonts, then offsets to each face.
    if (view.byteLength < 16) return false;
    const first = view.getUint32(12);
    return sfntHasFvar(view, first);
  }
  return sfntHasFvar(view, 0);
}

/** How much of a file the probe needs: the header plus a generous directory. */
export const VARIABLE_PROBE_BYTES = 4096;
