import { computeBoxZoomFromSvg } from './graphBoxZoom';

describe('computeBoxZoomFromSvg', () => {
  const base = { viewportW: 400, minPps: 4, maxPps: 800, currentPps: 100 };

  it('zooms so the dragged span fills the viewport', () => {
    // 2s of timeline at 100 pps = 200 px → should become 400/2 = 200 pps
    const r = computeBoxZoomFromSvg({ ...base, x0: 100, x1: 300 });
    expect(r).not.toBeNull();
    expect(r!.pps).toBe(200);
    expect(r!.t0).toBe(1);
    expect(r!.t1).toBe(3);
    expect(r!.scrollLeft).toBe(200); // 1s * 200 pps
  });

  it('is order-independent on the box corners', () => {
    const a = computeBoxZoomFromSvg({ ...base, x0: 300, x1: 100 });
    const b = computeBoxZoomFromSvg({ ...base, x0: 100, x1: 300 });
    expect(a).toEqual(b);
  });

  it('rejects tiny accidental Alt-clicks', () => {
    expect(computeBoxZoomFromSvg({ ...base, x0: 50, x1: 54 })).toBeNull();
  });

  it('clamps to maxPps when the span is very short', () => {
    // 0.1s → would want 4000 pps, clamped to 800
    const r = computeBoxZoomFromSvg({ ...base, x0: 0, x1: 10 }); // 0.1s
    expect(r!.pps).toBe(800);
    expect(r!.scrollLeft).toBe(0);
  });

  it('clamps to minPps when the span is huge', () => {
    const r = computeBoxZoomFromSvg({
      ...base,
      currentPps: 10,
      x0: 0,
      x1: 5000, // 500s → 400/500 = 0.8 → clamp to 4
    });
    expect(r!.pps).toBe(4);
  });
});
