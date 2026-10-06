import { savedTrackerOf, trackerDataOf, type SavedTracker } from './trackerPersistence';

describe('a tracker saved on its layer', () => {
  it('round-trips the panel state through the engine record', () => {
    const s: SavedTracker = {
      mode: 'stabilize',
      points: [{ x: 10, y: 20 }, { x: 40, y: 20 }],
      attach: [{ x: 3, y: -2 }, { x: 0, y: 0 }],
      featureHalf: 8,
      searchHalf: 20,
      result: {
        tracks: [
          [{ compTime: 0, x: 10, y: 20, confidence: 1, coasted: false }, { compTime: 0.04, x: 11, y: 21, confidence: 0.8, coasted: true }],
          [{ compTime: 0, x: 40, y: 20, confidence: 1, coasted: false }, { compTime: 0.04, x: 41, y: 20, confidence: 0.9, coasted: false }],
        ],
        sourceWidth: 640, sourceHeight: 360, status: 'completed',
      },
    };
    const d = trackerDataOf(s);
    expect(d.kind).toBe('positionRotationScale');
    expect(d.points[0]!.feature.width).toBe(17);
    const back = savedTrackerOf(d)!;
    expect(back.mode).toBe('stabilize');
    expect(back.featureHalf).toBe(8);
    expect(back.searchHalf).toBe(20);
    expect(back.attach[0]).toEqual({ x: 3, y: -2 });
    expect(back.result?.tracks[0]?.[1]?.coasted).toBe(true);
    expect(back.result?.tracks[1]?.[1]?.compTime).toBeCloseTo(0.04, 6);
  });

  it('a record without samples restores the setup and no result', () => {
    const d = trackerDataOf({ mode: 'follow', points: [{ x: 1, y: 2 }], attach: [], featureHalf: 10, searchHalf: 24, result: null });
    const back = savedTrackerOf(d)!;
    expect(back.result).toBeNull();
    expect(back.points).toEqual([{ x: 1, y: 2 }]);
    expect(savedTrackerOf({ ...d, mode: 'bogus' })).toBeNull();
  });
});
