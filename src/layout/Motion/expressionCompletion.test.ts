/**
 * The expression completion, without a DOM.
 *
 * WHY THIS FILE EXISTS. Everything a completion gets wrong is arithmetic on a
 * string: which characters are the word, which range the accepted item
 * replaces, where the caret lands afterwards. All of it is invisible in a
 * component test — jsdom will happily report the right rendered rows while the
 * insertion mangles the source — so the arithmetic is pinned here and the
 * component test is left to prove the wiring.
 *
 * The cases below are the ones that were actually wrong in the chip strip this
 * replaces: `wig` + `wiggle()` produced `wigwiggle(2, 30)`, because inserting
 * at the caret is not the same as completing the word at it.
 */

import {
  wordAtCaret,
  completions,
  applyCompletion,
  completionsAt,
  MAX_COMPLETIONS,
  type ApiItem,
} from './expressionCompletion';
import { EXPRESSION_API } from '@motion/animation';

/** A tiny stand-in, so ranking assertions do not move when the language grows. */
const API: ApiItem[] = [
  { insert: 'time', label: 'time', hint: 'playhead seconds' },
  { insert: 'value', label: 'value', hint: 'the keyframed value' },
  { insert: 'wiggle(2, 30)', label: 'wiggle()', hint: 'smooth random motion' },
  { insert: 'ease(time, 0, 1, 0, 100)', label: 'ease()', hint: 'smooth S-curve' },
  { insert: 'easeIn(time, 0, 1, 0, 100)', label: 'easeIn()', hint: 'smooth start' },
  { insert: 'nearestKey(time).time', label: 'nearestKey()', hint: 'keyframe closest to a time' },
  { insert: 'gaussRandom()', label: 'gaussRandom()', hint: 'normal distribution' },
  { insert: 'Math.sin(time * 2) * 100', label: 'Math.sin()', hint: 'oscillate' },
];

const labels = (prefix: string, ctx = {}): string[] =>
  completions(prefix, API, ctx).map((c) => c.label);

describe('wordAtCaret', () => {
  test('the identifier immediately left of the caret', () => {
    expect(wordAtCaret('wig', 3)).toMatchObject({ word: 'wig', start: 0, end: 3, object: '', member: 'wig' });
  });

  test('reads back only to the first non-identifier character', () => {
    const w = wordAtCaret('value + wig', 11);
    expect(w.word).toBe('wig');
    expect(w.start).toBe(8);
  });

  test('a dotted access splits at the LAST dot', () => {
    expect(wordAtCaret('thisLayer.tr', 12)).toMatchObject({
      word: 'thisLayer.tr', object: 'thisLayer', member: 'tr', start: 0,
    });
  });

  test('a trailing dot is an object with an empty member — the "show me its members" case', () => {
    expect(wordAtCaret('thisComp.', 9)).toMatchObject({ object: 'thisComp', member: '' });
  });

  test('the caret mid-word takes only what is to its LEFT', () => {
    // Completing on what follows the caret would replace text the user did not
    // ask about, which is the one destructive thing a completion can do.
    expect(wordAtCaret('wiggle', 3).word).toBe('wig');
  });

  test('numbers are not identifiers', () => {
    // `wiggle(2, 3` and `time - 0.5` must not open a list: the run of word
    // characters left of the caret is a literal, and `.` being part of it is
    // exactly what makes the naive scan wrong.
    expect(wordAtCaret('wiggle(2, 3', 11).word).toBe('');
    expect(wordAtCaret('time - 0.5', 10).word).toBe('');
    expect(wordAtCaret('time - 0.5', 9).word).toBe('');
  });

  test('nothing at all left of the caret', () => {
    expect(wordAtCaret('', 0).word).toBe('');
    expect(wordAtCaret('value + ', 8).word).toBe('');
  });

  test('a caret past the end is clamped rather than throwing', () => {
    expect(wordAtCaret('time', 999)).toMatchObject({ word: 'time', end: 4 });
  });
});

