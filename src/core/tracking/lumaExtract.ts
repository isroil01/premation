/**
 * Luma extraction from decoded frames — the tracker's per-frame input cost.
 *
 * The canvas route (drawImage → getImageData → Rec.601 math) costs a GPU→CPU
 * readback of full RGBA plus a 2M-multiply conversion loop: ~60–100ms per
 * 1080p frame, which after the matcher was optimized became the reason Track
 * progress still crawled. But decoded video frames are YUV — the Y PLANE IS
 * THE LUMA. `VideoFrame.copyTo` hands it over as one plane copy: no canvas,
 * no readback, no color conversion; just a u8→f32 scale into the tracker's
 * plane format. ~10× cheaper.
 *
 * Video-range vs full-range: the Y plane is typically 16–235 where the canvas
 * route produced 0–1 full-range luma. The tracker's NCC is invariant to gain
 * and offset (that is why it is NCC), and consistency WITHIN a walk is all
 * that matters — every frame of a walk takes the same path.
 *
 * The canvas fallback stays for RGBA-format frames, IMAGE-BACKED frames
 * (ExactVideoSource's retained copies are ImageBitmaps, which have no YUV
 * planes to read), and any copyTo failure.
 */

import type { LumaPlane } from './patchMatch';
import { lumaFromRGBA } from './patchMatch';

/** The slice of VideoFrame this module reads — structural for tests. */
interface YuvFrameLike {
  format?: string | null;
  allocationSize?: (opts?: object) => number;
  copyTo?: (dest: Uint8Array, opts?: object) => Promise<Array<{ offset: number; stride: number }>>;
}

/** Formats whose plane 0 is a full-resolution Y plane. */
const Y_PLANE_FORMATS = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);

/**
 * A reusable canvas-based extractor at a fixed coded size — the fallback
 * path, and the whole path for canvas-backed frames.
 */
export function makeCanvasLumaReader(width: number, height: number): (frame: CanvasImageSource) => LumaPlane {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return (frame) => {
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(frame, 0, 0, width, height);
    const img = ctx.getImageData(0, 0, width, height);
    return lumaFromRGBA(img.data, width, height);
  };
}

/**
 * Luma for one decoded frame: Y-plane fast path when the frame is a real YUV
 * VideoFrame, canvas readback otherwise.
 */
export async function lumaFromDecodedFrame(
  frame: unknown,
  width: number,
  height: number,
  canvasReader: (frame: CanvasImageSource) => LumaPlane,
  /**
   * Y-byte → output scale, or 'raw8' to hand back the Y BYTES as a Uint8
   * plane with no conversion at all (a zero-copy subarray when the stride
   * allows) — the tracker's choice, since its math is gain-invariant and the
   * u8→f32 loop costs ~30ms per 4K frame. Numeric scales exist for callers
   * whose math is NOT gain-invariant and must match their canvas fallback:
   * 1 for smoothStabilize's 0–255 flow planes.
   */
  scale: number | 'raw8' = 'raw8',
): Promise<LumaPlane> {
  const vf = frame as YuvFrameLike;
  const fmt = vf.format ?? null;
  if (
    fmt !== null
    && Y_PLANE_FORMATS.has(fmt)
    && typeof vf.copyTo === 'function'
    && typeof vf.allocationSize === 'function'
  ) {
    try {
      const buf = new Uint8Array(vf.allocationSize());
      const layout = await vf.copyTo(buf);
      const y = layout[0];
      if (y) {
        if (scale === 'raw8') {
          if (y.stride === width) {
            // Tightly packed — the Y plane IS the answer, zero copies.
            return { data: buf.subarray(y.offset, y.offset + width * height), width, height };
          }
          // Strided rows: repack with row memcpys (cheap next to a readback).
          const data = new Uint8Array(width * height);
          for (let row = 0; row < height; row++) {
            data.set(buf.subarray(y.offset + row * y.stride, y.offset + row * y.stride + width), row * width);
          }
          return { data, width, height };
        }
        const data = new Float32Array(width * height);
        for (let row = 0; row < height; row++) {
          let src = y.offset + row * y.stride;
          let dst = row * width;
          for (let col = 0; col < width; col++, src++, dst++) {
            data[dst] = buf[src]! * scale;
          }
        }
        return { data, width, height };
      }
    } catch {
      // Detached frame, odd layout, permission — the canvas path still works.
    }
  }
  return canvasReader(frame as CanvasImageSource);
}
