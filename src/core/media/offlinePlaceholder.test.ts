import { offlineBarsRgba, OFFLINE_BARS_W, OFFLINE_BARS_H, mediaUnavailableDetail } from './offlinePlaceholder';

describe('offlineBarsRgba', () => {
  it('is opaque 320×180 RGBA', () => {
    const px = offlineBarsRgba();
    expect(px.length).toBe(OFFLINE_BARS_W * OFFLINE_BARS_H * 4);
    // Corner of first bar: near-white
    expect(px[0]).toBeGreaterThan(180);
    expect(px[3]).toBe(255);
    // Same buffer on every call (shared upload source).
    expect(offlineBarsRgba()).toBe(px);
  });
});

describe('mediaUnavailableDetail', () => {
  it('names the layer for export/preview messages', () => {
    expect(mediaUnavailableDetail('hero')).toMatch(/hero/);
    expect(mediaUnavailableDetail('hero', 'blob:dead')).toMatch(/blob:dead/);
  });
});
