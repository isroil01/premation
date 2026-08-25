/**
 * `contributes.importers` — a plugin that reads a file format the editor cannot.
 *
 * The mirror of `exporterSchema.ts`, and shaped the same way for the same
 * reasons: the plugin decodes, the HOST owns the file. A plugin never opens
 * anything — it is handed the bytes of a file the user themselves chose, and
 * hands back pixels. Everything after that (the asset record, the bundle, the
 * thumbnail, the undo entry) is the path every other import already takes.
 *
 * ── Pixels, not an asset ────────────────────────────────────────────────────
 *
 * A decoder returns `{ width, height, pixels }` and nothing else. It does not
 * name the asset, choose a folder, or place a layer. That is not a restriction
 * on what plugins may do — `assets:write` and `scene:write` already cover all
 * three — it is a separation: the thing that knows how to read a `.tga` should
 * not also be deciding where it lands, because then two importers disagree
 * about what importing means.
 *
 * ── Extensions are claimed, and collisions are refused at the door ──────────
 *
 * A format the editor already reads is reserved. Not because the host would
 * lose the race — it is matched first — but because a plugin that silently
 * shadows `.png` turns a working import into a plugin bug, and the user has no
 * reason to suspect a plugin at all.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Same rule as an exporter's: this is matched against a file name. */
const EXT_RE = /^[a-z0-9]{1,12}$/;

export const MAX_IMPORTERS_PER_PLUGIN = 4;
export const MAX_EXTENSIONS_PER_IMPORTER = 8;

export interface ImporterContribution {
  id: string;
  label: string;
  /** Lower-case, no dot. A file matches if its extension is in this list. */
  extensions: string[];
}

/**
 * Formats the editor reads itself.
 *
 * Wider than the exporter list: the editor imports several things it cannot
 * write (`psd`, `svg`, `lottie`), and a plugin shadowing one of those breaks an
 * import that works today.
 */
const RESERVED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif',
  'mp4', 'webm', 'mov', 'mkv', 'avi', 'mxf',
  'wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a',
  'psd', 'exr', 'json', 'lottie', 'zip',
]);

export function parseImporters(
  raw: unknown,
  at: string,
  errors: string[],
): ImporterContribution[] {
  if (!Array.isArray(raw)) {
    errors.push(`"${at}" must be an array.`);
    return [];
  }
  if (raw.length > MAX_IMPORTERS_PER_PLUGIN) {
    errors.push(`"${at}" declares ${raw.length} importers; the limit is ${MAX_IMPORTERS_PER_PLUGIN}.`);
    return [];
  }

  const out: ImporterContribution[] = [];
  const seenIds = new Set<string>();
  const seenExts = new Set<string>();

  raw.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`"${where}" must be an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;

    const id = e.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      errors.push(`"${where}.id" must be lower-case letters, digits and dashes (no dots).`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`"${at}" declares "${id}" twice.`);
      return;
    }

    const label = e.label;
    if (typeof label !== 'string' || !label.trim() || label.length > 60) {
      errors.push(`"${where}.label" must be a non-empty string of at most 60 characters.`);
      return;
    }

    const exts = e.extensions;
    if (!Array.isArray(exts) || exts.length === 0) {
      errors.push(`"${where}.extensions" must be a non-empty array.`);
      return;
    }
    if (exts.length > MAX_EXTENSIONS_PER_IMPORTER) {
      errors.push(`"${where}.extensions" lists ${exts.length}; the limit is ${MAX_EXTENSIONS_PER_IMPORTER}.`);
      return;
    }

    const cleaned: string[] = [];
    let bad = false;
    for (const ext of exts) {
      if (typeof ext !== 'string' || !EXT_RE.test(ext)) {
        errors.push(`"${where}.extensions" must be 1–12 lower-case letters or digits each, with no dot.`);
        bad = true;
        break;
      }
      if (RESERVED_EXTENSIONS.has(ext)) {
        errors.push(
          `"${where}.extensions": the editor already reads ".${ext}". `
          + 'A plugin shadowing it turns a working import into a plugin bug the user has no reason to suspect.',
        );
        bad = true;
        break;
      }
      if (seenExts.has(ext)) {
        errors.push(`"${at}" claims ".${ext}" twice.`);
        bad = true;
        break;
      }
      cleaned.push(ext);
    }
    if (bad) return;

    seenIds.add(id);
    for (const ext of cleaned) seenExts.add(ext);
    out.push({ id, label: label.trim(), extensions: cleaned });
  });

  return out;
}
