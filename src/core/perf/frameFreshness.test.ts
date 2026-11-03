import { DROPPED_HOLD_MS, FrameFreshness, STALE_AFTER_MS } from './frameFreshness';

describe('FrameFreshness (the viewer stale / dropped cue)', () => {
  it('a seek whose frame lands inside the grace never shows stale', () => {
    const f = new FrameFreshness();
    f.shown(10, 5, 0, 0);
    f.want(10, 5, 0);
    expect(f.stale(1000)).toBe(false);
    f.want(20, 5, 1000);
    expect(f.stale(1000 + STALE_AFTER_MS - 1)).toBe(false);
    f.shown(20, 5, 0, 1050);
    expect(f.stale(5000)).toBe(false);
    expect(f.nextChangeIn(5000)).toBeNull();
  });

  it('a frame that trails the playhead past the grace is stale until it lands', () => {
    const f = new FrameFreshness();
    f.shown(10, 5, 0, 0);
    f.want(30, 5, 100);
    expect(f.nextChangeIn(100)).toBe(STALE_AFTER_MS);
    expect(f.stale(100 + STALE_AFTER_MS)).toBe(true);
    // A scrub keeps moving: still the same wait, still stale.
    f.want(31, 5, 300);
    f.shown(30, 5, 0, 320);
    expect(f.stale(330)).toBe(true);
    f.shown(31, 5, 0, 400);
    expect(f.stale(400)).toBe(false);
  });

  it('an edit is stale until a frame of its revision is drawn', () => {
    const f = new FrameFreshness();
    f.shown(10, 5, 0, 0);
    f.want(10, 6, 0);
    expect(f.stale(STALE_AFTER_MS)).toBe(true);
    f.shown(10, 6, 0, 200);
    expect(f.stale(200)).toBe(false);
    // An older revision reported later does not lower what is wanted.
    f.want(10, 4, 300);
    expect(f.stale(1000)).toBe(false);
  });

  it('nothing is stale while playing, or before the first frame, or with no playhead', () => {
    const f = new FrameFreshness();
    f.want(30, 5, 0);
    expect(f.stale(1000)).toBe(false);  // no frame yet: the waiting line says so
    f.shown(10, 5, 0, 1000);
    f.setPlaying(true, 1000);
    expect(f.stale(5000)).toBe(false);
    f.setPlaying(false, 5000);
    f.want(-1, 5, 5000);
    expect(f.stale(9000)).toBe(false);
  });

  it('playing: drops show for the hold after the last skip, summed inside it', () => {
    const f = new FrameFreshness();
    f.shown(0, 1, 0, 0);
    f.shown(3, 1, 2, 10);  // paused: a skip is not a playback drop
    expect(f.dropped(10)).toBe(0);
    f.setPlaying(true, 100);
    f.shown(4, 1, 0, 120);
    expect(f.dropped(120)).toBe(0);
    f.shown(7, 1, 2, 200);
    expect(f.dropped(200)).toBe(2);
    f.shown(10, 1, 1, 300);
    expect(f.dropped(300)).toBe(3);
    expect(f.nextChangeIn(300)).toBe(DROPPED_HOLD_MS);
    expect(f.dropped(300 + DROPPED_HOLD_MS)).toBe(0);
    // The next skip after the hold counts afresh.
    f.shown(20, 1, 4, 2000);
    expect(f.dropped(2000)).toBe(4);
    f.setPlaying(false, 2100);
    expect(f.dropped(2100)).toBe(0);
  });

  it('a document reset lets the revisions start over', () => {
    const f = new FrameFreshness();
    f.shown(0, 50, 0, 0);
    f.want(0, 50, 0);
    f.reset(10);
    f.want(0, 2, 10);
    f.shown(0, 2, 0, 20);
    expect(f.stale(1000)).toBe(false);
  });
});
