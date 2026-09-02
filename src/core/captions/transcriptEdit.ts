/**
 * Text-based editing — the range arithmetic, and nothing that touches a scene.
 *
 * The Transcript panel deletes TIME, not text. Selecting three words and
 * pressing Delete has to become: split every clip that straddles the words'
 * time range, drop what is inside it, slide everything after it left by the
 * length removed, and move the rest of the transcript left by the same amount
 * so the words still sit under the picture they describe.
 *
 * Every one of those steps is arithmetic on intervals, and every one of them is
 * the kind of arithmetic that is wrong by a frame in a way nobody notices until
 * a cut lands mid-syllable. So it lives here, pure, and the panel does the
 * scene work with the answers.
 *
 * ── Why words are DERIVED, not transcribed ───────────────────────────────
 * The provider this app talks to (`electron/aiProxy.ts`) asks whisper for
 * `timestamp_granularities[]=segment`, so what comes back is one time range per
 * SENTENCE. There are no word timings in the response, and pretending otherwise
 * would be the worst kind of wrong: chips that look exact and are not.
 *
 * `wordsFromCues` therefore states its estimate openly — it divides a segment's
 * duration across its words in proportion to how long each word is to say,
 * approximated by character count. That is good enough for the two jobs the
 * word chips have (seek near a word, select a run of words to cut) and it is
 * honest about being an estimate: `TranscriptWord.estimated` says so, and the
 * panel labels it. If segment timings are ever joined by word timings, this is
 * the one function that changes.
 *
 * ── The joining gap ──────────────────────────────────────────────────────
 * Two words the user selected are almost never mathematically adjacent — the
 * estimate above puts a sliver between them, and a real word-timed transcript
 * puts the breath between them. Cutting each word as its own range would leave
 * a scatter of millisecond-long clips behind, which is both slower and visibly
 * wrong. `DEFAULT_JOIN_GAP_SECONDS` is the width of gap that gets swallowed
 * rather than preserved.
 */

import type { Cue } from './captionFormat';

/** One word of a transcript, positioned in COMPOSITION seconds. */
export interface TranscriptWord {
  /** Stable within one transcript. Not a scene id — nothing looks it up. */
  readonly id: string;
  /** As shown, punctuation included. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Which cue (segment) it came from — what regroups words back into cues. */
  readonly cueIndex: number;
  /** True when the timing was interpolated inside a segment rather than given. */
  readonly estimated: boolean;
}

/** A half-open interval of composition time, in seconds. */
export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Gaps at or below this are absorbed when selected words are merged into
 * ranges. A twelfth of a second is under one frame at 8 fps and about three at
 * 24 — short enough that it is never a beat the editor meant to keep, long
 * enough to swallow the space between two words.
 */
export const DEFAULT_JOIN_GAP_SECONDS = 0.12;

/**
 * Shorter than this and a clip fragment is not a shot, it is a flash. Pieces
 * left below it by a deletion are removed rather than kept, which is what stops
 * a cut on a word boundary leaving a two-frame stub of the previous clip.
 */
export const MIN_PIECE_SECONDS = 1 / 60;

/** Floating-point slack. Comp times are seconds; a microsecond is not a beat. */
const EPSILON = 1e-6;

// ── Words ─────────────────────────────────────────────────────────────

/**
 * Punctuation stripped before a word is compared to a filler list or a search.
 *
 * Deliberately a fixed set rather than `\P{L}`: an apostrophe is part of
 * "don't" and a hyphen is part of "well-known", so a rule that removed every
 * non-letter would make two different words compare equal.
 */
