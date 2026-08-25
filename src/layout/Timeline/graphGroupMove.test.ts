import { planGraphGroupTimes, applyGroupValueDelta, type GraphGroupMemberStart } from './graphGroupMove';

const members: GraphGroupMemberStart[] = [
  { nodeId: 'a', prop: 'x', startT: 1, startCompT: 1, startValue: 10, minV: 0, maxV: 100 },
  { nodeId: 'a', prop: 'y', startT: 1.5, startCompT: 1.5, startValue: 20, minV: 0, maxV: 100 },
];

describe('planGraphGroupTimes', () => {
  it('moves the whole body by the grabbed diamond’s delta', () => {
    const plan = planGraphGroupTimes({
      members,
      grabIndex: 0,
      rawGrabCompT: 2, // +1s
      duration: 10,
      pixelsPerSecond: 100,
      frameDuration: 1 / 30,
      playheadTime: 9,
      otherCompTimes: [],
      disableSnap: true,
    });
    expect(plan.compTimes[0]).toBeCloseTo(2, 5);
    expect(plan.compTimes[1]).toBeCloseTo(2.5, 5);
    expect(plan.delta).toBeCloseTo(1, 5);
  });

  it('snaps the group as one body to the playhead', () => {
    const plan = planGraphGroupTimes({
      members: [
        { nodeId: 'a', prop: 'x', startT: 2.03, startCompT: 2.03, startValue: 0, minV: 0, maxV: 1 },
        { nodeId: 'a', prop: 'y', startT: 2.53, startCompT: 2.53, startValue: 0, minV: 0, maxV: 1 },
      ],
      grabIndex: 0,
      rawGrabCompT: 2.03, // no free drag — still near playhead via snap of body
      duration: 10,
      pixelsPerSecond: 100,
      frameDuration: 1 / 30,
      playheadTime: 2,
      otherCompTimes: [],
      disableSnap: false,
    });
    // First key near 2.03 → group snaps so first lands on playhead 2.
    expect(plan.compTimes[0]).toBeCloseTo(2, 2);
    expect(plan.compTimes[1]! - plan.compTimes[0]!).toBeCloseTo(0.5, 2);
  });
});

describe('applyGroupValueDelta', () => {
  it('shifts every member by the grabbed value delta and clamps per curve', () => {
    const grab = members[0]!;
    expect(applyGroupValueDelta(members[1]!, grab, 25)).toBe(35); // +15
    expect(applyGroupValueDelta(members[1]!, grab, 200)).toBe(100); // clamped
  });
});
