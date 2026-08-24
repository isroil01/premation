/**
 * The frame pipeline: bounded concurrency, back-pressure, and no silent holes.
 */

import { FramePipeline, defaultConcurrency } from './framePipeline';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('defaultConcurrency', () => {
  it('is cores − 1, clamped to 2..6', () => {
    expect(defaultConcurrency(1)).toBe(2);
    expect(defaultConcurrency(4)).toBe(3);
    expect(defaultConcurrency(32)).toBe(6);
  });
});

describe('FramePipeline', () => {
  it('admits up to the limit without waiting, then applies back-pressure', async () => {
    const p = new FramePipeline({ concurrency: 2 });
    const resolvers: Array<() => void> = [];
    const job = () => new Promise<void>((r) => resolvers.push(r));
    await p.push(job);
    await p.push(job);
    expect(p.pending).toBe(2);
    let third = false;
    const pushing = p.push(job).then(() => { third = true; });
    await tick();
    expect(third).toBe(false);          // blocked: the queue is full
    resolvers[0]!();
    await pushing;
    expect(third).toBe(true);           // admitted once one finished
    expect(p.pending).toBe(2);
    resolvers[1]!(); resolvers[2]!();
    await p.drain();
    expect(p.pending).toBe(0);
  });

  it('lets the producer run ahead: k encodes overlap, the render never waits on one', async () => {
    const p = new FramePipeline({ concurrency: 3 });
    let maxOverlap = 0, running = 0;
    const job = () => new Promise<void>((r) => {
      running++; maxOverlap = Math.max(maxOverlap, running);
      setTimeout(() => { running--; r(); }, 5);
    });
    for (let i = 0; i < 9; i++) await p.push(job);
    await p.drain();
    expect(maxOverlap).toBe(3);
  });

  it('holds the first failure and rethrows it on the next push and on drain', async () => {
    const p = new FramePipeline({ concurrency: 4 });
    await p.push(async () => { throw new Error('disk full'); });
    await tick();
    await expect(p.push(async () => {})).rejects.toThrow('disk full');
    await expect(p.drain()).rejects.toThrow('disk full');
  });

  it('close waits and then refuses pushes, without throwing the held failure', async () => {
    const p = new FramePipeline({ concurrency: 2 });
    await p.push(async () => { throw new Error('x'); });
    await p.close();
    await expect(p.push(async () => {})).rejects.toThrow('closed');
  });
});