const EDGE_PUNCTUATION = /^[\s"'“”‘’([{<.,!?;:…—–-]+|[\s"'“”‘’)\]}>.,!?;:…—–-]+$/g;

/** Lowercased, stripped of the punctuation that clings to a word's edges. */
export function normalizeWordText(text: string): string {
  return text.replace(EDGE_PUNCTUATION, '').toLowerCase();
}

/**
 * Split cues into words, estimating a time for each.
 *
 * Weight is `characters + 1` — the +1 is the space, and without it a segment of
 * one-letter words distributes its time almost entirely to the last one. A cue
 * whose text is only whitespace contributes nothing rather than a zero-length
 * word, which would otherwise be an unclickable chip.
 */
export function wordsFromCues(cues: readonly Cue[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const [cueIndex, cue] of cues.entries()) {
    const tokens = cue.text.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const span = Math.max(0, cue.end - cue.start);
    const weights = tokens.map((t) => t.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let cursor = cue.start;
    for (const [i, token] of tokens.entries()) {
      const weight = weights[i] ?? 1;
      // The LAST word ends exactly on the cue's end. Accumulating fractions
      // and hoping they sum is how a transcript drifts a few milliseconds per
      // segment until a "delete these words" range overruns the next cue.
      const end = i === tokens.length - 1 ? cue.end : cursor + (span * weight) / total;
      out.push({
        id: `w${cueIndex}_${i}`,
        text: token,
        start: cursor,
        end: Math.max(cursor, end),
        cueIndex,
        estimated: true,
      });
      cursor = Math.max(cursor, end);
    }
  }
  return out;
}

/**
 * Regroup words back into cues, one per contiguous run of the same segment.
 *
 * A run, not a segment: deleting words out of the middle of a sentence leaves
 * two spoken fragments with a hole between them, and emitting them as ONE cue
 * would put a caption on screen across a cut that no longer contains its words.
 */
export function cuesFromWords(words: readonly TranscriptWord[]): Cue[] {
  const cues: Cue[] = [];
  let run: TranscriptWord[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0] as TranscriptWord;
    const last = run[run.length - 1] as TranscriptWord;
    cues.push({
      start: first.start,
      end: Math.max(last.end, first.start),
      text: run.map((w) => w.text).join(' '),
    });
    run = [];
  };

  for (const word of words) {
    const prev = run[run.length - 1];
    // A gap wider than the joining gap breaks the run even inside one segment:
    // that hole is where a deletion happened.
    if (prev && (prev.cueIndex !== word.cueIndex || word.start - prev.end > DEFAULT_JOIN_GAP_SECONDS + EPSILON)) {
      flush();
    }
    run.push(word);
  }
  flush();
  return cues;
}

// ── Ranges ────────────────────────────────────────────────────────────

/** Sort, drop the empty ones, and merge anything closer than `joinGap`. */
export function mergeRanges(
  ranges: readonly TimeRange[],
  joinGap = DEFAULT_JOIN_GAP_SECONDS,
): TimeRange[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.max(r.start, r.end) }))
    .filter((r) => r.end - r.start > EPSILON)
    .sort((a, b) => a.start - b.start);

  const out: TimeRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start - last.end <= joinGap + EPSILON) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
      continue;
    }
    out.push(range);
  }
  return out;
}

/**
 * The time ranges a set of selected words covers.
 *
 * Selection is by id rather than by index because the panel filters its list —
 * a user who searched for "um", selected four chips and cleared the search must
 * delete those four words, not the four now in those positions.
 */
export function selectionRanges(
  words: readonly TranscriptWord[],
  selected: ReadonlySet<string>,
  joinGap = DEFAULT_JOIN_GAP_SECONDS,
): TimeRange[] {
  const picked = words
    .filter((w) => selected.has(w.id))
    .map((w) => ({ start: w.start, end: w.end }));
  return mergeRanges(picked, joinGap);
}

/** How much time a set of (already merged) ranges removes. */
export function deletedDuration(ranges: readonly TimeRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
}

/**
 * Where `t` lands once `ranges` are cut out and the gaps closed.
 *
 * Monotone by construction: a time INSIDE a deleted range maps to the seam the
 * deletion leaves, which is where it should be — it is the one answer that
 * keeps "before" and "after" in the same order they were.
 */
export function mapTimeAfterDeletions(t: number, ranges: readonly TimeRange[]): number {
  let shift = 0;
  for (const range of ranges) {
    if (range.start >= t) break; // ranges are sorted; nothing later can matter
    shift += Math.min(t, range.end) - range.start;
  }
  return Math.max(0, t - shift);
}

/** True when `t` falls strictly inside one of the deleted ranges. */
export function isDeleted(t: number, ranges: readonly TimeRange[]): boolean {
  return ranges.some((r) => t > r.start + EPSILON && t < r.end - EPSILON);
}

/**
 * What is left of `clip` once `ranges` are removed — before the gaps close.
 *
 * The pieces are in the ORIGINAL time base on purpose: this is the function the
 * timeline surgery reads to decide where to split, and a split happens at a
 * time that still exists.
 */
