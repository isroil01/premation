import {
  resolveTrackSelection,
  selectIntentFor,
  spanBetween,
  type TrackSelectIntent,
} from './trackRangeSelect';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

function click(
  clicked: string,
  intent: TrackSelectIntent,
  selected: string[] = [],
  anchor: string | null = null,
) {
  return resolveTrackSelection({ order: ORDER, selected, anchor, clicked, intent });
}

describe('selectIntentFor', () => {
  it('maps the four modifier combinations', () => {
    expect(selectIntentFor({ shift: false, meta: false })).toBe('replace');
    expect(selectIntentFor({ shift: false, meta: true })).toBe('toggle');
    expect(selectIntentFor({ shift: true, meta: false })).toBe('range');
    expect(selectIntentFor({ shift: true, meta: true })).toBe('range-add');
  });
});

describe('spanBetween', () => {
  it('runs in either direction, inclusive', () => {
    expect(spanBetween(ORDER, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(spanBetween(ORDER, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });
  it('is a single row when both ends are the same', () => {
    expect(spanBetween(ORDER, 'c', 'c')).toEqual(['c']);
  });
});

describe('resolveTrackSelection', () => {
  it('replaces on a plain click and anchors there', () => {
    const r = click('c', 'replace', ['a', 'b']);
    expect(r.ids).toEqual(['c']);
    expect(r.anchor).toBe('c');
  });

  it('toggles one row without disturbing the rest', () => {
    expect(click('c', 'toggle', ['a', 'e']).ids).toEqual(['a', 'c', 'e']);
    expect(click('a', 'toggle', ['a', 'c']).ids).toEqual(['c']);
  });

  it('selects the span from the anchor', () => {
    const r = click('d', 'range', ['b'], 'b');
    expect(r.ids).toEqual(['b', 'c', 'd']);
  });

  it('spans upward too', () => {
    expect(click('a', 'range', ['d'], 'd').ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the anchor across a range click, so the span can be re-aimed', () => {
    // The point of not moving the anchor: shift-click d, then shift-click c,
    // and the span SHRINKS to b..c instead of becoming c..c.
    const first = click('d', 'range', ['b'], 'b');
    expect(first.anchor).toBe('b');
    const second = resolveTrackSelection({
      order: ORDER,
      selected: first.ids,
      anchor: first.anchor,
      clicked: 'c',
      intent: 'range',
    });
    expect(second.ids).toEqual(['b', 'c']);
  });

  it('replaces the selection on a plain range click', () => {
    expect(click('c', 'range', ['e'], 'b').ids).toEqual(['b', 'c']);
  });

  it('unions the span into the selection on range-add', () => {
    const r = click('c', 'range-add', ['e'], 'b');
    expect(r.ids).toEqual(['b', 'c', 'e']);
  });

  it('degrades a range click with no anchor to a plain replace', () => {
    const r = click('c', 'range', ['a']);
    expect(r.ids).toEqual(['c']);
    expect(r.anchor).toBe('c');
  });

  it('degrades when the anchor row has gone away', () => {
    // The anchored row was deleted or scrolled out of the flattened rows.
    expect(click('c', 'range', ['a'], 'zz').ids).toEqual(['c']);
  });

  it('returns results in display order, not click order', () => {
    expect(click('a', 'toggle', ['e', 'c']).ids).toEqual(['a', 'c', 'e']);
  });

  it('keeps selected ids that are not in the visible row order', () => {
    // A selected layer inside a collapsed group is still selected; a click on
    // a different row must not silently drop it.
    const r = resolveTrackSelection({
      order: ORDER,
      selected: ['hidden', 'a'],
      anchor: 'a',
      clicked: 'c',
      intent: 'toggle',
    });
    expect(r.ids).toContain('hidden');
  });

  it('flags a no-op click so the caller can skip the store write', () => {
    expect(click('c', 'replace', ['c']).unchanged).toBe(true);
    expect(click('c', 'replace', ['a']).unchanged).toBe(false);
    expect(click('d', 'range', ['b', 'c', 'd'], 'b').unchanged).toBe(true);
  });
});
