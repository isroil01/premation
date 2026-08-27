/**
 * `contributes.exporters` — a plugin that writes a file format the editor does
 * not know.
 *
 * ── Why this one CAN put JS in the loop, when effects cannot ────────────────
 *
 * `effectSchema.ts` opens by ruling out plugin JS per frame, and the reasoning
 * is not a style preference: an effect runs inside a synchronous render, so
 * reaching a Worker means an async hop the renderer cannot wait for, sixty
 * times a second. None of that applies here. An export is already a
 * frame-at-a-time loop that takes minutes and blocks nothing interactive, so
 * one `postMessage` per frame is a rounding error against the encode it is
 * feeding. The constraint was always about the frame LOOP, not about workers.
 *
 * ── The host writes the file. Always. ───────────────────────────────────────
 *
 * A plugin returns BYTES and never touches the disk. That keeps the guarantee
 * the whole sandbox rests on — no filesystem, ever — and it keeps the save
 * dialog, the output directory and the overwrite prompt in the one place that
 * already implements them. An exporter that could write its own file would also
 * be an exporter that could write somewhere else.
 *
 * ── Frames are a PERMISSION, and an alarming one ────────────────────────────
 *
 * To encode a composition a plugin has to see it — every rendered pixel of it.
 * That is strictly more than `assets:read` (the images already in the project)
 * and more than `scene:read` (the structure). Held together with `net:fetch` it
 * is the whole finished video leaving the machine. So it is its own permission,
 * `export:frames`, and its consent line says the dangerous half out loud rather
 * than describing the feature.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** No dot, no slash, no leading dot: this becomes part of a file name. */
const EXT_RE = /^[a-z0-9]{1,12}$/;

/**
 * Four per plugin.
 *
 * A format is a substantial thing to implement and a plugin shipping five is
 * more likely to be enumerating guesses than delivering codecs. The number is
 * a smell test, not a resource bound — each exporter costs nothing until it is
 * chosen.
 */
export const MAX_EXPORTERS_PER_PLUGIN = 4;

export interface ExporterContribution {
  /** Contribution-local; the host addresses it as `<pluginId>.<id>`. */
  id: string;
  /** What the export dropdown shows. */
  label: string;
  /** File extension, no dot. */
  extension: string;
}

/**
 * Extensions a plugin may not claim.
 *
 * Not about collision — the host's own formats are matched before plugin ones,
 * so a duplicate would simply never be reached. It is about what the user
 * believes they exported: a file called `.mp4` that a plugin produced is a file
 * whose contents nobody can predict from its name, and the failure lands in
 * whatever they hand it to next.
 */
const RESERVED_EXTENSIONS = new Set([
  'mp4', 'webm', 'gif', 'mov', 'png', 'jpg', 'jpeg', 'exr', 'wav', 'mp3', 'aac',
]);

export function parseExporters(
  raw: unknown,
  at: string,
  errors: string[],
): ExporterContribution[] {
  if (!Array.isArray(raw)) {
    errors.push(`"${at}" must be an array.`);
    return [];
  }
  if (raw.length > MAX_EXPORTERS_PER_PLUGIN) {
    errors.push(`"${at}" declares ${raw.length} exporters; the limit is ${MAX_EXPORTERS_PER_PLUGIN}.`);
    return [];
  }

  const out: ExporterContribution[] = [];
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
      // Two exporters under one id is one exporter and a dead entry, and which
      // one is dead depends on registration order.
      errors.push(`"${at}" declares "${id}" twice.`);
      return;
    }

    const label = e.label;
    if (typeof label !== 'string' || !label.trim() || label.length > 60) {
      errors.push(`"${where}.label" must be a non-empty string of at most 60 characters.`);
      return;
    }

    const ext = e.extension;
    if (typeof ext !== 'string' || !EXT_RE.test(ext)) {
      errors.push(`"${where}.extension" must be 1–12 lower-case letters or digits, with no dot.`);
      return;
    }
    if (RESERVED_EXTENSIONS.has(ext)) {
      errors.push(
        `"${where}.extension": "${ext}" is a format the editor writes itself. `
        + `A file with that name that a plugin produced is a file whose contents its name does not predict.`,
      );
      return;
    }
    if (seenExts.has(ext)) {
      errors.push(`"${at}" declares two exporters writing ".${ext}".`);
      return;
    }

    seenIds.add(id);
    seenExts.add(ext);
    out.push({ id, label: label.trim(), extension: ext });
  });

  return out;
}
