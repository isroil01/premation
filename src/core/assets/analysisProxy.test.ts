/**
 * The ANALYSIS tier: a stand-in nobody ever sees.
 *
 * Two things have to hold, and only one of them is about speed.
 *
 * The tier must be unreachable by omission. `resolveMediaSrc` defaults to
 * `'original'`, so an output path gets full resolution by saying nothing —
 * exactly the polarity the viewport proxy already relied on, preserved rather
 * than widened. Adding a third tier is the moment that could have been lost.
 *
 * And a request for one tier must never be answered with another's pixels in a
 * direction that shows. Analysis MAY fall through to the viewport proxy (it
 * cares about decode cost and a 1920px stand-in beats a 3840px one); the
 * viewport must NOT fall through to the analysis one, which is 540p and would
 * look like the quality bug the proxy badge exists to prevent.
 */

import {
  resolveMediaSrc,
  servedProxy,
  isProxyInUse,
  analysisResolution,
  analysisEncodeArgs,
  proxyResolution,
  ANALYSIS_TARGET_LONG_EDGE,
  type ProxyResolvable,
  type ProxyTier,
} from './proxy';

const ORIGINAL = 'blob:original';
const VIEWPORT = 'blob:viewport-1920';
const ANALYSIS = 'blob:analysis-960';

const ready = (src: string, w: number, h: number) =>
  ({ status: 'ready' as const, src, width: w, height: h });

const full: ProxyResolvable = {
  src: ORIGINAL,
  proxy: ready(VIEWPORT, 1920, 1080),
  analysisProxy: ready(ANALYSIS, 960, 540),
};

describe('the tier is unreachable by omission', () => {
  it('resolves the original when no tier is named', () => {
    expect(resolveMediaSrc(full)).toBe(ORIGINAL);
  });

  it('resolves the original when the tier is named explicitly', () => {
    expect(resolveMediaSrc(full, 'original')).toBe(ORIGINAL);
  });

  it('reaches each stand-in only when asked for it by name', () => {
    expect(resolveMediaSrc(full, 'viewport')).toBe(VIEWPORT);
    expect(resolveMediaSrc(full, 'analysis')).toBe(ANALYSIS);
  });

  it('never serves the analysis file to a viewport request', () => {
    // 540p on screen is the quality bug the badge exists to warn about, and
    // nothing badges a tier the user cannot see.
    const analysisOnly: ProxyResolvable = { src: ORIGINAL, analysisProxy: ready(ANALYSIS, 960, 540) };
    expect(resolveMediaSrc(analysisOnly, 'viewport')).toBe(ORIGINAL);
    expect(isProxyInUse(analysisOnly, 'viewport')).toBe(false);
  });
});

describe('the analysis fallback ladder', () => {
  it('falls to the viewport proxy when there is no analysis one', () => {
    const a: ProxyResolvable = { src: ORIGINAL, proxy: ready(VIEWPORT, 1920, 1080) };
    expect(resolveMediaSrc(a, 'analysis')).toBe(VIEWPORT);
    expect(servedProxy(a, 'analysis')?.width).toBe(1920);
  });

  it('falls to the original when there is neither', () => {
    const a: ProxyResolvable = { src: ORIGINAL };
    expect(resolveMediaSrc(a, 'analysis')).toBe(ORIGINAL);
    expect(servedProxy(a, 'analysis')).toBeUndefined();
  });

  it('falls through every non-ready state rather than handing over a bad src', () => {
    for (const bad of [
      { status: 'generating' as const },
      { status: 'failed' as const, error: 'ffmpeg exited 1' },
      { status: 'ready' as const },          // ready with no src
      { status: 'ready' as const, src: '' },
    ]) {
      const a: ProxyResolvable = { src: ORIGINAL, analysisProxy: bad };
      expect(resolveMediaSrc(a, 'analysis')).toBe(ORIGINAL);
    }
  });

  it('keeps the two records independent — one failing says nothing about the other', () => {
    const a: ProxyResolvable = {
      src: ORIGINAL,
      proxy: { status: 'failed', error: 'x' },
      analysisProxy: ready(ANALYSIS, 960, 540),
    };
    expect(resolveMediaSrc(a, 'analysis')).toBe(ANALYSIS);
    expect(resolveMediaSrc(a, 'viewport')).toBe(ORIGINAL);
  });

  it('agrees with itself: servedProxy names whatever resolveMediaSrc served', () => {
    const cases: ProxyResolvable[] = [
      full,
      { src: ORIGINAL, proxy: ready(VIEWPORT, 1920, 1080) },
      { src: ORIGINAL, analysisProxy: ready(ANALYSIS, 960, 540) },
      { src: ORIGINAL },
    ];
    for (const a of cases) {
      for (const tier of ['original', 'viewport', 'analysis'] as ProxyTier[]) {
        const url = resolveMediaSrc(a, tier);
        const rec = servedProxy(a, tier);
        // A caller that scales its measurements by the served record's size
        // must be looking at the file it actually decoded.
        expect(rec ? rec.src : ORIGINAL).toBe(url);
      }
    }
  });
});

