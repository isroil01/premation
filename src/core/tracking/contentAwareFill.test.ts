import { flicksToSeconds } from '@motion/engine-api';
import { contentAwareFillJob, contentAwareFillSummaryText, type ContentAwareFillRequest } from './contentAwareFill';
import { useContentAwareFillStore } from '@stores/contentAwareFillStore';

const base: ContentAwareFillRequest = {
  layer: 'L1', start: 1, end: 3, fps: 25, mode: 'surface', lighting: 'moderate', expansion: 4,
  references: [{ time: 2, src: '/tmp/plate.png' }],
};

describe('content-aware fill request', () => {
  it('carries the panel choices into the engine job', () => {
    const job = contentAwareFillJob(base);
    expect(job.kind).toBe('contentAwareFill');
    if (job.kind !== 'contentAwareFill') throw new Error('kind');
    const v = job.value;
    expect(v.layer).toBe('L1');
    expect(flicksToSeconds(v.range.start)).toBeCloseTo(1);
    expect(flicksToSeconds(v.range.duration)).toBeCloseTo(2);
    expect(v.mode).toBe('surface');
    expect(v.lighting).toBe('moderate');
    expect(v.expansion).toBe(4);
    expect(v.references).toHaveLength(1);
    expect(flicksToSeconds(v.references[0]!.time)).toBeCloseTo(2);
    expect(v.createReference).toBe(false);
    expect(v.outputFolder).toBe('');
  });

  it('a reference request covers one frame; an empty range still covers one', () => {
    const ref = contentAwareFillJob({ ...base, createReference: true });
    if (ref.kind !== 'contentAwareFill') throw new Error('kind');
    expect(flicksToSeconds(ref.value.range.duration)).toBeCloseTo(1 / 25);
    expect(ref.value.createReference).toBe(true);
    const empty = contentAwareFillJob({ ...base, end: 1 });
    if (empty.kind !== 'contentAwareFill') throw new Error('kind');
    expect(flicksToSeconds(empty.value.range.duration)).toBeCloseTo(1 / 25);
    const bad = contentAwareFillJob({ ...base, expansion: Number.NaN });
    if (bad.kind !== 'contentAwareFill') throw new Error('kind');
    expect(bad.value.expansion).toBe(0);
  });

  it('summarises what filled the hole', () => {
    expect(contentAwareFillSummaryText({ frames: 0 }, false)).toMatch(/draw a mask/);
    expect(contentAwareFillSummaryText({ frames: 3, propagated: 10, synthesized: 5 }, false))
      .toBe('Filled 3 frames (10 px carried through time, 5 px synthesised).');
    expect(contentAwareFillSummaryText({ files: ['/x/reference_00010.png'] }, true)).toMatch(/reference_00010\.png/);
    expect(contentAwareFillSummaryText(null, true)).toMatch(/no mask/);
  });
});

describe('content-aware fill panel settings', () => {
  it('keeps one reference per frame, sorted, per layer', () => {
    const s = useContentAwareFillStore.getState();
    s.addReference('L', { time: 2, src: 'b.png' });
    s.addReference('L', { time: 1, src: 'a.png' });
    s.addReference('L', { time: 2, src: 'c.png' });
    expect(useContentAwareFillStore.getState().references.L).toEqual([{ time: 1, src: 'a.png' }, { time: 2, src: 'c.png' }]);
    s.removeReference('L', 1);
    expect(useContentAwareFillStore.getState().references.L).toEqual([{ time: 2, src: 'c.png' }]);
    s.setExpansion(500);
    expect(useContentAwareFillStore.getState().expansion).toBe(100);
  });
});
