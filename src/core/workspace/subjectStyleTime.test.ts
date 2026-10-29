import { flicksToSeconds, type Keyframe } from '@motion/engine-api';
import { readStyleSpan, styleSpanKeys } from './subjectStyleTime';

const FPS = 30;
const at = (keys: Keyframe[]): Array<[number, number, string]> =>
  keys.map((k) => [Math.round(flicksToSeconds(k.time) * FPS), k.value.kind === 'scalar' ? k.value.value : NaN, k.easing]);

describe('a subject style over part of the shot', () => {
  it('a hard span: off until its first frame, on through its last, off after', () => {
    const keys = styleSpanKeys({ start: 2, end: 5, fade: 0 }, FPS);
    expect(at(keys)).toEqual([[59, 0, 'hold'], [60, 100, 'hold'], [151, 0, 'hold']]);
    expect(readStyleSpan(keys, FPS)).toEqual({ start: 2, end: 5, fade: 0 });
  });

  it('a span from the first frame needs no key before it', () => {
    const keys = styleSpanKeys({ start: 0, end: 1, fade: 0 }, FPS);
    expect(at(keys)).toEqual([[0, 100, 'hold'], [31, 0, 'hold']]);
    expect(readStyleSpan(keys, FPS)).toEqual({ start: 0, end: 1, fade: 0 });
  });

  it('a faded span is fully on over the span and ramps either side', () => {
    const keys = styleSpanKeys({ start: 2, end: 4, fade: 0.5 }, FPS);
    expect(at(keys)).toEqual([[45, 0, 'linear'], [60, 100, 'linear'], [120, 100, 'linear'], [135, 0, 'linear']]);
    const back = readStyleSpan(keys, FPS)!;
    expect(back.start).toBeCloseTo(2);
    expect(back.end).toBeCloseTo(4);
    expect(back.fade).toBeCloseTo(0.5);
  });

  it('snaps to whole frames and never ends before it starts', () => {
    const keys = styleSpanKeys({ start: 2.01, end: 1, fade: 0 }, FPS);
    expect(at(keys)).toEqual([[59, 0, 'hold'], [60, 100, 'hold'], [61, 0, 'hold']]);
  });

  it('keys of another shape are not a span', () => {
    const keys = styleSpanKeys({ start: 1, end: 2, fade: 0 }, FPS);
    expect(readStyleSpan([{ ...keys[1]!, value: { kind: 'scalar', value: 40 } }, keys[2]!], FPS)).toBeNull();
    expect(readStyleSpan([keys[1]!], FPS)).toBeNull();
    expect(readStyleSpan([], FPS)).toBeNull();
  });
});
