/**
 * A contact sheet from rendered frames, with pngjs (a test-only dependency).
 *
 * The eval runs in Node, where there is no canvas: frames come from the
 * engine as PNG bytes (`getThumbnail`) and are tiled here into one image —
 * the artifact a person scans and the picture the vision judges are shown.
 * Each cell gets a thin progress bar under it (its time as a fraction of the
 * piece) instead of a text label, because pngjs draws no glyphs.
 */

import { PNG } from 'pngjs';

export interface SheetFrame {
  png: Uint8Array;
  /** Composition seconds the frame was taken at. */
  t: number;
}

interface Decoded { width: number; height: number; data: Uint8Array }

/** pngjs, typed (a devDependency; this module is only reached from test files). */
const png = (): typeof PNG => PNG;

export function decodePng(bytes: Uint8Array): Decoded {
  const d = png().sync.read(Buffer.from(bytes));
  return { width: d.width, height: d.height, data: new Uint8Array(d.data) };
}

/** Nearest-neighbour scale of RGBA pixels into `out` at (ox, oy). */
function blit(src: Decoded, out: { data: Buffer; width: number }, ox: number, oy: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const si = (sy * src.width + sx) * 4;
      const di = ((oy + y) * out.width + ox + x) * 4;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = 255;
    }
  }
}

function fill(out: { data: Buffer; width: number }, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * out.width + x) * 4;
      out.data[i] = rgb[0];
      out.data[i + 1] = rgb[1];
      out.data[i + 2] = rgb[2];
      out.data[i + 3] = 255;
    }
  }
}

/**
 * Tile frames into one PNG, `cols` per row, each cell `cellW` wide at the
 * frames' own aspect. Returns the PNG bytes.
 */
export function contactSheet(frames: readonly SheetFrame[], durationSec: number, cols = 4, cellW = 400): Uint8Array {
  if (!frames.length) throw new Error('contactSheet: no frames');
  const decoded = frames.map((f) => decodePng(f.png));
  const aspect = decoded[0]!.height / Math.max(1, decoded[0]!.width);
  const cellH = Math.max(1, Math.round(cellW * aspect));
  const pad = 6;
  const bar = 4;
  const rows = Math.ceil(frames.length / cols);
  const W = cols * (cellW + pad) + pad;
  const H = rows * (cellH + bar + pad * 2) + pad;
  const P = png();
  const out = new P({ width: W, height: H });
  // Mid grey: neither a dark nor a light piece loses its edges against it.
  fill(out, 0, 0, W, H, [42, 42, 46]);
  decoded.forEach((d, i) => {
    const x = pad + (i % cols) * (cellW + pad);
    const y = pad + Math.floor(i / cols) * (cellH + bar + pad * 2);
    blit(d, out, x, y, cellW, cellH);
    const frac = durationSec > 0 ? Math.max(0, Math.min(1, frames[i]!.t / durationSec)) : 0;
    fill(out, x, y + cellH + pad / 2, cellW, bar, [70, 70, 76]);
    fill(out, x, y + cellH + pad / 2, Math.max(1, Math.round(cellW * frac)), bar, [207, 207, 212]);
  });
  return new Uint8Array(P.sync.write(out));
}

/** Evenly spaced sample times across a piece, the last a frame short of the end. */
export function sampleTimes(durationSec: number, fps: number, n = 12): number[] {
  const last = Math.max(0, durationSec - 1 / Math.max(1, fps));
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round(((last * i) / (n - 1)) * 1e6) / 1e6));
}