describe('completions — ranking', () => {
  test('a prefix match beats a substring match', () => {
    // `ea` is a prefix of ease/easeIn and a substring of nearestKey. Substring
    // -only ranking puts nearestKey first, which is the wrong answer to `ea`.
    const got = labels('ea');
    expect(got.indexOf('ease()')).toBeLessThan(got.indexOf('nearestKey()'));
    expect(got[0]).toBe('ease()');
  });

  test('the shorter name wins between two equal prefix matches', () => {
    // `nearestKey` trails as a subsequence match (e-a-s-e is in it, in order)
    // — that is the fuzzy tier doing its job, and it must stay BELOW both.
    expect(labels('ease').slice(0, 2)).toEqual(['ease()', 'easeIn()']);
  });

  test('case-insensitive prefixes still match, ranked under exact case', () => {
    expect(labels('EAS')).toContain('ease()');
  });

  test('a subsequence matches when nothing better does', () => {
    // g-s-r appears in order inside `gaussRandom`, nowhere as a substring.
    expect(labels('gsr')).toEqual(['gaussRandom()']);
  });

  test('no match at all returns nothing — an empty list closes the popup', () => {
    expect(labels('zzzz')).toEqual([]);
  });

  test('an empty prefix offers everything (the trailing-dot / Ctrl+Space case)', () => {
    expect(completions('', API).length).toBe(API.length);
  });

  test('the list is capped', () => {
    expect(completions('', EXPRESSION_API).length).toBe(MAX_COMPLETIONS);
    expect(completions('e', EXPRESSION_API, { limit: 3 }).length).toBe(3);
  });

  test('every item carries hint and signature text', () => {
    const [first] = completions('wig', API);
    expect(first).toMatchObject({
      label: 'wiggle()',
      hint: 'smooth random motion',
      signature: 'wiggle(2, 30)',
      match: 'prefix',
    });
  });
});

describe('completions — members after a dot', () => {
  test('a modelled object offers ONLY its own members', () => {
    const got = labels('', { object: 'thisComp' });
    expect(got).toContain('thisComp.width');
    expect(got).not.toContain('wiggle()');
  });

  test('the member prefix matches the part AFTER the dot', () => {
    expect(labels('wid', { object: 'thisComp' })).toEqual(['thisComp.width']);
  });

  test('members declared by the shared API table are merged in, not duplicated', () => {
    // `Math.sin()` is in EXPRESSION_API as a dotted label; the curated table
    // names it too. One row, not two.
    const got = labels('sin', { object: 'Math' });
    expect(got[0]).toBe('Math.sin()');
    expect(got.filter((l) => l === 'Math.sin()')).toHaveLength(1);
  });

  test('an UNMODELLED object falls back to the whole API', () => {
    // `foo` is not ours. Offering nothing would be a dead popup on every
    // property access we do not happen to model.
    expect(labels('wig', { object: 'foo' })).toEqual(['wiggle()']);
  });
});

describe('applyCompletion', () => {
  test('replaces the half-typed word rather than inserting beside it', () => {
    // The chip strip's bug, verbatim: it produced `wigwiggle(2, 30)`.
    expect(applyCompletion('wig', 3, { insert: 'wiggle(2, 30)' })).toEqual({
      text: 'wiggle(2, 30)', caret: 13,
    });
  });

  test('keeps the text either side of the word', () => {
    const out = applyCompletion('value + wig * 2', 11, { insert: 'wiggle(2, 30)' });
    expect(out.text).toBe('value + wiggle(2, 30) * 2');
    expect(out.caret).toBe(21);
  });

  test('an empty-parens insert leaves the caret BETWEEN the parens', () => {
    const out = applyCompletion('gau', 3, { insert: 'gaussRandom()' });
    expect(out.text).toBe('gaussRandom()');
    expect(out.caret).toBe(12);
    expect(out.text.slice(0, out.caret)).toBe('gaussRandom(');
  });

  test('a filled example leaves the caret after it, not inside', () => {
    expect(applyCompletion('wig', 3, { insert: 'wiggle(2, 30)' }).caret).toBe(13);
  });

  test('an item that spells the object replaces the whole dotted run', () => {
    expect(applyCompletion('thisComp.wi', 11, { insert: 'thisComp.width' }).text)
      .toBe('thisComp.width');
  });

  test('an item that does NOT spell the object keeps what was typed before the dot', () => {
    // The fallback case: `foo` is the user's own value and must survive.
    expect(applyCompletion('foo.wig', 7, { insert: 'wiggle(2, 30)' }).text)
      .toBe('foo.wiggle(2, 30)');
  });

  test('with no word at the caret it simply inserts', () => {
    expect(applyCompletion('value + ', 8, { insert: 'time' })).toEqual({
      text: 'value + time', caret: 12,
    });
  });

  test('completing on a second line edits only that line', () => {
    const src = 'value +\nwig';
    expect(applyCompletion(src, 11, { insert: 'wiggle(2, 30)' }).text).toBe('value +\nwiggle(2, 30)');
  });
});

describe('completionsAt — what the editor calls', () => {
  test('gives back the word and its ranked items together', () => {
    const { word, items } = completionsAt('value + wig', 11, API);
    expect(word.start).toBe(8);
    expect(items[0]?.label).toBe('wiggle()');
  });

  test('no word means no items, so the popup never opens on punctuation', () => {
    expect(completionsAt('value + ', 8, API).items).toEqual([]);
  });

  test('round-trips against the real API table', () => {
    const { items } = completionsAt('loop', 4, EXPRESSION_API);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['loopOut()', 'loopIn()']));
    const applied = applyCompletion('loop', 4, items[0]!);
    expect(applied.text.startsWith('loop')).toBe(true);
  });
});
