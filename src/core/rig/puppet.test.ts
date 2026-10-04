import {
  
  
  coverageMaskFromImageData,
  
  silhouetteFromPathPoints,
  resolvePuppetSilhouette,
  
  
} from './puppet';

/** Build a synthetic RGBA bitmap. `alphaAt(x, y)` returns 0-255 per pixel. */
function makeBitmap(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alphaAt(x, y);
    }
  }
  return { data, width, height };
}

describe('Image-alpha coverage meshing', () => {

  // A centered opaque disc (radius 30) in a transparent 100×100 field.
  const disc = makeBitmap(100, 100, (x, y) =>
    Math.hypot(x - 50, y - 50) <= 30 ? 255 : 0,
  );

  it('does not ear-clip an alpha mask — PNG characters stay a culled grid', () => {
    const cov = coverageMaskFromImageData(disc);
    expect(resolvePuppetSilhouette(undefined, cov, 100, 100, 'silhouette')).toBeUndefined();
    expect(resolvePuppetSilhouette(undefined, cov, 100, 100, 'grid')).toBeUndefined();
    const path = silhouetteFromPathPoints(
      [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }],
      false,
    );
    expect(resolvePuppetSilhouette(path, cov, 100, 100, 'silhouette')).toBe(path);
  });
});
