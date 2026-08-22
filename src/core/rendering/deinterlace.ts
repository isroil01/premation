/**
 * Field separation for interlaced footage — Interpret Footage ▸ Fields.
 *
 * An interlaced frame carries two half-height images shot 1/(2·fps) apart,
 * woven into alternating scanlines. Drawn as-is, anything moving shows comb
 * teeth along its edges. This module reconstructs a clean frame by KEEPING one
 * field's rows and rebuilding the other field's rows as the average of their
 * vertical neighbours (single-field "bob" at the source frame rate).
 *
 * Scope, stated plainly: this removes combing — the visible 95% of the
 * feature. It does NOT double the frame rate (AE's "Preserve Edges" both-field
 * playback) and does not detect or remove 3:2 pulldown; both build on this
 * field model and are filed, not stubbed.
 *
 * `upper` keeps rows 0, 2, 4… (the top/odd field in broadcast terms — what DV
 * PAL and most tape formats lead with is a per-format fact the USER states,
 * exactly like alpha interpretation: nothing in the file records it reliably).
 * `lower` keeps rows 1, 3, 5….
 *
 * The pixel loop is pure and in-place (`deinterlaceData`) so it is testable
 * without a canvas; `deinterlaceInto` is the thin canvas wrapper the texture
 * provider calls with a reused work canvas — one getImageData/putImageData
 * pair per frame, no allocation after the first.
 */

export type FieldOrder = 'upper' | 'lower';

/**
 * Rebuild the discarded field's rows in place.
 *
 * Kept rows are untouched. Each discarded row becomes the per-channel average
 * of the kept rows directly above and below; the top/bottom edge rows, having
 * only one kept neighbour, copy it. Alpha is averaged with the colour — a
 * combed alpha edge is the same artifact in a different channel.
 */
export function deinterlaceData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keep: FieldOrder,
): void {
  if (width < 1 || height < 2) return;
  const keepParity = keep === 'upper' ? 0 : 1;
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    if ((y & 1) === keepParity) continue;
    const above = y - 1;
    const below = y + 1;
    const row = y * rowBytes;
    if (above < 0) {
      // Top edge: only the kept row below exists.
      data.copyWithin(row, below * rowBytes, below * rowBytes + rowBytes);
      continue;
    }
    if (below >= height) {
      data.copyWithin(row, above * rowBytes, above * rowBytes + rowBytes);
      continue;
    }
    const a = above * rowBytes;
    const b = below * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      // +1 rounds to nearest without a float op per byte.
      data[row + x] = (data[a + x]! + data[b + x]! + 1) >> 1;
    }
  }
}

/**
 * Draw `src` into `work` at `width`×`height`, deinterlace, and return `work`.
 *
 * The caller owns and reuses the work canvas (the setVideo/setParticles
 * pattern: one canvas per entry, rewritten in place). Returns null when a 2D
 * context is unavailable — the caller then uploads the raw frame, which is
 * exactly the pre-fields behaviour, so a headless or exhausted-context runtime
 * degrades to combing rather than to a missing layer.
 */
export function deinterlaceInto(
  work: HTMLCanvasElement,
  src: CanvasImageSource,
  width: number,
  height: number,
  keep: FieldOrder,
): HTMLCanvasElement | null {
  if (width < 1 || height < 2) return null;
  if (work.width !== width || work.height !== height) {
    work.width = width;
    work.height = height;
  }
  const ctx = work.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(src, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    deinterlaceData(image.data, width, height, keep);
    ctx.putImageData(image, 0, 0);
    return work;
  } catch {
    // A tainted or unreadable source cannot be processed — degrade to raw.
    return null;
  }
}
