/**
 * Applying one data row to a template's exposed fields.
 *
 * The scene-touching half of batch fill; `dataTable.ts` is the pure parser.
 * Every value goes through `writeTemplateField`, which is the same mutation
 * path the inspector uses — so a filled template is an ordinary set of prop
 * writes, and nothing here needs to know how a Text component stores content.
 *
 * ── One row is ONE undo entry ──────────────────────────────────────────
 * Not one per field. A user who fills a row and dislikes it presses undo once,
 * because "apply this row" is the action they took; making them press it nine
 * times for a nine-field template would expose an implementation detail as an
 * interaction. This is the repo's standing one-action-one-undo contract.
 *
 * ── v1 covers text / color / number only ───────────────────────────────
 * A `media` field holds a source URL, so a column of file paths drags asset
 * ingestion into the batch path — a materially bigger job than writing strings
 * and numbers, and one that can fail per-row for reasons (missing file, decode)
 * that batch rendering has no good answer for yet. Media fields are REPORTED as
 * skipped rather than silently ignored, so the limit is visible.
 */

export interface FillResult {
  /** Field ids written. */
  filled: string[];
  /** Field ids the row had a column for, but whose kind v1 cannot write. */
  skippedKind: string[];
  /** Field ids whose target node/component no longer exists. */
  failed: string[];
}

/**
 * Coerce a cell to what the field's kind expects.
 *
 * The table is all strings — a CSV has no types and JSON numbers were
 * stringified deliberately — so the FIELD decides. Returns null when the cell
 * cannot be that kind, which the caller reports rather than writing NaN into a
 * prop and rendering a blank.
 */
export function coerceCell(kind: string, cell: string): string | number | null {
  if (kind === 'number') {
    const raw = cell.trim();
    // `Number('')` is 0, not NaN — so an empty cell would silently write zero
    // and move a layer to the origin with nothing on screen to explain it.
    // A blank cell means "no value", which is a skip, not a zero.
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === 'color') {
    // Accept `#rgb`, `#rrggbb`, `#rrggbbaa`; tolerate a missing `#`, which is
    // what a spreadsheet does to a hex column left as plain text.
    const raw = cell.trim();
    const hex = raw.startsWith('#') ? raw : `#${raw}`;
    return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) ? hex : null;
  }
  return cell;
}
