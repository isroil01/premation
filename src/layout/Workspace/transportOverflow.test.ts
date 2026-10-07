/**
 * The demote ladder's contract.
 *
 * The measuring half of this (`useTransportDemote`) is a ResizeObserver loop
 * and cannot be exercised in jsdom, which reports every element as 0×0 — so
 * every group would read as overflowing and the test would only prove that
 * zero is less than one. What IS testable is the ORDER, which is the part with
 * a design decision in it: which control the row gives up first, and that
 * `isDemoted` walks that order one step at a time rather than in a clump.
 */

import {
  DISPLAY_DEMOTE_ORDER,
  TRANSPORT_DEMOTE_ORDER,
  TRANSPORT_GROUP_ORDER,
  MAX_DEMOTE_LEVEL,
  displayLevelFor,
  isDemoted,
} from './transportOverflow';

describe('the transport bar demote order', () => {
  it('gives up the display controls first, then loop / auto-key, and the zoom field last', () => {
    // The display controls are the least-often-changed things in the row and
    // every one is already a menu; they lead, right to left. (Split / Trim and
    // Add Marker are no longer buttons here — AE's Composition panel has
    // none.) The zoom field goes last because it is the only group that
    // leaves without a menu entry.
    expect([...TRANSPORT_DEMOTE_ORDER.slice(0, DISPLAY_DEMOTE_ORDER.length)]).toEqual([...DISPLAY_DEMOTE_ORDER]);
    expect([...TRANSPORT_DEMOTE_ORDER.slice(DISPLAY_DEMOTE_ORDER.length)]).toEqual([...TRANSPORT_GROUP_ORDER]);
    expect(TRANSPORT_GROUP_ORDER[0]).toBe('loopMarker');
    expect(TRANSPORT_DEMOTE_ORDER[TRANSPORT_DEMOTE_ORDER.length - 1]).toBe('zoom');
  });

  it('keeps the whole row at level 0', () => {
    for (const group of TRANSPORT_DEMOTE_ORDER) {
      expect(isDemoted(group, 0)).toBe(false);
    }
    expect(displayLevelFor(0)).toBe(0);
  });

  it('sheds exactly one more rung per level', () => {
    for (let level = 0; level <= MAX_DEMOTE_LEVEL; level++) {
      const shed = TRANSPORT_DEMOTE_ORDER.filter((g) => isDemoted(g, level));
      expect(shed).toEqual(TRANSPORT_DEMOTE_ORDER.slice(0, level));
    }
  });

  it('reads the display controls\' own level out of the bar\'s, capped at their ten', () => {
    for (let level = 0; level <= DISPLAY_DEMOTE_ORDER.length; level++) {
      expect(displayLevelFor(level)).toBe(level);
    }
    expect(displayLevelFor(DISPLAY_DEMOTE_ORDER.length + 1)).toBe(DISPLAY_DEMOTE_ORDER.length);
    expect(displayLevelFor(MAX_DEMOTE_LEVEL)).toBe(DISPLAY_DEMOTE_ORDER.length);
    // The bar's own first group goes only once every display control has.
    expect(isDemoted('loopMarker', DISPLAY_DEMOTE_ORDER.length)).toBe(false);
    expect(isDemoted('loopMarker', DISPLAY_DEMOTE_ORDER.length + 1)).toBe(true);
  });

  it('has shed everything at the top of the ladder', () => {
    for (const group of TRANSPORT_DEMOTE_ORDER) {
      expect(isDemoted(group, MAX_DEMOTE_LEVEL)).toBe(true);
    }
  });

  it('never un-sheds a group at a higher level', () => {
    // Monotonic: a group that has gone at level n must still be gone at n+1,
    // or widening the window by a pixel could swap two controls' places.
    for (const group of TRANSPORT_DEMOTE_ORDER) {
      let seenShed = false;
      for (let level = 0; level <= MAX_DEMOTE_LEVEL; level++) {
        const shed = isDemoted(group, level);
        if (seenShed) expect(shed).toBe(true);
        seenShed ||= shed;
      }
    }
  });
});
