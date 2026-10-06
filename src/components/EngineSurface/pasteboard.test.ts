/**
 * The pasteboard rect: where the comp lands in an engine frame, from the
 * camera the frame was drawn with (the engine's view: CSS size/2 + (p − pan)·zoom).
 */
import { compUvRect, fitUvRect, parseCssRgb } from './pasteboard';

describe('compUvRect', () => {
  it('a fitted 1920×1080 comp in a 574×269 CSS viewport at DPR 2.18 (the real-app numbers)', () => {
    // The auto-fit the page sent: zoom 0.2493, pan = the comp centre.
    const cam = { width: 574, height: 269, zoom: 269 / 1080, panX: 960, panY: 540 };
    const r = compUvRect(cam, 1920, 1080)!;
    const w = 1920 * cam.zoom;
    expect(r.y0).toBeCloseTo(0, 6);
    expect(r.y1).toBeCloseTo(1, 6);
    expect(r.x0).toBeCloseTo((574 - w) / 2 / 574, 6);
    expect(r.x1).toBeCloseTo((574 + w) / 2 / 574, 6);
  });

  it('follows pan and zoom (the comp origin moves with the pan, its size with the zoom)', () => {
    const r = compUvRect({ width: 1000, height: 500, zoom: 0.5, panX: 1062.87, panY: 552.3 }, 1920, 1080)!;
    expect(r.x0 * 1000).toBeCloseTo(500 - 1062.87 * 0.5, 4);
    expect(r.x1 * 1000).toBeCloseTo(500 + (1920 - 1062.87) * 0.5, 4);
    expect(r.y0 * 500).toBeCloseTo(250 - 552.3 * 0.5, 4);
    expect(r.y1 * 500).toBeCloseTo(250 + (1080 - 552.3) * 0.5, 4);
  });

  it('none for a fit camera (zoom 0: the engine frames it), or no comp', () => {
    expect(compUvRect({ width: 800, height: 450, zoom: 0, panX: 0, panY: 0 }, 1920, 1080)).toBeNull();
    expect(compUvRect({ width: 800, height: 450, zoom: 0.4, panX: 960, panY: 540 }, 0, 1080)).toBeNull();
    expect(compUvRect({ width: 0, height: 450, zoom: 0.4, panX: 960, panY: 540 }, 1920, 1080)).toBeNull();
  });
});

describe('parseCssRgb', () => {
  it('reads a computed colour', () => {
    expect(parseCssRgb('rgb(33, 33, 35)')).toEqual([33 / 255, 33 / 255, 35 / 255]);
    expect(parseCssRgb('rgba(32, 32, 32, 1)')).toEqual([32 / 255, 32 / 255, 32 / 255]);
    expect(parseCssRgb('color(srgb 1 0 0)')).toBeNull();
  });
});

describe('fitUvRect', () => {
  it('the engine contain fit (zoom 0): a 16:9 comp in a wider Preview stage is pillarboxed', () => {
    const r = fitUvRect(1600, 800, 1920, 1080)!;
    const w = (1920 * 800) / 1080;
    expect(r.y0).toBeCloseTo(0, 9);
    expect(r.y1).toBeCloseTo(1, 9);
    expect(r.x0).toBeCloseTo((1600 - w) / 2 / 1600, 9);
    expect(r.x1).toBeCloseTo(1 - (1600 - w) / 2 / 1600, 9);
  });

  it('a taller stage letterboxes; a degenerate size has no rect', () => {
    const r = fitUvRect(800, 800, 1920, 1080)!;
    expect(r.x0).toBeCloseTo(0, 9);
    expect(r.y0).toBeCloseTo((1 - 1080 / 1920) / 2, 9);
    expect(fitUvRect(0, 800, 1920, 1080)).toBeNull();
  });
});
