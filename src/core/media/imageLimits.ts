/**
 * The size a page-side decoder (PSD, EXR, DPX — the formats the browser cannot
 * decode itself) may expand into memory.
 *
 * These decoders allocate width × height × 4 (bytes, or floats for EXR) in the
 * renderer process. A 20 000 × 20 000 PSD is 1.6 GB of RGBA; an EXR of that
 * size is three float planes of 1.6 GB each. Chromium answers such an
 * allocation with "Array buffer allocation failed" — an out-of-memory crash
 * of the whole editor (the dashboard's `out_of_memory`), not a failed import.
 * So every decoder asks here first and the oversize file is reported as a
 * layer / import error instead, like any other file that cannot be read.
 *
 * 64 Mpx is the ceiling: 8192 × 8192, 256 MB as RGBA8 and 1 GB as float RGBA
 * — the most the page can hold beside a running editor.
 */
export const MAX_DECODE_PIXELS = 64 * 1024 * 1024;

/** The largest side any decoded image may have (a 1 × 1 000 000 strip is still refused). */
export const MAX_DECODE_SIDE = 32_768;

/**
 * Throw a plain error naming the format when `width` × `height` cannot be
 * decoded in the page. `what` is the format ("PSD", "EXR", "DPX"); the error
 * never names the file.
 */
export function assertDecodableSize(what: string, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`${what}: the image has no size (${width} × ${height})`);
  }
  if (width > MAX_DECODE_SIDE || height > MAX_DECODE_SIDE || width * height > MAX_DECODE_PIXELS) {
    throw new Error(
      `${what}: ${Math.round(width)} × ${Math.round(height)} is too large to decode here (the limit is ${MAX_DECODE_PIXELS / 1_000_000} megapixels) — resize it or export a smaller copy`,
    );
  }
}
