/**
 * The arithmetic behind text-based editing.
 *
 * Every assertion here stands for a way the panel can be wrong in a manner the
 * user reads as a rendering bug rather than as a maths bug: a cut that lands a
 * frame late, a transcript that stops agreeing with the picture after one
 * deletion, a filler-word helper that eats the word before the filler.
 */

import type { Cue } from './captionFormat';
import {
  DEFAULT_FILLER_WORDS,
  DEFAULT_JOIN_GAP_SECONDS,
  MIN_PIECE_SECONDS,
  applyDeletionsToWords,
  cuesFromWords,
  deletedDuration,
  findFillerWordIds,
  idsBetween,
  isDeleted,
  mapTimeAfterDeletions,
  mergeRanges,
  normalizeWordText,
  parseFillerList,
  remainingClips,
  selectionRanges,
  subtractRanges,
  wordAtTime,
  wordMatchesQuery,
  wordsFromCues,
  type TranscriptWord,
} from './transcriptEdit';

const cue = (start: number, end: number, text: string): Cue => ({ start, end, text });

/** A hand-built word so a test does not have to go through the estimator. */
const word = (id: string, start: number, end: number, text: string, cueIndex = 0): TranscriptWord =>
  ({ id, text, start, end, cueIndex, estimated: true });

describe('wordsFromCues', () => {
  it('splits a cue into words and spans exactly its range', () => {
    const words = wordsFromCues([cue(1, 3, 'hello there world')]);
    expect(words.map((w) => w.text)).toEqual(['hello', 'there', 'world']);
    expect(words[0]?.start).toBe(1);
    // The LAST word ends on the cue's end exactly — no accumulated drift.
    expect(words[2]?.end).toBe(3);
  });

  it('leaves no gaps or overlaps between consecutive words', () => {
    const words = wordsFromCues([cue(0, 4, 'a bb ccc dddd')]);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]?.start).toBeCloseTo(words[i - 1]?.end as number, 9);
    }
  });

  it('gives a longer word more time than a shorter one', () => {
    const words = wordsFromCues([cue(0, 10, 'a extraordinarily')]);
    const first = (words[0]?.end as number) - (words[0]?.start as number);
    const second = (words[1]?.end as number) - (words[1]?.start as number);
    expect(second).toBeGreaterThan(first);
  });

  it('marks every derived timing as an estimate', () => {
    // The panel says so in the UI; if this ever flips to false it must be
    // because real word timings arrived, not because someone tidied a flag.
    expect(wordsFromCues([cue(0, 1, 'hi')]).every((w) => w.estimated)).toBe(true);
  });

  describe('with the provider’s own word timings', () => {
    it('uses them verbatim and stops calling them estimates', () => {
      // The estimator would put the boundary at 1.4 (weights 6 and 4 across
      // 0–2); the real timing says the pause is at 1.5, and a real pause is
      // not a character count.
      const words = wordsFromCues(
        [cue(0, 2, 'hello world')],
        [
          { text: 'hello', start: 0.1, end: 0.8 },
          { text: 'world', start: 1.5, end: 1.9 },
        ],
      );
      expect(words.map((w) => [w.start, w.end])).toEqual([[0.1, 0.8], [1.5, 1.9]]);
      expect(words.every((w) => w.estimated)).toBe(false);
      // The TEXT still comes from the cue, so punctuation the word list drops
      // is not silently lost from the transcript.
      expect(words.map((w) => w.text)).toEqual(['hello', 'world']);
    });

    it('keeps the cue’s punctuation while taking the timing', () => {
      const words = wordsFromCues(
        [cue(0, 2, 'Hello, world!')],
        [
          { text: 'Hello', start: 0.2, end: 0.6 },
          { text: 'world', start: 1.1, end: 1.6 },
        ],
      );
      expect(words.map((w) => w.text)).toEqual(['Hello,', 'world!']);
      expect(words[0]?.start).toBe(0.2);
      expect(words.every((w) => w.estimated)).toBe(false);
    });

    it('claims a word by its MIDPOINT, so an edge word poking past the cue counts', () => {
      const words = wordsFromCues(
        [cue(0, 2, 'one two')],
        [
          { text: 'one', start: 0, end: 0.5 },
          // Ends past the cue; its midpoint (1.9) is still inside.
          { text: 'two', start: 1.7, end: 2.1 },
        ],
      );
      expect(words.every((w) => w.estimated)).toBe(false);
      expect(words[1]?.end).toBe(2.1);
    });

    it('skips a provider word the segment text merged, rather than giving up', () => {
      const words = wordsFromCues(
        [cue(0, 3, 'well known fact')],
        [
          { text: 'well', start: 0, end: 0.4 },
          { text: '-', start: 0.4, end: 0.4 },
          { text: 'known', start: 0.5, end: 1.0 },
          { text: 'fact', start: 1.2, end: 1.8 },
        ],
      );
      expect(words.map((w) => w.start)).toEqual([0, 0.5, 1.2]);
      expect(words.every((w) => w.estimated)).toBe(false);
    });

    it('falls back to the estimate for a cue whose words do not line up', () => {
      const words = wordsFromCues(
        [cue(0, 2, 'hello there world')],
        [{ text: 'goodbye', start: 0.1, end: 0.9 }],
      );
      expect(words.every((w) => w.estimated)).toBe(true);
      expect(words[0]?.start).toBe(0);
      expect(words[2]?.end).toBe(2);
    });

    it('falls back PER CUE — one bad segment does not spoil the good ones', () => {
      const words = wordsFromCues(
        [cue(0, 2, 'one two'), cue(3, 5, 'three four')],
        [
          { text: 'one', start: 0.1, end: 0.6 },
          { text: 'two', start: 0.9, end: 1.4 },
          // Nothing for the second cue.
        ],
      );
      expect(words.filter((w) => w.cueIndex === 0).every((w) => w.estimated)).toBe(false);
      expect(words.filter((w) => w.cueIndex === 1).every((w) => w.estimated)).toBe(true);
    });

    it('is the old function when the word list is empty', () => {
      expect(wordsFromCues([cue(0, 2, 'a b c')], [])).toEqual(wordsFromCues([cue(0, 2, 'a b c')]));
    });
  });

  it('carries the cue index so words can be regrouped', () => {
    const words = wordsFromCues([cue(0, 1, 'one'), cue(2, 3, 'two')]);
    expect(words.map((w) => w.cueIndex)).toEqual([0, 1]);
  });

  it('ignores a cue with no words rather than emitting a zero-length chip', () => {
    expect(wordsFromCues([cue(0, 1, '   ')])).toEqual([]);
  });

  it('keeps newline-separated words — a two-line caption is one segment', () => {
    expect(wordsFromCues([cue(0, 2, 'top line\nbottom line')]).map((w) => w.text))
      .toEqual(['top', 'line', 'bottom', 'line']);
  });
});

