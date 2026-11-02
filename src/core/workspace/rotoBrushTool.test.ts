/**
 * The prompt set a subject's frame accumulates across clicks (rotoBrushTool
 * cumulativePrompts): a Shift-click asks the model with every earlier prompt,
 * an Alt-click with its own click alone and is remembered as a negative.
 */

import { cumulativePrompts } from './rotoBrushTool';

const p = (x: number, y: number) => ({ x, y });
const box = { x0: 0, y0: 0, x1: 100, y1: 100, time: 1 };

describe('cumulativePrompts', () => {
  it('a plain click starts the frame over', () => {
    const prev = { clicks: [p(1, 1)], negatives: [p(9, 9)], box };
    const r = cumulativePrompts(prev, { tool: 'segment', op: 'replace', clicks: [p(5, 5)] });
    expect(r.send).toEqual({ clicks: [p(5, 5)], negatives: [], box: null });
    expect(r.keep).toEqual({ clicks: [p(5, 5)], negatives: [], box: null });
  });

  it('a Shift-click sends every earlier prompt with the new one, and the box the selection started from', () => {
    const first = cumulativePrompts(undefined, { tool: 'segment', op: 'replace', box });
    expect(first.keep?.box).toBe(box);
    const r = cumulativePrompts(first.keep ?? undefined, { tool: 'segment', op: 'add', clicks: [p(5, 5)] });
    expect(r.send).toEqual({ clicks: [p(5, 5)], negatives: [], box });
    const r2 = cumulativePrompts(r.keep ?? undefined, { tool: 'segment', op: 'add', clicks: [p(7, 7)] });
    expect(r2.send.clicks).toEqual([p(5, 5), p(7, 7)]);
    expect(r2.keep).toEqual(r2.send);
  });

  it('an Alt-click sends its own click alone and is remembered as a negative', () => {
    const prev = { clicks: [p(1, 1), p(2, 2)], negatives: [], box: null };
    const r = cumulativePrompts(prev, { tool: 'segment', op: 'subtract', clicks: [p(5, 5)] });
    expect(r.send).toEqual({ clicks: [p(5, 5)], negatives: [], box: null });
    expect(r.keep).toEqual({ clicks: [p(1, 1), p(2, 2)], negatives: [p(5, 5)], box: null });
    // The next add keeps it out.
    const r2 = cumulativePrompts(r.keep ?? undefined, { tool: 'segment', op: 'add', clicks: [p(3, 3)] });
    expect(r2.send.negatives).toEqual([p(5, 5)]);
    expect(r2.send.clicks).toEqual([p(1, 1), p(2, 2), p(3, 3)]);
  });

  it('a brush or Refine Edge sends its own strokes and remembers nothing new', () => {
    const prev = { clicks: [p(1, 1)], negatives: [], box: null };
    const r = cumulativePrompts(prev, { tool: 'paint', op: 'add', strokes: [[p(1, 1), p(2, 2)]] });
    expect(r.send.clicks).toEqual([]);
    expect(r.keep).toBe(prev);
  });
});
