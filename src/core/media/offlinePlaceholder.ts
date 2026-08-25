/**
 * AE-style offline / missing-footage placeholder — SMPTE-like colour bars.
 *
 * When a layer's source cannot be decoded (404, dead blob, missing file), the
 * viewport must not stay blank: blank looks like "opacity 0" or a compositor
 * bug. Colour bars are the industry signal that the media is offline and needs
 * relinking. Export refuses separately via a `media-unavailable` diagnostic —
 * shipping bars into an MP4 would be worse than a refused export.
 *
 * Fixed 320×180 (16:9). The GPU stretches it to the layer box; bars stay
 * readable at any layer size. Premultiplied opaque (alpha 255).
 */

/** Width / height of the shared offline bars texture. */
export const OFFLINE_BARS_W = 320;
export const OFFLINE_BARS_H = 180;

/** Classic 75% colour-bar primaries (R,G,B), left → right. */
const BAR_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [192, 192, 192], // white
  [192, 192, 0], // yellow
  [0, 192, 192], // cyan
  [0, 192, 0], // green
  [192, 0, 192], // magenta
  [192, 0, 0], // red
  [0, 0, 192], // blue
];

const PLUGE_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [255, 255, 255],
  [0, 0, 0],
];

let cached: Uint8Array | null = null;

/** Premultiplied RGBA8 bytes for the offline bars texture (lazy, once). */
export function offlineBarsRgba(): Uint8Array {
  if (cached) return cached;
  const w = OFFLINE_BARS_W;
  const h = OFFLINE_BARS_H;
  const out = new Uint8Array(w * h * 4);
  const barH = Math.floor(h * 0.72);
  const n = BAR_RGB.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r: number;
      let g: number;
      let b: number;
      if (y < barH) {
        const i = Math.min(n - 1, Math.floor((x / w) * n));
        [r, g, b] = BAR_RGB[i]!;
      } else {
        // Bottom PLUGE strip: black / white / black — AE-ish "Media Offline" cue.
        const i = Math.min(2, Math.floor((x / w) * 3));
        [r, g, b] = PLUGE_RGB[i]!;
      }
      const o = (y * w + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  cached = out;
  return out;
}

/** Human detail string shared by preview toast and export refusal. */
export function mediaUnavailableDetail(layerId: string, srcHint?: string): string {
  const tip = srcHint && srcHint.length > 0 && srcHint.length < 120
    ? ` (${srcHint})`
    : '';
  return `Media offline on "${layerId}"${tip} — relink the footage or remove the layer`;
}
