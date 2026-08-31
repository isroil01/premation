/**
 * Choosing the file an analysis walk decodes.
 *
 * The interesting case is the refusal. Every walk measures in the DECODED grid
 * and reports in the source's DISPLAY grid, converting by `decoded ÷ display` —
 * which is what makes a 960px stand-in free of precision cost. Both walks
 * derived `display` as `sourceDisplaySize(nodeId) ?? decoded size`, and that
 * fallback was harmless for exactly as long as the decoded file WAS the source.
 *
 * Point a walk at a proxy with that fallback live and the ratio collapses to 1:
 * every sample comes back in proxy pixels. A track offset by a factor of four,
 * a stabilizer correcting a quarter of the camera motion, no error and nothing
 * in the numbers that looks wrong on its own. So the rule is that an unknown
 * display grid FORBIDS a stand-in, and that is what these pin.
 */

import { planAnalysisDecode, originalDisplaySize, type AnalysisAsset } from './analysisTier';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';

const ORIGINAL = 'blob:original-4k';
const VIEWPORT = 'blob:viewport-1920';
const ANALYSIS = 'blob:analysis-960';

const ready = (src: string, w: number, h: number) =>
  ({ status: 'ready' as const, src, width: w, height: h });

/** An asset whose ORIGINAL is 4K, with both stand-ins available. */
const asset = (patch: Partial<AnalysisAsset> = {}): AnalysisAsset => ({
  src: ORIGINAL,
  proxy: ready(VIEWPORT, 1920, 1080),
  analysisProxy: ready(ANALYSIS, 960, 540),
  metadata: { width: 3840, height: 2160 },
  ...patch,
});

// No scene graph in this suite, so `sourceDisplaySize` returns null and the
// asset metadata is the grid — which is precisely the path that used to fall
// through to the decoded size.
beforeEach(() => {
  jest.spyOn(defaultSceneGraph, 'getNode').mockReturnValue(undefined as never);
});
afterEach(() => jest.restoreAllMocks());

describe('the grid comes from facts that do not depend on the decode', () => {
  it('uses the asset metadata when the scene has no footage source', () => {
    expect(originalDisplaySize('n1', asset())).toEqual({ width: 3840, height: 2160 });
  });

  it('is null when neither is available', () => {
    expect(originalDisplaySize('n1', asset({ metadata: undefined }))).toBeNull();
    expect(originalDisplaySize('n1', asset({ metadata: { width: 0, height: 0 } }))).toBeNull();
  });

  it('describes the ORIGINAL, never the stand-in that will be decoded', () => {
    // A proxy substitutes pixels and nothing else, so metadata stays valid
    // however far down the tier ladder the decode lands. This is the whole
    // reason the ratio is meaningful.
    const plan = planAnalysisDecode('n1', asset());
    expect(plan.src).toBe(ANALYSIS);
    expect(plan.display).toEqual({ width: 3840, height: 2160 });
    // 960 decoded ÷ 3840 display = the quarter the walk must scale back by.
    expect(960 / plan.display!.width).toBeCloseTo(0.25, 6);
  });
});

describe('an unknown grid forbids a stand-in', () => {
  it('decodes the ORIGINAL when the display size cannot be established', () => {
    // Nothing to scale back to. Slower than it could be beats wrong, which is
    // the same choice every other proxy failure path makes.
    const plan = planAnalysisDecode('n1', asset({ metadata: undefined }));
    expect(plan.src).toBe(ORIGINAL);
    expect(plan.tier).toBe('original');
    expect(plan.display).toBeNull();
  });

  it('refuses even when both stand-ins are ready and would be faster', () => {
    const a = asset({ metadata: { width: 0, height: 0 } });
    const plan = planAnalysisDecode('n1', a);
    expect(plan.src).toBe(ORIGINAL);
    expect(a.analysisProxy?.status).toBe('ready');   // it was available
  });

  it('a null display is ALWAYS paired with the original, never a proxy', () => {
    // The invariant the callers rely on: their `plan.display ?? decodedSize`
    // fallback is only reachable when the decoded size IS the source size.
    for (const meta of [undefined, { width: 0, height: 0 }, { width: 3840 }, { height: 2160 }]) {
      const plan = planAnalysisDecode('n1', asset({ metadata: meta as never }));
      if (plan.display === null) expect(plan.tier).toBe('original');
    }
  });
});

describe('the tier ladder', () => {
  it('prefers the analysis stand-in', () => {
    expect(planAnalysisDecode('n1', asset())).toMatchObject({ src: ANALYSIS, tier: 'analysis' });
  });

  it('falls to the viewport stand-in when there is no analysis one', () => {
    const plan = planAnalysisDecode('n1', asset({ analysisProxy: undefined }));
    expect(plan).toMatchObject({ src: VIEWPORT, tier: 'viewport' });
    // Still reports the ORIGINAL grid, so the ratio is 1920/3840 rather than 1.
    expect(plan.display).toEqual({ width: 3840, height: 2160 });
  });

  it('falls to the original when there is neither', () => {
    const plan = planAnalysisDecode('n1', asset({ proxy: undefined, analysisProxy: undefined }));
    expect(plan).toMatchObject({ src: ORIGINAL, tier: 'original' });
    // And the grid is still known, so the walk reports in it either way.
    expect(plan.display).toEqual({ width: 3840, height: 2160 });
  });

  it('names the tier it actually served, not the one it asked for', () => {
    // Callers scale by the DECODED size; a tier label that disagreed with the
    // file would be worse than none.
    expect(planAnalysisDecode('n1', asset({ analysisProxy: { status: 'generating' } })).tier)
      .toBe('viewport');
    expect(planAnalysisDecode('n1', asset({
      analysisProxy: { status: 'failed', error: 'x' },
      proxy: { status: 'failed', error: 'x' },
    })).tier).toBe('original');
  });
});