describe('the analysis resolution rule', () => {
  it('halves to the 540p-class target', () => {
    expect(analysisResolution(3840, 2160)).toEqual({ width: 960, height: 540 });
    expect(analysisResolution(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(analysisResolution(1280, 720)).toEqual({ width: 640, height: 360 });
  });

  it('is never larger than the viewport proxy', () => {
    for (const [w, h] of [[3840, 2160], [1920, 1080], [4096, 2160], [7680, 4320]] as [number, number][]) {
      const view = proxyResolution(w, h)!;
      const analysis = analysisResolution(w, h)!;
      expect(Math.max(analysis.width, analysis.height))
        .toBeLessThanOrEqual(Math.max(view.width, view.height));
    }
  });

  it('is strictly smaller wherever the source is above the viewport target', () => {
    // The two rules meet at 1920: both halve it to 960 and neither is wrong to.
    // Above that the analysis target keeps halving and the viewport one stops,
    // which is the whole point of a second tier.
    for (const [w, h] of [[3840, 2160], [4096, 2160], [7680, 4320]] as [number, number][]) {
      const view = proxyResolution(w, h)!;
      const analysis = analysisResolution(w, h)!;
      expect(Math.max(analysis.width, analysis.height))
        .toBeLessThan(Math.max(view.width, view.height));
    }
    // And at 1920 they agree — a 1080p source needs one size, not two. The GOP
    // still differs, which is what an analysis walk was short of.
    expect(analysisResolution(1920, 1080)).toEqual(proxyResolution(1920, 1080));
  });

  it('rounds to even, because both encoders fail outright on odd', () => {
    for (const [w, h] of [[2048, 858], [1999, 1001], [3841, 2161]] as [number, number][]) {
      const r = analysisResolution(w, h)!;
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });

  it('declines a source already at or under the target', () => {
    expect(analysisResolution(960, 540)).toBeNull();
    expect(analysisResolution(640, 360)).toBeNull();
  });

  it('refuses nonsense rather than emitting a size ffmpeg would reject', () => {
    expect(analysisResolution(0, 100)).toBeNull();
    expect(analysisResolution(NaN, 100)).toBeNull();
    expect(analysisResolution(-4000, 2000)).toBeNull();
  });

  it('never lands above the target', () => {
    for (let w = ANALYSIS_TARGET_LONG_EDGE + 1; w <= 8000; w += 137) {
      const r = analysisResolution(w, Math.round(w * 9 / 16));
      if (r) expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(ANALYSIS_TARGET_LONG_EDGE + 1);
    }
  });
});

describe('the analysis encode', () => {
  const args = analysisEncodeArgs('IN', 'OUT', { width: 960, height: 540 });

  it('carries no timing flags, so frame N of the proxy IS frame N of the source', () => {
    // The property the whole tier rests on: a tracker treats a proxy as a
    // resolution change and nothing else, so any sample it measures lands on
    // the comp frame it was measured at.
    for (const forbidden of ['-ss', '-t', '-r']) expect(args).not.toContain(forbidden);
  });

  it('uses a shorter GOP than the viewport proxy — analysis walks seek', () => {
    expect(args[args.indexOf('-g') + 1]).toBe('6');
  });

  it('keeps a planar YUV format, which is what makes luma extraction free', () => {
    // `lumaExtract` reads plane 0 directly for I420; a non-planar format would
    // drop it onto the canvas-readback path and cost more than the downscale
    // saved.
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
  });

  it('drops audio', () => {
    expect(args).toContain('-an');
  });
});