describe('cuesFromWords', () => {
  it('rejoins a segment into one cue', () => {
    const cues = cuesFromWords(wordsFromCues([cue(0, 2, 'hello there world')]));
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('hello there world');
    expect(cues[0]?.start).toBe(0);
    expect(cues[0]?.end).toBe(2);
  });

  it('splits a segment where a deletion left a hole', () => {
    // "one two three" with the middle removed and NOT rippled: the two halves
    // are a second apart, so they are two cues, not one caption spanning a cut.
    const cues = cuesFromWords([
      word('a', 0, 0.5, 'one'),
      word('b', 1.5, 2, 'three'),
    ]);
    expect(cues).toHaveLength(2);
    expect(cues.map((c) => c.text)).toEqual(['one', 'three']);
  });

  it('does not split on the ordinary sliver between two words', () => {
    const cues = cuesFromWords([
      word('a', 0, 0.5, 'one'),
      word('b', 0.5 + DEFAULT_JOIN_GAP_SECONDS / 2, 1, 'two'),
    ]);
    expect(cues).toHaveLength(1);
  });

  it('never joins two different segments', () => {
    const cues = cuesFromWords([word('a', 0, 0.5, 'one', 0), word('b', 0.5, 1, 'two', 1)]);
    expect(cues).toHaveLength(2);
  });
});

