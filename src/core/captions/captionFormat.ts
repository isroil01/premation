/**
 * SubRip (`.srt`) and WebVTT (`.vtt`) — parsing and writing, and nothing else.
 *
 * Pure by design: text in, cues out, text back. The scene-touching half is
 * `captionLayers.ts`, and keeping the formats here is what lets the fiddly
 * parts — a timestamp that uses a comma in one format and a period in the
 * other, a cue whose text contains a blank line, a file that arrives with CRLF
 * and a BOM from a Windows transcription service — be tested without a
 * document, a timeline or a renderer.
 *
 * ── Why hand-written, again ────────────────────────────────────────────
 * Same argument as `dataTable.ts`: the formats are small, the edge cases are
 * exactly the ones a dependency would also have to get right, and the app
 * already declines to reach for a parser at the expression layer. SRT in
 * particular has no specification, only a consensus, so "what real files do"
 * is the actual requirement and a library's opinion is not obviously better
 * than the one written down here.
 */

/** One caption: a time range and the words shown across it. */
export interface Cue {
  /** Seconds from the start of the composition. */
  start: number;
  /** Seconds; always ≥ start. */
  end: number;
  /** The caption text. May contain newlines — a two-line caption is normal. */
  text: string;
}

export class CaptionFormatError extends Error {}

/** The shortest a cue may be. Below this it flashes rather than reads. */
export const MIN_CUE_SECONDS = 1 / 30;

/**
 * `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` / `MM:SS.mmm` (VTT) → seconds.
 *
 * Both separators are accepted for both formats on purpose. Real files mix
 * them — a `.vtt` exported by a tool that only ever wrote SRT is common — and
 * refusing one would be a parser that is right about the spec and useless
 * against the files people have.
 */
export function parseTimestamp(raw: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(raw);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  // `.5` means half a second, not five milliseconds, so the fraction is padded
  // rather than divided by a fixed 1000.
  const millis = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Seconds → `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT). */
export function formatTimestamp(seconds: number, separator: ',' | '.' = ','): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  // Rounded, not truncated: truncation loses up to a millisecond per cue, and
  // a round-trip through this file must not drift the captions earlier.
  const millis = Math.round((clamped - whole) * 1000);
  // A round to 1000 must carry, or 3.9996s writes as "00:00:03,1000".
  const carry = millis === 1000 ? 1 : 0;
  const total = whole + carry;
  const ms = carry ? 0 : millis;
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}${separator}${String(ms).padStart(3, '0')}`;
}

/** Normalise line endings and strip the BOM a Windows tool leaves behind. */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Split a cue-timing line into its two timestamps, whatever surrounds them. */
function parseTimingLine(line: string): { start: number; end: number } | null {
  const parts = line.split('-->');
  if (parts.length !== 2) return null;
  const start = parseTimestamp(parts[0] as string);
  // WebVTT allows cue settings after the end time (`align:middle line:90%`),
  // and they are not our business — take the timestamp and drop the rest.
  const end = parseTimestamp((parts[1] as string).trim().split(/\s+/)[0] ?? '');
  if (start === null || end === null) return null;
  return { start, end };
}

/**
 * Parse SRT or WebVTT. One parser, because they differ in a header, an index
 * line and a separator character — and every real file blurs at least one of
 * those. Anything that is not a cue is skipped rather than fatal: a `NOTE`
 * block, a `STYLE` block, or a stray index has never been a reason to reject
 * someone's subtitles.
 *
 * Throws only when the file contains NO cue at all, which is the one case the
 * caller genuinely needs to hear about.
 */
export function parseCaptions(text: string): Cue[] {
  const lines = normalize(text).split('\n');
  const cues: Cue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const timing = parseTimingLine(lines[i] as string);
    if (!timing) continue;

    // Text runs to the next blank line. A cue's own text may contain a blank
    // line in malformed files, but treating a blank line as the terminator is
    // what every player does, so it is what a round-trip must agree with.
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.trim() === '') break;
      // A stray index line before the NEXT cue's timing (SRT's numbering) is
      // not part of this cue's text.
      if (/^\d+$/.test(line.trim()) && parseTimingLine(lines[j + 1] ?? '')) break;
      body.push(line);
    }
    i = j;

    const content = body.join('\n').trim();
    if (content === '') continue; // a timed cue with no words shows nothing
    cues.push({
      start: timing.start,
      // A zero- or negative-length cue would never be visible; give it the
      // floor rather than dropping words the file plainly contains.
      end: Math.max(timing.end, timing.start + MIN_CUE_SECONDS),
      text: content,
    });
  }

  if (cues.length === 0) {
    throw new CaptionFormatError(
      'No captions found. An .srt or .vtt file needs timing lines like "00:00:01,000 --> 00:00:04,000".',
    );
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Serialise cues as SubRip. */
export function toSrt(cues: readonly Cue[]): string {
  return cues
    .map((cue, i) =>
      `${i + 1}\n${formatTimestamp(cue.start, ',')} --> ${formatTimestamp(cue.end, ',')}\n${cue.text}\n`,
    )
    .join('\n');
}

/** Serialise cues as WebVTT. */
export function toVtt(cues: readonly Cue[]): string {
  const body = cues
    .map((cue) => `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(cue.end, '.')}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/**
 * Stop cues overlapping, in place-order.
 *
 * Two captions on screen at once is almost always a transcription artefact
 * rather than an intent, and it renders as text over text. A cue that runs
 * past the next one's start is trimmed; one left shorter than the floor is
 * dropped, because a two-frame flash is not a caption.
 */
export function deoverlap(cues: readonly Cue[]): Cue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const out: Cue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i] as Cue;
    const next = sorted[i + 1];
    const end = next ? Math.min(cue.end, next.start) : cue.end;
    if (end - cue.start < MIN_CUE_SECONDS) continue;
    out.push({ ...cue, end });
  }
  return out;
}

/**
 * Break a long caption onto at most `maxLines` lines of about `maxChars`.
 *
 * Broadcast practice is ~42 characters a line and at most two lines, and a
 * transcript arrives as one long sentence per cue. Wrapping on words here — in
 * the model — rather than letting the renderer wrap on width means the break
 * points survive an export and are the same on every machine, whatever font is
 * installed.
 */
export function wrapCaption(text: string, maxChars = 42, maxLines = 2): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return text;
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars || line === '') {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    // Past the line budget, the remaining words all go on the last line rather
    // than being dropped: an over-long caption is a visible problem the user
    // can fix, missing words are not.
    if (lines.length === maxLines - 1) break;
  }
  const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
  const rest = words.slice(used).join(' ');
  if (rest) lines.push(rest);
  return lines.join('\n');
}
