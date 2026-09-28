/**
 * SubRip / WebVTT text → the cues `premation-engine --prepare` makes caption
 * layers from (`premation render --captions subs.srt`). Main owns the file, so
 * main parses it; the engine builds the layers (the `setCaptions` command).
 *
 * The same rules as the editor's import (src/core/captions/captionFormat.ts —
 * duplicated rather than shared: electron/ cannot import src/): both
 * separators in both formats, BOM and CRLF tolerated, cues sorted and
 * de-overlapped, a caption wrapped to two lines of about 42 characters.
 */

export interface CaptionCue {
  /** Seconds from the start of the composition. */
  start: number;
  end: number;
  text: string;
}

/** The shortest a cue may be. Below this it flashes rather than reads. */
export const MIN_CUE_SECONDS = 1 / 30;

/** `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` → seconds. */
export function parseTimestamp(raw: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(raw);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseTimingLine(line: string): { start: number; end: number } | null {
  const parts = line.split('-->');
  if (parts.length !== 2) return null;
  const start = parseTimestamp(parts[0] as string);
  const end = parseTimestamp((parts[1] as string).trim().split(/\s+/)[0] ?? '');
  if (start === null || end === null) return null;
  return { start, end };
}

/** Parse SRT or WebVTT. Throws only when the file holds no cue at all. */
export function parseCaptions(text: string): CaptionCue[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: CaptionCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const timing = parseTimingLine(lines[i] as string);
    if (!timing) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.trim() === '') break;
      if (/^\d+$/.test(line.trim()) && parseTimingLine(lines[j + 1] ?? '')) break;
      body.push(line);
    }
    i = j;
    const content = body.join('\n').trim();
    if (content === '') continue;
    cues.push({ start: timing.start, end: Math.max(timing.end, timing.start + MIN_CUE_SECONDS), text: content });
  }
  if (cues.length === 0) {
    throw new Error('No captions found. An .srt or .vtt file needs timing lines like "00:00:01,000 --> 00:00:04,000".');
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Trim overlaps; a cue left shorter than the floor is dropped. */
export function deoverlap(cues: readonly CaptionCue[]): CaptionCue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const out: CaptionCue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i] as CaptionCue;
    const next = sorted[i + 1];
    const end = next ? Math.min(cue.end, next.start) : cue.end;
    if (end - cue.start < MIN_CUE_SECONDS) continue;
    out.push({ ...cue, end });
  }
  return out;
}

/** Break a caption onto at most `maxLines` lines of about `maxChars` (the rest on the last line). */
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
    if (lines.length === maxLines - 1) break;
  }
  const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
  const rest = words.slice(used).join(' ');
  if (rest) lines.push(rest);
  return lines.join('\n');
}

/** A caption file's text → the cues the engine lays out, and how many were dropped. */
export function captionCuesFromFile(text: string): { cues: CaptionCue[]; skipped: number } {
  const parsed = parseCaptions(text);
  const usable = deoverlap(parsed).map((c) => ({ ...c, text: wrapCaption(c.text) }));
  return { cues: usable, skipped: parsed.length - usable.length };
}
