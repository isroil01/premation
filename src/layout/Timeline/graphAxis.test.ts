import { smoothFrameSteps, timeStep, timeTicks, valueTicks } from './graphAxis';

describe('smoothFrameSteps', () => {
  const frame = 1 / 10;

  it('puts each tread at the middle, which is its frame', () => {
    const steps: Array<[number, number]> = [[0.06, 1], [0.1, 1], [0.14, 1], [0.16, 2], [0.2, 2], [0.24, 2]];
    const out = smoothFrameSteps(steps, frame);
    expect(out.map(([, v]) => v)).toEqual([1, 2]);
    expect(out[0]![0]).toBeCloseTo(0.1);
    expect(out[1]![0]).toBeCloseTo(0.2);
  });

  it('keeps a real plateau flat, corners and all', () => {
    expect(smoothFrameSteps([[0, 5], [0.5, 5], [1, 5], [1.05, 6]], frame)).toEqual([[0, 5], [1, 5], [1.05, 6]]);
  });

  it('leaves samples sparser than a frame alone', () => {
    const sparse: Array<[number, number]> = [[0, 1], [0.5, 2], [1, 3]];
    expect(smoothFrameSteps(sparse, frame)).toEqual(sparse);
  });

  it('copes with nothing', () => {
    expect(smoothFrameSteps([], frame)).toEqual([]);
  });
});

describe('graph axis ticks', () => {
  it('lands on round values', () => {
    expect(valueTicks(95, 128, 200)).toEqual([100, 110, 120]);
  });

  it('drops float noise', () => {
    expect(valueTicks(0, 0.3, 200)).toContain(0.3);
  });

  it('thins out on a short graph', () => {
    expect(valueTicks(0, 100, 90).length).toBeLessThan(valueTicks(0, 100, 400).length);
  });

  it('has nothing to say about an empty or broken range', () => {
    expect(valueTicks(5, 5, 200)).toEqual([]);
    expect(valueTicks(0, Infinity, 200)).toEqual([]);
    expect(valueTicks(0, 1, 0)).toEqual([]);
  });

  it('spreads time lines to suit the zoom', () => {
    expect(timeStep(40)).toBe(2);
    expect(timeStep(100)).toBe(1);
    expect(timeStep(800)).toBe(0.1);
    expect(timeStep(0.001)).toBe(3600);
  });

  it('lists the multiples in the window', () => {
    expect(timeTicks(1, 6.5, 2)).toEqual([2, 4, 6]);
    expect(timeTicks(0, 0.3, 0.1)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});
