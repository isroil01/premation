import { secondsToFlicks, type LayerInfo } from '@motion/engine-api';
import { mirrorRollLimits } from './rollLimits';

const FPS = 30;
const fr = (n: number): number => secondsToFlicks(n / FPS);

function bar(inF: number, outF: number, sourceInF: number, sourceDurF?: number, locked = false): Pick<LayerInfo, 'timing' | 'switches'> {
  return {
    timing: {
      inPoint: fr(inF), outPoint: fr(outF), startTime: fr(inF - sourceInF), stretch: 1, timeRemapEnabled: false, retime: 'normal',
      ...(sourceDurF !== undefined ? { sourceDuration: fr(sourceDurF) } : {}),
    } as LayerInfo['timing'],
    switches: { locked } as LayerInfo['switches'],
  };
}

describe('mirrorRollLimits (the twin of rollLimits)', () => {
  it('is bounded by the left tail handle and the right head handle', () => {
    // Left: frames 0–30 of a 50-frame source from source 5 → 15 frames of tail.
    // Right: frames 30–60 from source 10 of a 100-frame source → 10 frames of head.
    const l = bar(0, 30, 5, 50);
    const r = bar(30, 60, 10, 100);
    expect(mirrorRollLimits(l, r, FPS)).toEqual({ min: -10, max: 15 });
  });

  it('an unbounded source is limited only by the other bar keeping a frame', () => {
    expect(mirrorRollLimits(bar(0, 30, 0), bar(30, 40, 0), FPS)).toEqual({ min: -29, max: 9 });
  });

  it('a locked layer pins the cut', () => {
    expect(mirrorRollLimits(bar(0, 30, 0, 100, true), bar(30, 60, 0, 100), FPS)).toEqual({ min: 0, max: 0 });
  });
});
