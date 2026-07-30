/**
 * Pixel sampling for the Info readout: map a CSS-space point over a canvas to
 * the device-pixel it covers, and read that pixel's RGBA. The coordinate math
 * is pure/testable; `samplePixelRgba` does the DOM read (guarded).
 */

import { isGpuOwned } from '@core/rendering/canvasOwnership';

/** CSS-space point (relative to the canvas top-left) → integer device pixel, or
 *  null if it falls outside the canvas backing store. `rect` is the canvas's
 *  CSS box, `w`/`h` its backing-store (device) dimensions. */
export function cssToDevicePixel(
  local: { x: number; y: number },
  rect: { width: number; height: number },
  w: number,
  h: number,
): { px: number; py: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const px = Math.floor(local.x * (w / rect.width));
  const py = Math.floor(local.y * (h / rect.height));
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  return { px, py };
}

/** Read the RGBA of the device pixel under a CSS-space point on `canvas`.
 *  Returns null when the canvas has no readable 2D context (e.g. a WebGL
 *  backend) or the point is off-canvas. Never throws. */
export function samplePixelRgba(
  canvas: HTMLCanvasElement,
  local: { x: number; y: number },
): { r: number; g: number; b: number; a: number } | null {
  try {
    const rect = canvas.getBoundingClientRect();
    const dp = cssToDevicePixel(local, rect, canvas.width, canvas.height);
    if (!dp) return null;
    // A GPU backend's canvas must never be touched with getContext('2d'):
    // before the backend's async init has bound the element, this call would
    // WIN the binding and burn the canvas to 2d — after which every WebGPU/
    // WebGL2 getContext returns null and the viewport reports "GPU
    // unavailable" (the packaged-build first-entry bug). After init it merely
    // returns null; either way there is nothing to read.
    if (isGpuOwned(canvas)) return null;
    // getContext('2d') returns the existing 2D context, or null if the canvas
    // is already bound to a different context type (WebGL) — never a throw.
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const d = ctx.getImageData(dp.px, dp.py, 1, 1).data;
    return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! };
  } catch {
    return null;
  }
}
