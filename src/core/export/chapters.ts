/**
 * Composition markers → delivered chapter marks.
 *
 * A marker on the comp timeline is already the thing an author reaches for when
 * they mean "this is where the second section starts". Until now that meaning
 * died at the export boundary: the marker was a coloured tick in the editor and
 * the delivered MP4 had no structure at all. This module is the whole
 * translation, kept pure so the rule is testable without an encoder — the sink
 * calls `formatFfmetadata` and hands the TEXT to the main process, which writes
 * it beside the staged frames and points ffmpeg at it.
 *
 * ── Why COMPOSITION markers only ────────────────────────────────────────────
 *
 * Layer markers are stored layer-relative and travel with a trimmed or slid
 * layer (see `TimelineController.getLayerMarkers`) — they annotate a layer, not
 * the deliverable. Ten layers each carrying "start" would mint ten chapters
 * over the same second. Chapters describe the FILE, so only the comp's own
 * marker track can produce them, and the caller passes exactly that list.
 *
 * ── Why an unlabelled marker is not a chapter ───────────────────────────────
 *
 * Markers get dropped on the timeline as navigation aids constantly, and most
 * of them never get named. A chapter with no title shows in a player's chapter
 * menu as a blank row, which is worse than no chapter list at all. So a marker
 * earns a chapter by having a label, and "Marker" — the placeholder the
 * controller substitutes for an empty name — counts as no label at all.
 *
 * ── Every chapter runs to the next one ──────────────────────────────────────
 *
 * ffmpeg's chapter model is a set of intervals, not a set of instants: START
 * and END are both required and players draw the segment between them. A file
 * whose chapters have zero length lists them and seeks nowhere. So each chapter
 * ends where the next begins, and the last one ends at the composition's end.
 */

/**
 * The shape this module needs from a marker — structurally satisfied by
 * `TimelineMarkerView` (the comp-seconds view `getMarkers()` returns), without
 * this module importing the timeline.
 */
export interface ChapterMarkerLike {
  /** Composition time in SECONDS. */
  time: number;
  label?: string | undefined;
}

/** One delivered chapter. Milliseconds, because the ffmetadata timebase is 1/1000. */
export interface ExportChapter {
  startMs: number;
  /** Exclusive end — the next chapter's start, or the composition end. */
  endMs: number;
  title: string;
}

/** The placeholder `getMarkers()` substitutes for an unnamed marker. */
const PLACEHOLDER_LABEL = 'Marker';

/**
 * Seconds → whole milliseconds, snapped to the frame grid first.
 *
 * Marker times arrive as `frame / fps`, so a 29.97 comp hands over values like
 * 3.3366699999999996. Rounding that straight to milliseconds is fine, but
 * re-deriving the frame first keeps a chapter on the exact frame the marker sits
 * on rather than one that merely rounds nearby — the same reason the encode
 * hands ffmpeg a rational frame rate instead of a decimal.
 */
function msAtFrameGrid(timeSec: number, fps: number): number {
  if (!Number.isFinite(timeSec)) return Number.NaN;
  if (!Number.isFinite(fps) || fps <= 0) return Math.round(timeSec * 1000);
  const frame = Math.round(timeSec * fps);
  return Math.round((frame / fps) * 1000);
}

/**
 * Ordered chapters covering `durationSec`, one per labelled composition marker.
 *
 * Times are on the DELIVERED file's clock, which is not the comp's when a work
 * area is exported: the caller shifts marker times by the range start first, so
 * a marker before the range arrives NEGATIVE. Those are dropped, not clamped to
 * zero — a chapter for a section the file does not contain is worse than no
 * chapter. The same goes at the other end: a marker at or past the end would be
 * a zero-length entry in the menu, and one parked past the out-point is
 * leftover editing state rather than delivery intent. Two markers landing on
 * the same millisecond collapse to the first, for the same zero-length reason.
 */
export function chaptersFromMarkers(
  markers: ReadonlyArray<ChapterMarkerLike>,
  fps: number,
  durationSec: number,
): ExportChapter[] {
  const endMs = msAtFrameGrid(Math.max(0, durationSec), fps);
  if (endMs <= 0) return [];

  const starts: Array<{ startMs: number; title: string }> = [];
  for (const marker of markers) {
    const title = (marker.label ?? '').trim();
    if (!title || title === PLACEHOLDER_LABEL) continue;
    const startMs = msAtFrameGrid(marker.time, fps);
    if (!Number.isFinite(startMs) || startMs < 0 || startMs >= endMs) continue;
    starts.push({ startMs, title });
  }
  if (starts.length === 0) return [];

  // Stable by start: markers arrive in whatever order the marker set stored
  // them, and a chapter list out of order is one ffmpeg accepts and players
  // render as a scrambled menu.
  starts.sort((a, b) => a.startMs - b.startMs);

  const out: ExportChapter[] = [];
  for (const entry of starts) {
    const previous = out[out.length - 1];
    if (previous && previous.startMs === entry.startMs) continue;
    out.push({ startMs: entry.startMs, endMs, title: entry.title });
  }
  for (let i = 0; i < out.length - 1; i++) {
    // Non-null by construction: `i + 1` is in range for every iteration.
    out[i]!.endMs = out[i + 1]!.startMs;
  }
  return out;
}

/**
 * Escape one ffmetadata VALUE.
 *
 * `=`, `;`, `#` and `\` are the file format's own syntax (assignment, comment,
 * comment, escape) and must be backslash-escaped inside a value or the parser
 * silently truncates the title at the first one — a chapter called
 * "Act 1; Act 2" would deliver as "Act 1". Newlines END a record, so a title
 * carrying one would turn the rest of itself into a bogus key=value line;
 * whitespace runs therefore collapse to a single space rather than escaping —
 * a chapter title is one menu row, and a two-line one is a bug in the title.
 */
function escapeFfmetadataValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[=;#\\]/g, (ch) => `\\${ch}`)
    .trim();
}

/**
 * The FFMETADATA1 text for `chapters`, or `''` when there are none.
 *
 * The empty string is the signal to write no file and add no ffmpeg arguments:
 * a metadata input with zero chapters, mapped over the output, is a request to
 * REPLACE whatever chapters the encode would have had with nothing.
 */
export function formatFfmetadata(chapters: ReadonlyArray<ExportChapter>): string {
  if (chapters.length === 0) return '';
  const lines = [';FFMETADATA1'];
  for (const chapter of chapters) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.max(0, Math.round(chapter.startMs))}`,
      `END=${Math.max(0, Math.round(chapter.endMs))}`,
      `title=${escapeFfmetadataValue(chapter.title)}`,
    );
  }
  // Trailing newline: ffmpeg's ffmetadata demuxer reads records line by line and
  // an unterminated final line is one it can drop.
  return `${lines.join('\n')}\n`;
}

/**
 * Formats whose container can actually carry chapters.
 *
 * WebM is deliberately absent. The browser path muxes WebM here in the
 * renderer, and that muxer writes no Chapters element at all (webmMuxer.ts:18
 * — "no lacing, no BlockGroups, no chapters"), so offering the option there
 * would tick a box that changes nothing about the delivered file. GIF has no
 * metadata to speak of; the image sequences are ZIPs.
 */
export function formatCarriesChapters(format: string): boolean {
  return format === 'mp4' || format === 'mov' || format === 'hdr10' || format === 'hlg';
}
