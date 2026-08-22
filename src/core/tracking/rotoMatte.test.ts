import { floodMatte, matteToPath } from './rotoMatte';

describe('rotoMatte', () => {
  it('flood-fills a solid region from a seed', () => {
    const w = 8;
    const h = 8;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Left half red, right half blue.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x < 4) { rgba[i] = 200; rgba[i + 1] = 20; rgba[i + 2] = 20; }
        else { rgba[i] = 20; rgba[i + 1] = 20; rgba[i + 2] = 200; }
        rgba[i + 3] = 255;
      }
    }
    const mask = floodMatte(rgba, w, h, [{ x: 1, y: 1, tolerance: 40 }]);
    let red = 0;
    let blue = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          if (x < 4) red++;
          else blue++;
        }
      }
    }
    expect(red).toBe(32);
    expect(blue).toBe(0);
    const path = matteToPath(mask, w, h);
    expect(path.length).toBeGreaterThan(3);
  });
});
