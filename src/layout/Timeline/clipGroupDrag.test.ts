import {
  clampGroupDelta,
  groupDragStarts,
  groupDragTargets,
  groupRows,
  type GroupClip,
} from './clipGroupDrag';
import { staggerOffsets } from './staggerOffsets';

const clip = (id: string, trackId: string, start: number, extra: Partial<GroupClip> = {}): GroupClip => ({
  id,
  trackId,
  start,
  duration: 1,
  ...extra,
});

const CLIPS: GroupClip[] = [
  clip('c1', 'A', 0),
  clip('c2', 'B', 1),
  clip('c3', 'C', 2),
  clip('c4', 'D', 3),
];

describe('groupDragTargets', () => {
  it('moves the whole selection when the grabbed bar is in it', () => {
    const t = groupDragTargets(CLIPS, ['A', 'B', 'C'], 'c2');
    expect(t.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('moves only the grabbed bar when it is outside the selection', () => {
    const t = groupDragTargets(CLIPS, ['A', 'B'], 'c4');
    expect(t.map((c) => c.id)).toEqual(['c4']);
  });

  it('carries every bar on a selected row, so a split clip stays split', () => {
    const split = [...CLIPS, clip('c2b', 'B', 5), clip('c2c', 'B', 9)];
    const t = groupDragTargets(split, ['B'], 'c2');
    expect(t.map((c) => c.id)).toEqual(['c2', 'c2b', 'c2c']);
  });

  it('drops locked bars but still moves the rest', () => {
    const withLock = [clip('c1', 'A', 0), clip('c2', 'B', 1, { locked: true }), clip('c3', 'C', 2)];
    expect(groupDragTargets(withLock, ['A', 'B', 'C'], 'c1').map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('refuses a drag that starts on a locked bar outside the selection', () => {
    const withLock = [clip('c1', 'A', 0, { locked: true })];
    expect(groupDragTargets(withLock, ['B'], 'c1')).toEqual([]);
  });

  it('is empty for an unknown bar', () => {
    expect(groupDragTargets(CLIPS, ['A'], 'nope')).toEqual([]);
  });
});

describe('clampGroupDelta', () => {
  it('passes a delta nothing blocks', () => {
    expect(clampGroupDelta(CLIPS, 2)).toBe(2);
  });
  it('stops the group at the earliest bar, not at each bar', () => {
    const targets = [clip('c2', 'B', 1), clip('c3', 'C', 2)];
    expect(clampGroupDelta(targets, -5)).toBe(-1);
  });
  it('honours a non-zero floor', () => {
    expect(clampGroupDelta([clip('c1', 'A', 4)], -10, 1)).toBe(-3);
  });
  it('is a no-op with nothing to move', () => {
    expect(clampGroupDelta([], 3)).toBe(3);
  });
});

describe('groupDragStarts', () => {
  it('moves every bar by the same delta', () => {
    const t = groupDragTargets(CLIPS, ['A', 'B', 'C'], 'c1');
    const starts = groupDragStarts(t, 2);
    expect([...starts.values()]).toEqual([2, 3, 4]);
  });

  it('keeps relative spacing when the group hits the start of the comp', () => {
    // The bug this replaces: a per-bar clamp pins c1 and c2 both to 0.
    const t = groupDragTargets(CLIPS, ['A', 'B', 'C'], 'c1');
    const starts = groupDragStarts(t, -10);
    expect(starts.get('c1')).toBe(0);
    expect(starts.get('c2')).toBe(1);
    expect(starts.get('c3')).toBe(2);
  });

  it('applies a stagger per ROW, not per bar', () => {
    const split = [clip('c1', 'A', 0), clip('c2', 'B', 0), clip('c2b', 'B', 4)];
    const rowOrder = ['A', 'B'];
    const starts = groupDragStarts(split, 0, { rowOffsets: [0, 1], rowOrder });
    expect(starts.get('c1')).toBe(0);
    // Both bars on row B moved by the same 1s — their 4s gap survived.
    expect(starts.get('c2')).toBe(1);
    expect(starts.get('c2b')).toBe(5);
  });

  it('clamps the COMBINED move, so a balanced stagger cannot escape t=0', () => {
    // Balanced offsets send the top rows earlier than the pointer went; the
    // clamp has to see those, not just the pointer delta.
    const targets = [clip('c1', 'A', 0), clip('c2', 'B', 0), clip('c3', 'C', 0)];
    const rowOrder = ['A', 'B', 'C'];
    const offsets = staggerOffsets(3, { mode: 'cascade', step: 1, balance: true });
    expect(offsets[0]).toBeLessThan(0);
    const starts = groupDragStarts(targets, 0, { rowOffsets: offsets, rowOrder });
    for (const t of starts.values()) expect(t).toBeGreaterThanOrEqual(0);
    // Still a cascade — one second between adjacent rows.
    expect(starts.get('c2')! - starts.get('c1')!).toBeCloseTo(1, 9);
    expect(starts.get('c3')! - starts.get('c2')!).toBeCloseTo(1, 9);
  });

  it('quantizes to the frame grid when asked', () => {
    const fd = 1 / 30;
    const starts = groupDragStarts([clip('c1', 'A', 0)], 0.017, { frameDuration: fd });
    expect(starts.get('c1')).toBeCloseTo(fd, 9);
  });

  it('gives a row with no offset entry a zero offset', () => {
    const starts = groupDragStarts([clip('c9', 'Z', 3)], 1, { rowOffsets: [5], rowOrder: ['A'] });
    expect(starts.get('c9')).toBe(4);
  });

  it('is empty with nothing to move', () => {
    expect(groupDragStarts([], 1).size).toBe(0);
  });
});

describe('groupRows', () => {
  it('lists the spanned rows once each, in display order', () => {
    const targets = [clip('c2b', 'B', 4), clip('c1', 'A', 0), clip('c2', 'B', 0)];
    expect(groupRows(targets, ['A', 'B', 'C'])).toEqual(['A', 'B']);
  });
  it('keeps a row the caller did not list', () => {
    expect(groupRows([clip('c1', 'Z', 0)], ['A', 'B'])).toEqual(['Z']);
  });
});
