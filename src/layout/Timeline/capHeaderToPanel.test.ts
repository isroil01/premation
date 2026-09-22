import { capHeaderToPanel, headerWidthFor, resolveTrackHeaderWidth, TRACK_HEADER_MIN_WIDTH, TIMELINE_MIN_LANES_PX } from './timelineShared';

/**
 * The header column must never take the whole panel. On a laptop the docked
 * timeline is ~855px and the 'both' column set wants ~897px, which left the
 * lanes zero pixels: no ruler, no bars, no playhead.
 */
describe('capHeaderToPanel', () => {
  it('leaves the lanes room on a laptop-width panel', () => {
    const header = resolveTrackHeaderWidth(undefined, null, 'both', 0, 855);
    expect(header).toBeLessThan(headerWidthFor('both'));
    expect(855 - header).toBeGreaterThanOrEqual(TIMELINE_MIN_LANES_PX);
  });

  it('does not touch a header that already fits', () => {
    expect(capHeaderToPanel(600, 1800)).toBe(600);
  });

  it('caps a dragged preference too — a stored width must not bury the lanes on a smaller screen', () => {
    expect(855 - resolveTrackHeaderWidth(undefined, 900, 'both', 0, 855)).toBeGreaterThanOrEqual(TIMELINE_MIN_LANES_PX);
  });

  it('never goes under the readable minimum, however narrow the panel', () => {
    expect(capHeaderToPanel(897, 400)).toBe(TRACK_HEADER_MIN_WIDTH);
  });

  it('is inert before the panel is measured, and for a pinned width', () => {
    expect(capHeaderToPanel(897, 0)).toBe(897);
    expect(resolveTrackHeaderWidth(500, null, 'both', 0, 300)).toBe(500);
  });
});
