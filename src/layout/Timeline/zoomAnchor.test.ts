import {
  clampPps,
  TIMELINE_PPS_MAX,
  TIMELINE_PPS_MIN,
  zoomAroundPlayhead,
  zoomAroundPointer,
  zoomAroundTime,
  zoomStep,
} from './zoomAnchor';

/** Where a time lands on screen, given a zoom and a scroll. */
const screenX = (time: number, pps: number, scrollLeft: number, leftOffset = 0): number =>
  time * pps + leftOffset - scrollLeft;

describe('clampPps', () => {
  it('holds the bounds', () => {
    expect(clampPps(1)).toBe(TIMELINE_PPS_MIN);
    expect(clampPps(1e9)).toBe(TIMELINE_PPS_MAX);
    expect(clampPps(200)).toBe(200);
  });
  it('survives a non-finite zoom', () => {
    expect(clampPps(NaN)).toBe(TIMELINE_PPS_MIN);
  });
});

describe('zoomStep', () => {
  it('zooms in on a negative deltaY', () => {
    expect(zoomStep(100, -1)).toBeGreaterThan(100);
  });
  it('zooms out on a positive deltaY', () => {
    expect(zoomStep(100, 1)).toBeLessThan(100);
  });
  it('is symmetric — in then out returns to the start', () => {
    expect(zoomStep(zoomStep(100, -1), 1)).toBeCloseTo(100, 9);
  });
  it('clamps at the ceiling', () => {
    expect(zoomStep(TIMELINE_PPS_MAX, -1)).toBe(TIMELINE_PPS_MAX);
  });
  it('reaches a zoom where a millisecond is visible', () => {
    // The point of raising the ceiling: sub-frame keyframe work.
    expect(TIMELINE_PPS_MAX / 1000).toBeGreaterThanOrEqual(2);
  });
});

describe('zoomAroundTime', () => {
  it('holds the anchored time exactly where it was', () => {
    const before = { pps: 100, scrollLeft: 500, leftOffset: 8 };
    const time = 20;
    const viewportX = screenX(time, before.pps, before.scrollLeft, before.leftOffset);
    const after = zoomAroundTime({ pps: before.pps, nextPps: 400, time, viewportX, leftOffset: 8 });
    expect(screenX(time, after.pixelsPerSecond, after.scrollLeft, 8)).toBeCloseTo(viewportX, 9);
  });

  it('never returns a negative scroll', () => {
    const after = zoomAroundTime({ pps: 100, nextPps: 10, time: 0.1, viewportX: 600 });
    expect(after.scrollLeft).toBe(0);
  });

  it('clamps the zoom it is handed', () => {
    expect(zoomAroundTime({ pps: 100, nextPps: 1e9, time: 1, viewportX: 0 }).pixelsPerSecond)
      .toBe(TIMELINE_PPS_MAX);
  });
});

describe('zoomAroundPointer', () => {
  const LANE_LEFT = 240;
  const LEFT_OFFSET = 8;

  it('keeps the time under the pointer under the pointer', () => {
    const pps = 120;
    const scrollLeft = 900;
    const pointerX = LANE_LEFT + 350;
    const timeUnderPointer = (pointerX - LANE_LEFT + scrollLeft - LEFT_OFFSET) / pps;

    const after = zoomAroundPointer({
      pps,
      nextPps: 480,
      pointerX,
      laneLeft: LANE_LEFT,
      scrollLeft,
      leftOffset: LEFT_OFFSET,
    });

    const x = screenX(timeUnderPointer, after.pixelsPerSecond, after.scrollLeft, LEFT_OFFSET);
    expect(x).toBeCloseTo(pointerX - LANE_LEFT, 9);
  });

  it('holds through a round trip of in-then-out', () => {
    const pointerX = LANE_LEFT + 420;
    const start = { pps: 100, scrollLeft: 1200 };
    const t = (pointerX - LANE_LEFT + start.scrollLeft - LEFT_OFFSET) / start.pps;

    let state = start;
    for (const dy of [-1, -1, -1, 1, 1, 1]) {
      const next = zoomAroundPointer({
        pps: state.pps,
        nextPps: zoomStep(state.pps, dy),
        pointerX,
        laneLeft: LANE_LEFT,
        scrollLeft: state.scrollLeft,
        leftOffset: LEFT_OFFSET,
      });
      state = { pps: next.pixelsPerSecond, scrollLeft: next.scrollLeft };
    }
    expect(state.pps).toBeCloseTo(start.pps, 6);
    expect(screenX(t, state.pps, state.scrollLeft, LEFT_OFFSET)).toBeCloseTo(pointerX - LANE_LEFT, 6);
  });

  it('does not throw the anchor away at a zero zoom', () => {
    const after = zoomAroundPointer({
      pps: 0,
      nextPps: 100,
      pointerX: LANE_LEFT + 10,
      laneLeft: LANE_LEFT,
      scrollLeft: 0,
    });
    expect(Number.isFinite(after.scrollLeft)).toBe(true);
  });

  it('is the old behaviour at the very start of the comp', () => {
    // t=0 under the pointer with no scroll: the anchor is already at 0, so
    // the scroll stays at 0 — this is the ONE case the unanchored zoom got right.
    const after = zoomAroundPointer({
      pps: 100,
      nextPps: 200,
      pointerX: LANE_LEFT + 8,
      laneLeft: LANE_LEFT,
      scrollLeft: 0,
      leftOffset: LEFT_OFFSET,
    });
    expect(after.scrollLeft).toBe(0);
  });
});

describe('zoomAroundPlayhead', () => {
  const LEFT_OFFSET = 8;

  it('holds the playhead when it is on screen', () => {
    const pps = 100;
    const scrollLeft = 400;
    const playheadTime = 6;
    const before = screenX(playheadTime, pps, scrollLeft, LEFT_OFFSET);
    expect(before).toBeGreaterThanOrEqual(0);

    const after = zoomAroundPlayhead({
      pps,
      nextPps: 300,
      playheadTime,
      scrollLeft,
      viewportWidth: 800,
      leftOffset: LEFT_OFFSET,
    });
    expect(screenX(playheadTime, after.pixelsPerSecond, after.scrollLeft, LEFT_OFFSET))
      .toBeCloseTo(before, 9);
  });

  it('falls back to the viewport centre when the playhead is off screen', () => {
    const pps = 100;
    const scrollLeft = 4000;
    const viewportWidth = 800;
    const centreTime = (viewportWidth / 2 + scrollLeft - LEFT_OFFSET) / pps;

    const after = zoomAroundPlayhead({
      pps,
      nextPps: 200,
      playheadTime: 0, // far to the left of the view
      scrollLeft,
      viewportWidth,
      leftOffset: LEFT_OFFSET,
    });
    expect(screenX(centreTime, after.pixelsPerSecond, after.scrollLeft, LEFT_OFFSET))
      .toBeCloseTo(viewportWidth / 2, 9);
  });
});