export function subtractRanges(clip: TimeRange, ranges: readonly TimeRange[]): TimeRange[] {
  let pieces: TimeRange[] = [{ start: clip.start, end: clip.end }];
  for (const range of ranges) {
    const next: TimeRange[] = [];
    for (const piece of pieces) {
      if (range.end <= piece.start + EPSILON || range.start >= piece.end - EPSILON) {
        next.push(piece);
        continue;
      }
      if (range.start > piece.start + EPSILON) next.push({ start: piece.start, end: range.start });
      if (range.end < piece.end - EPSILON) next.push({ start: range.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.end - p.start > EPSILON);
}

/**
 * The timeline that remains after the deletions, gaps closed.
 *
 * Pieces shorter than {@link MIN_PIECE_SECONDS} are dropped rather than kept:
 * cutting on a word boundary routinely leaves a frame or two of the outgoing
 * clip, which is a flash, not a shot.
 */
export function remainingClips(
  clips: readonly TimeRange[],
  ranges: readonly TimeRange[],
): TimeRange[] {
  const out: TimeRange[] = [];
  for (const clip of clips) {
    for (const piece of subtractRanges(clip, ranges)) {
      if (piece.end - piece.start < MIN_PIECE_SECONDS) continue;
      out.push({
        start: mapTimeAfterDeletions(piece.start, ranges),
        end: mapTimeAfterDeletions(piece.end, ranges),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The transcript after the deletions — words inside the cut removed, everything
 * later pulled back by the same amount.
 *
 * A word counts as deleted when the cut takes more than HALF of it. A cut that
 * clips a syllable off the end of a word leaves the word: it is still audible
 * and still readable, and dropping it would make the transcript disagree with
 * what the timeline now plays.
 */
export function applyDeletionsToWords(
  words: readonly TranscriptWord[],
  ranges: readonly TimeRange[],
): TranscriptWord[] {
  if (ranges.length === 0) return [...words];
  const out: TranscriptWord[] = [];
  for (const word of words) {
    const span = Math.max(0, word.end - word.start);
    let removed = 0;
    for (const range of ranges) {
      removed += Math.max(0, Math.min(word.end, range.end) - Math.max(word.start, range.start));
    }
    // A zero-length word (possible in a degenerate cue) is deleted when its
    // point falls in a range at all — there is no half of it to compare.
    if (span <= EPSILON ? isDeleted(word.start, ranges) : removed > span / 2) continue;
    out.push({
      ...word,
      start: mapTimeAfterDeletions(word.start, ranges),
      end: mapTimeAfterDeletions(word.end, ranges),
    });
  }
  return out;
}

// ── Selection helpers ─────────────────────────────────────────────────

/**
 * Every word id between two chips, inclusive, in the order `words` holds.
 *
 * Index order, not time order: a shift-click selects the run the user can SEE
 * between the two chips, and the panel renders words in the order it was given
 * them.
 */
export function idsBetween(
  words: readonly TranscriptWord[],
  anchorId: string,
  focusId: string,
): string[] {
  const a = words.findIndex((w) => w.id === anchorId);
  const b = words.findIndex((w) => w.id === focusId);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return words.slice(lo, hi + 1).map((w) => w.id);
}

/** The word under a composition time, or null between words / off the end. */
export function wordAtTime(words: readonly TranscriptWord[], t: number): TranscriptWord | null {
  // Linear, and deliberately: a transcript is hundreds of words, this runs ten
  // times a second, and a binary search here would be a cleverness that has to
  // be kept correct for no measurable gain.
  for (const word of words) {
    if (t >= word.start - EPSILON && t < word.end) return word;
  }
  return null;
}

// ── Filler words ──────────────────────────────────────────────────────

/**
 * The defaults, and why this list is short.
 *
 * Every entry here is a sound rather than a word — something a speaker emits
 * while thinking. The tempting additions ("so", "right", "well", "okay") are
 * real words that carry real meaning at the start of a sentence, and a helper
 * that silently cuts them produces an edit the user has to undo and then
 * distrust. "like" and "actually" are the debatable ones and they are in
 * because they are what people actually ask this feature for — and because the
 * list is editable, which is the point.
 */
export const DEFAULT_FILLER_WORDS: readonly string[] = [
  'um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'mhm', 'mm',
  'like', 'actually', 'basically', 'literally',
  'you know', 'i mean', 'sort of', 'kind of',
];

/**
 * Which words a filler list selects.
 *
 * Phrases are supported (`you know`), which is why this walks runs rather than
 * testing one word at a time: the two halves of "you know" are both ordinary
 * words on their own, and only the pair is a filler. Longer phrases are tried
 * first so "you know" wins over a hypothetical "know".
 */
export function findFillerWordIds(
  words: readonly TranscriptWord[],
  fillers: readonly string[] = DEFAULT_FILLER_WORDS,
): string[] {
  const phrases = fillers
    .map((f) => normalizeWordText(f).split(/\s+/).filter(Boolean))
    .filter((parts) => parts.length > 0)
    .sort((a, b) => b.length - a.length);
  if (phrases.length === 0) return [];

  const normalized = words.map((w) => normalizeWordText(w.text));
  const ids: string[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = 0;
    for (const parts of phrases) {
      if (i + parts.length > words.length) continue;
      let ok = true;
      for (const [k, part] of parts.entries()) {
        if (normalized[i + k] !== part) { ok = false; break; }
      }
      if (!ok) continue;
      matched = parts.length;
      break;
    }
    if (matched === 0) { i += 1; continue; }
    for (let k = 0; k < matched; k++) {
      const word = words[i + k];
      if (word) ids.push(word.id);
    }
    i += matched;
  }
  return ids;
}

/** Parse the editable filler-list field: comma or newline separated. */
export function parseFillerList(raw: string): string[] {
  const seen = new Set<string>();
  for (const entry of raw.split(/[,\n]/)) {
    const normalized = normalizeWordText(entry.trim()).replace(/\s+/g, ' ').trim();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

// ── Search ────────────────────────────────────────────────────────────

/**
 * Does this word match the search box?
 *
 * Substring on the NORMALIZED text, so typing `dont` finds "don't" only if the
 * apostrophe is not in the middle — which it is, so it does not. That is the
 * right trade: stripping interior punctuation would make "well-known" match
 * "wellknown" and nothing else the user would type.
 */
export function wordMatchesQuery(word: TranscriptWord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return word.text.toLowerCase().includes(q) || normalizeWordText(word.text).includes(q);
}
