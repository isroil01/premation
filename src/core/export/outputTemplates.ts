/**
 * Output-module templates — named render settings, applied in one click.
 *
 * The gap this closes: every queue entry was configured from scratch. AE ships
 * saved templates ("Lossless", "Draft") precisely because render settings are
 * the same three or four bundles forever, and re-dialling them per job is how
 * one job in the batch quietly ends up at the wrong quality.
 *
 * ── What a template stores, and what it deliberately does not ───────────────
 *
 * Resolution is stored as a SCALE, not pixels. "Half Res Draft" applied to a
 * 4K comp must mean 1920 — a template that froze absolute pixels would render
 * every comp at the size of whichever comp it was saved from, which is the
 * subtle version of wrong: it works until the first different-sized comp.
 *
 * Frame rate is `'comp'` or a number, mirroring AE's "use comp's frame rate"
 * versus an override. DURATION is never stored: a template describes how to
 * encode, and how long a comp runs is a fact about the comp.
 *
 * Persistence follows `effectClipboard`'s preset pattern: user templates in
 * localStorage, built-ins always present, a user template overrides a built-in
 * of the same name, and unreadable storage degrades to the built-ins rather
 * than throwing.
 */

import type { OutputFormat } from '@stores/renderQueueStore';
import type { ExportQuality } from '@core/export/videoSink';

export interface OutputTemplate {
  name: string;
  format: OutputFormat;
  quality: ExportQuality;
  transparent: boolean;
  /** Output size as a fraction of the comp (1 = full, 0.5 = half). */
  scale: number;
  /** `'comp'` follows the composition; a number overrides. */
  fps: number | 'comp';
  /**
   * Write the comp's labelled markers as chapter marks (MP4/MOV only).
   *
   * Optional, unlike every other field, and that asymmetry is deliberate:
   * templates already on disk were saved before this key existed, and a
   * required boolean would have made `isTemplate` reject every one of them —
   * silently emptying a user's template list on upgrade. Undefined therefore
   * reads as false, and the flag rides along like `transparent`: a per-format
   * intent that a template exists to stop people re-dialling.
   */
  chapters?: boolean;
}

const STORAGE_KEY = 'motion-editor.outputTemplates.v1';

/**
 * The shipped set. Deliberately few and deliberately boring — these are the
 * bundles people actually re-dial, not a showcase of the format list.
 */
export const BUILTIN_OUTPUT_TEMPLATES: ReadonlyArray<OutputTemplate> = [
  { name: 'Full Res WebM', format: 'webm', quality: 'high', transparent: false, scale: 1, fps: 'comp' },
  { name: 'Half Res Draft', format: 'webm', quality: 'draft', transparent: false, scale: 0.5, fps: 'comp' },
  { name: 'PNG Sequence (alpha)', format: 'png-sequence', quality: 'high', transparent: true, scale: 1, fps: 'comp' },
  { name: 'GIF Preview', format: 'gif', quality: 'medium', transparent: false, scale: 0.5, fps: 15 },
];

function isTemplate(v: unknown): v is OutputTemplate {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.name === 'string' && t.name.length > 0
    && typeof t.format === 'string'
    && typeof t.quality === 'string'
    && typeof t.transparent === 'boolean'
    && typeof t.scale === 'number' && Number.isFinite(t.scale) && t.scale > 0
    && (t.fps === 'comp' || (typeof t.fps === 'number' && Number.isFinite(t.fps) && t.fps > 0))
    // Absent is valid — see OutputTemplate.chapters for why this one is optional.
    && (t.chapters === undefined || typeof t.chapters === 'boolean')
  );
}

function readUser(): OutputTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validated per entry, not per file: one corrupt template must not take
    // the rest of the list down with it.
    return parsed.filter(isTemplate);
  } catch {
    return [];
  }
}

function writeUser(templates: OutputTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // Quota/private-mode failure: the save is lost but the session keeps
    // working — a template registry must never take the render queue down.
  }
}

/** Built-ins plus user templates; a user template overrides its namesake. */
export function listOutputTemplates(): OutputTemplate[] {
  const user = readUser();
  const overridden = new Set(user.map((t) => t.name));
  return [...BUILTIN_OUTPUT_TEMPLATES.filter((t) => !overridden.has(t.name)), ...user];
}

export function saveOutputTemplate(template: OutputTemplate): boolean {
  if (!isTemplate(template)) return false;
  writeUser([...readUser().filter((t) => t.name !== template.name), template]);
  return true;
}

/**
 * Delete a USER template. Deleting a built-in's override restores the built-in
 * rather than leaving a hole — the shipped set is a floor, not a suggestion.
 */
export function deleteOutputTemplate(name: string): void {
  writeUser(readUser().filter((t) => t.name !== name));
}

export function isBuiltinOutputTemplate(name: string): boolean {
  return BUILTIN_OUTPUT_TEMPLATES.some((t) => t.name === name);
}

/**
 * Resolve a template against a composition into concrete output settings.
 *
 * Sizes round to EVEN numbers: H.264 (and most hardware encoders) reject odd
 * dimensions, and a template is exactly the place that would otherwise mint
 * 959×539 from a half-res scale forever.
 */
export function applyOutputTemplate(
  template: OutputTemplate,
  comp: { width: number; height: number; fps: number },
): {
  format: OutputFormat;
  quality: ExportQuality;
  transparent: boolean;
  chapters: boolean;
  width: number;
  height: number;
  fps: number;
} {
  const even = (n: number): number => Math.max(2, 2 * Math.round((n * template.scale) / 2));
  return {
    format: template.format,
    quality: template.quality,
    transparent: template.transparent,
    // Normalised here so callers never have to know the field is optional.
    chapters: template.chapters ?? false,
    width: even(comp.width),
    height: even(comp.height),
    fps: template.fps === 'comp' ? comp.fps : template.fps,
  };
}
