/**
 * The capability scan is what every SVG import decision and every user-facing
 * warning is derived from. If it under-reports, we silently misrender: a file
 * whose animation we dropped, or whose text will reflow on someone else's
 * machine, looks completely fine on screen. So the interesting assertions here
 * are the NEGATIVE ones — that a feature present in the file is never missed.
 */

import { scanSvgMarkup, isAnimatedSvg, svgCapabilityWarnings, parseClockValue } from './svgCapabilities';

const wrap = (inner: string, attrs = 'viewBox="0 0 100 100"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;

describe('parseClockValue', () => {
  it.each([
    ['2s', 2],
    ['500ms', 0.5],
    ['1.5', 1.5],
    ['2min', 120],
    ['00:03', 3],
    ['01:00:00', 3600],
  ])('parses %s', (raw, expected) => {
    expect(parseClockValue(raw)).toBeCloseTo(expected);
  });

  it('returns null for indefinite and garbage', () => {
    expect(parseClockValue('indefinite')).toBeNull();
    expect(parseClockValue('click')).toBeNull();
    expect(parseClockValue(null)).toBeNull();
  });
});

describe('scanSvgCapabilities', () => {
  it('reports a plain static file as inert', () => {
    const caps = scanSvgMarkup(wrap('<rect width="10" height="10" fill="red"/>'));
    expect(isAnimatedSvg(caps)).toBe(false);
    expect(caps.hasScript).toBe(false);
    expect(caps.hasText).toBe(false);
    expect(caps.pathCount).toBe(1);
  });

  it('detects every SMIL element type', () => {
    for (const tag of ['animate', 'animateTransform', 'animateMotion', 'set']) {
      const caps = scanSvgMarkup(wrap(`<rect><${tag} dur="1s"/></rect>`));
      expect(caps.hasSMIL).toBe(true);
      expect(isAnimatedSvg(caps)).toBe(true);
    }
  });

  it('detects CSS animation in a <style> block and in an inline style', () => {
    const viaStyle = scanSvgMarkup(
      wrap('<style>@keyframes spin { to { transform: rotate(360deg) } } .p { animation: spin 1s }</style><path class="p" d="M0 0"/>'),
    );
    expect(viaStyle.hasCSSAnimation).toBe(true);

    const viaInline = scanSvgMarkup(wrap('<path d="M0 0" style="animation: spin 1s linear infinite"/>'));
    expect(viaInline.hasCSSAnimation).toBe(true);
  });

  it('flags scripts, both as an element and as an on* handler', () => {
    expect(scanSvgMarkup(wrap('<script>alert(1)</script>')).hasScript).toBe(true);
    expect(scanSvgMarkup(wrap('<rect onload="alert(1)"/>')).hasScript).toBe(true);
    expect(scanSvgMarkup(wrap('<a href="javascript:alert(1)"><rect/></a>')).hasScript).toBe(true);
  });

  it('flags foreignObject, text and embedded raster', () => {
    expect(scanSvgMarkup(wrap('<foreignObject><div/></foreignObject>')).hasForeignObject).toBe(true);
    expect(scanSvgMarkup(wrap('<text x="0" y="0">hi</text>')).hasText).toBe(true);
    expect(scanSvgMarkup(wrap('<image href="a.png"/>')).hasRasterImage).toBe(true);
  });

  it('flags remote references but not local or relative ones', () => {
    expect(scanSvgMarkup(wrap('<image href="https://evil.example/x.png"/>')).hasExternalRefs).toBe(true);
    expect(scanSvgMarkup(wrap('<use href="//cdn.example/s.svg#i"/>')).hasExternalRefs).toBe(true);
    expect(scanSvgMarkup(wrap('<use href="#local"/>')).hasExternalRefs).toBe(false);
    expect(scanSvgMarkup(wrap('<rect fill="url(#grad)"/>')).hasExternalRefs).toBe(false);
  });

  it('flags event-driven timing, which cannot be scrubbed reproducibly', () => {
    const caps = scanSvgMarkup(wrap('<rect><animate begin="click" dur="1s"/></rect>'));
    expect(caps.hasEventTiming).toBe(true);
    // …and a plain clock start is NOT mistaken for one.
    expect(scanSvgMarkup(wrap('<rect><animate begin="0.5s" dur="1s"/></rect>')).hasEventTiming).toBe(false);
  });

  describe('intrinsicDuration', () => {
    it('is the latest end time across all animations', () => {
      const caps = scanSvgMarkup(
        wrap('<rect><animate dur="1s"/></rect><rect><animate begin="2s" dur="3s"/></rect>'),
      );
      expect(caps.intrinsicDuration).toBeCloseTo(5);
    });

    it('accounts for repeatCount', () => {
      expect(scanSvgMarkup(wrap('<rect><animate dur="2s" repeatCount="3"/></rect>')).intrinsicDuration)
        .toBeCloseTo(6);
    });

    it('is unknown — not a guess — when any animation repeats indefinitely', () => {
      // Inventing a number here would silently truncate the user's loop.
      const caps = scanSvgMarkup(
        wrap('<rect><animate dur="1s"/></rect><rect><animate dur="1s" repeatCount="indefinite"/></rect>'),
      );
      expect(caps.intrinsicDuration).toBeNull();
    });

    it('is null when there is no SMIL at all', () => {
      expect(scanSvgMarkup(wrap('<rect/>')).intrinsicDuration).toBeNull();
    });
  });

  it('survives unparseable markup without throwing', () => {
    const caps = scanSvgMarkup('<svg><rect');
    expect(caps.pathCount).toBe(0);
  });
});

describe('svgCapabilityWarnings', () => {
  it('says something for each user-visible loss, and nothing for a clean file', () => {
    expect(svgCapabilityWarnings(scanSvgMarkup(wrap('<rect/>')))).toEqual([]);

    const dirty = scanSvgMarkup(wrap('<script/><text>a</text><image href="https://x.example/a.png"/>'));
    const warnings = svgCapabilityWarnings(dirty);
    expect(warnings.join(' ')).toMatch(/script/i);
    expect(warnings.join(' ')).toMatch(/text/i);
    expect(warnings.join(' ')).toMatch(/remote/i);
  });
});
