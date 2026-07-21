import { createAnimatedGIF, createAnimatedGIFBytes } from './gifEncoder';

describe('gifEncoder', () => {
  const makeSolidFrame = (w: number, h: number, r: number, g: number, b: number, a = 255) => {
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = a;
    }
    return { width: w, height: h, pixels };
  };

  it('produces a valid GIF signature and header', () => {
    const frame = makeSolidFrame(10, 10, 255, 0, 0);
    const blob = createAnimatedGIF([frame], 10);
    
    expect(blob.type).toBe('image/gif');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('contains GIF89a header and Netscape looping block', () => {
    const frame = makeSolidFrame(4, 4, 0, 255, 0);
    const bytes = createAnimatedGIFBytes([frame], 5);

    // GIF89a header
    const header = String.fromCharCode(...bytes.slice(0, 6));
    expect(header).toBe('GIF89a');

    // NETSCAPE2.0 looping application block
    const asString = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
    expect(asString).toContain('NETSCAPE2.0');
  });

  it('handles multiple frames and transparency gracefully', () => {
    const frame1 = makeSolidFrame(2, 2, 255, 0, 0, 255); // solid red
    const frame2 = makeSolidFrame(2, 2, 0, 0, 255, 0);   // transparent blue
    const bytes = createAnimatedGIFBytes([frame1, frame2], 10);

    expect(bytes.length).toBeGreaterThan(0);
    // GIF trailer (0x3B)
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it('is empty-safe', () => {
    const bytes = createAnimatedGIFBytes([], 10);
    expect(bytes.length).toBe(0);
  });
});