describe('mergeRanges', () => {
  it('merges ranges separated by less than the joining gap', () => {
    const merged = mergeRanges([{ start: 0, end: 1 }, { start: 1.05, end: 2 }]);
    expect(merged).toEqual([{ start: 0, end: 2 }]);
  });

  it('keeps a real pause between two selections', () => {
    const merged = mergeRanges([{ start: 0, end: 1 }, { start: 3, end: 4 }]);
    expect(merged).toHaveLength(2);
  });

  it('sorts and absorbs overlaps whatever order it is given', () => {
    expect(mergeRanges([{ start: 2, end: 3 }, { start: 0, end: 2.5 }]))
      .toEqual([{ start: 0, end: 3 }]);
  });

  it('drops an empty range instead of emitting a zero-length cut', () => {
    expect(mergeRanges([{ start: 1, end: 1 }])).toEqual([]);
  });

  it('never produces a negative start', () => {
    expect(mergeRanges([{ start: -5, end: 1 }])).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('selectionRanges', () => {
  const words = wordsFromCues([cue(0, 4, 'one two three four')]);

  it('turns a run of selected chips into one range', () => {
    const ids = new Set([words[1]?.id as string, words[2]?.id as string]);
    const ranges = selectionRanges(words, ids);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.start).toBeCloseTo(words[1]?.start as number, 9);
    expect(ranges[0]?.end).toBeCloseTo(words[2]?.end as number, 9);
  });

  it('keeps two non-adjacent selections apart', () => {
    const ids = new Set([words[0]?.id as string, words[3]?.id as string]);
    expect(selectionRanges(words, ids, 0)).toHaveLength(2);
  });

  it('selects by id, not by position — the panel filters its list', () => {
    // Only the second word is selected; the range must be the SECOND word's,
    // even though it is the only entry in the set.
    const ranges = selectionRanges(words, new Set([words[1]?.id as string]));
    expect(ranges[0]?.start).toBeCloseTo(words[1]?.start as number, 9);
  });

  it('is empty when nothing is selected', () => {
    expect(selectionRanges(words, new Set())).toEqual([]);
  });
});

describe('mapTimeAfterDeletions', () => {
  const ranges = [{ start: 2, end: 3 }, { start: 6, end: 8 }];

  it('leaves a time before every cut alone', () => {
    expect(mapTimeAfterDeletions(1, ranges)).toBe(1);
  });

  it('pulls a time after a cut back by the length removed', () => {
    expect(mapTimeAfterDeletions(4, ranges)).toBe(3);
    expect(mapTimeAfterDeletions(9, ranges)).toBe(6);
  });

  it('collapses a time inside a cut onto the seam', () => {
    // Monotonicity is the property that matters: 2.0, 2.5 and 3.0 must not
    // come out in a different order than they went in.
    expect(mapTimeAfterDeletions(2.5, ranges)).toBe(2);
    expect(mapTimeAfterDeletions(3, ranges)).toBe(2);
  });

  it('is monotone across the whole range', () => {
    let prev = -1;
    for (let t = 0; t <= 10; t += 0.25) {
      const mapped = mapTimeAfterDeletions(t, ranges);
      expect(mapped).toBeGreaterThanOrEqual(prev);
      prev = mapped;
    }
  });

  it('agrees with deletedDuration past the last cut', () => {
    expect(mapTimeAfterDeletions(10, ranges)).toBe(10 - deletedDuration(ranges));
  });
});

describe('isDeleted', () => {
  it('is true strictly inside a cut and false on its edges', () => {
    const ranges = [{ start: 1, end: 2 }];
    expect(isDeleted(1.5, ranges)).toBe(true);
    expect(isDeleted(1, ranges)).toBe(false);
    expect(isDeleted(2, ranges)).toBe(false);
  });
});

describe('subtractRanges', () => {
  it('splits a clip that straddles a cut into two pieces', () => {
    expect(subtractRanges({ start: 0, end: 10 }, [{ start: 4, end: 6 }]))
      .toEqual([{ start: 0, end: 4 }, { start: 6, end: 10 }]);
  });

  it('removes a clip that is entirely inside the cut', () => {
    expect(subtractRanges({ start: 5, end: 6 }, [{ start: 4, end: 8 }])).toEqual([]);
  });

  it('trims a clip the cut only overlaps at one end', () => {
    expect(subtractRanges({ start: 0, end: 5 }, [{ start: 4, end: 8 }]))
      .toEqual([{ start: 0, end: 4 }]);
  });

  it('leaves a clip outside every cut untouched', () => {
    expect(subtractRanges({ start: 10, end: 12 }, [{ start: 0, end: 5 }]))
      .toEqual([{ start: 10, end: 12 }]);
  });

  it('handles two cuts inside one clip', () => {
    expect(subtractRanges({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 6, end: 7 }]))
      .toEqual([{ start: 0, end: 2 }, { start: 3, end: 6 }, { start: 7, end: 10 }]);
  });

  it('does not split at a boundary that touches the clip edge', () => {
    // A cut that begins exactly where the clip ends must not produce a
    // zero-length piece — that is the stub that shows up as a one-frame flash.
    expect(subtractRanges({ start: 0, end: 4 }, [{ start: 4, end: 6 }]))
      .toEqual([{ start: 0, end: 4 }]);
  });
});

describe('remainingClips', () => {
  it('closes the gap a deletion leaves', () => {
    const clips = [{ start: 0, end: 10 }];
    expect(remainingClips(clips, [{ start: 4, end: 6 }]))
      .toEqual([{ start: 0, end: 4 }, { start: 4, end: 8 }]);
  });

  it('pulls a later, untouched clip back by the length removed', () => {
    const clips = [{ start: 0, end: 3 }, { start: 10, end: 12 }];
    expect(remainingClips(clips, [{ start: 4, end: 6 }]))
      .toEqual([{ start: 0, end: 3 }, { start: 8, end: 10 }]);
  });

  it('drops a fragment too short to be a shot', () => {
    // The cut leaves half a frame of the first clip; that is a flash.
    const clips = [{ start: 0, end: 5 }];
    const ranges = [{ start: MIN_PIECE_SECONDS / 2, end: 5 }];
    expect(remainingClips(clips, ranges)).toEqual([]);
  });

  it('keeps the total length honest — sum of pieces = original minus cuts', () => {
    const clips = [{ start: 0, end: 4 }, { start: 4, end: 9 }];
    const ranges = [{ start: 3, end: 5 }];
    const total = remainingClips(clips, ranges)
      .reduce((sum, c) => sum + (c.end - c.start), 0);
    expect(total).toBeCloseTo(9 - deletedDuration(ranges), 9);
  });

  it('returns the clips unchanged when nothing is deleted', () => {
    const clips = [{ start: 1, end: 2 }];
    expect(remainingClips(clips, [])).toEqual(clips);
  });
});

describe('applyDeletionsToWords', () => {
  const words = wordsFromCues([cue(0, 4, 'one two three four')]);

  it('removes the selected words and shifts the rest left', () => {
    const ids = new Set([words[1]?.id as string]);
    const ranges = selectionRanges(words, ids);
    const after = applyDeletionsToWords(words, ranges);
    expect(after.map((w) => w.text)).toEqual(['one', 'three', 'four']);
    // "three" now starts where "two" used to.
    expect(after[1]?.start).toBeCloseTo(words[1]?.start as number, 9);
    // And the last word ends a whole deleted duration earlier.
    expect(after[2]?.end).toBeCloseTo((words[3]?.end as number) - deletedDuration(ranges), 9);
  });

  it('keeps a word the cut only clips the edge of', () => {
    // A quarter of "two" is removed; it is still audible and still readable.
    const w = words[1] as TranscriptWord;
    const nibble = [{ start: w.end - (w.end - w.start) / 4, end: w.end }];
    expect(applyDeletionsToWords(words, nibble).map((x) => x.text))
      .toEqual(['one', 'two', 'three', 'four']);
  });

  it('is a no-op with no ranges', () => {
    expect(applyDeletionsToWords(words, [])).toEqual(words);
  });

  it('survives a second deletion applied to the already-edited transcript', () => {
    const first = applyDeletionsToWords(words, selectionRanges(words, new Set([words[0]?.id as string])));
    const second = applyDeletionsToWords(
      first,
      selectionRanges(first, new Set([first[0]?.id as string])),
    );
    expect(second.map((w) => w.text)).toEqual(['three', 'four']);
    expect(second[0]?.start).toBe(0);
  });
});

describe('idsBetween', () => {
  const words = wordsFromCues([cue(0, 4, 'one two three four')]);

  it('returns the inclusive run between two chips', () => {
    expect(idsBetween(words, words[1]?.id as string, words[3]?.id as string))
      .toEqual([words[1]?.id, words[2]?.id, words[3]?.id]);
  });

  it('works when the shift-click went backwards', () => {
    expect(idsBetween(words, words[3]?.id as string, words[1]?.id as string))
      .toEqual([words[1]?.id, words[2]?.id, words[3]?.id]);
  });

  it('is empty when an id is not in the list', () => {
    expect(idsBetween(words, 'nope', words[0]?.id as string)).toEqual([]);
  });
});

describe('wordAtTime', () => {
  const words = wordsFromCues([cue(1, 3, 'hello world')]);

  it('finds the word the playhead is inside', () => {
    expect(wordAtTime(words, 1.01)?.text).toBe('hello');
    expect(wordAtTime(words, 2.99)?.text).toBe('world');
  });

  it('is null before the first word and after the last', () => {
    expect(wordAtTime(words, 0.5)).toBeNull();
    expect(wordAtTime(words, 3.5)).toBeNull();
  });
});

describe('normalizeWordText', () => {
  it('strips the punctuation that clings to a word', () => {
    expect(normalizeWordText('“Um,”')).toBe('um');
    expect(normalizeWordText('uh...')).toBe('uh');
  });

  it('keeps interior punctuation that is part of the word', () => {
    expect(normalizeWordText("Don't")).toBe("don't");
    expect(normalizeWordText('well-known')).toBe('well-known');
  });
});

describe('findFillerWordIds', () => {
  it('finds the obvious ones, punctuation and case included', () => {
    const words = wordsFromCues([cue(0, 5, 'So, um, this is, uh, the thing')]);
    const ids = new Set(findFillerWordIds(words));
    const selected = words.filter((w) => ids.has(w.id)).map((w) => normalizeWordText(w.text));
    expect(selected).toEqual(['um', 'uh']);
  });

  it('matches a two-word filler as one unit', () => {
    const words = wordsFromCues([cue(0, 5, 'it was you know quite good')]);
    const ids = new Set(findFillerWordIds(words, ['you know']));
    expect(words.filter((w) => ids.has(w.id)).map((w) => w.text)).toEqual(['you', 'know']);
  });

  it('does not select "know" on its own when the phrase is "you know"', () => {
    const words = wordsFromCues([cue(0, 5, 'I know that')]);
    expect(findFillerWordIds(words, ['you know'])).toEqual([]);
  });

  it('leaves "so" and "right" alone by default', () => {
    // Both are real words at the start of a sentence. A helper that cuts them
    // silently is a helper the user stops trusting.
    const words = wordsFromCues([cue(0, 5, 'So that is right')]);
    expect(findFillerWordIds(words)).toEqual([]);
    expect(DEFAULT_FILLER_WORDS).not.toContain('so');
    expect(DEFAULT_FILLER_WORDS).not.toContain('right');
  });

  it('honours an emptied list rather than falling back to the defaults', () => {
    const words = wordsFromCues([cue(0, 2, 'um uh')]);
    expect(findFillerWordIds(words, [])).toEqual([]);
  });
});

describe('parseFillerList', () => {
  it('accepts commas and newlines, normalises and de-duplicates', () => {
    expect(parseFillerList('Um, uh\nUM\n you know ')).toEqual(['um', 'uh', 'you know']);
  });

  it('is empty for whitespace', () => {
    expect(parseFillerList('  ,\n ')).toEqual([]);
  });
});

describe('wordMatchesQuery', () => {
  const w = word('a', 0, 1, 'Hello,');

  it('matches case-insensitively, punctuation and all', () => {
    expect(wordMatchesQuery(w, 'hello')).toBe(true);
    expect(wordMatchesQuery(w, 'HEL')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(wordMatchesQuery(w, '   ')).toBe(true);
  });

  it('does not match an unrelated word', () => {
    expect(wordMatchesQuery(w, 'world')).toBe(false);
  });
});
