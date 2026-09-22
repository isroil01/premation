/**
 * GPU memory (VRAM) accounting — the number behind the HUD's "vram" gauge.
 *
 * Neither WebGPU nor WebGL2 will say how much device memory a process holds,
 * so this ESTIMATES it from the descriptors the renderer allocates with:
 *
 *   texture        width × height × bytesPerPixel(format), × 4/3 with mips
 *   render target  the colour texture, plus the multisample attachment when
 *                  MSAA was asked for, plus a depth24plus attachment (counted
 *                  as 4 bytes/px — drivers pad it to 32 bits) when `depth`
 *   buffer         sizeBytes, rounded to 4 like the backends round it
 *
 * The figure is an approximation: drivers align rows and levels, compress
 * depth, and keep swap-chain images this never sees. It is stable and
 * monotone in what the renderer holds, which is what a gauge needs — a leak
 * shows as a line that never comes down, a resolution change as a step.
 *
 * `GpuMemoryMeter` is the counter itself: `add` on create, `sub` on destroy,
 * `peak` is the high-water mark since the last `resetPeak`. It is deliberately
 * a plain object with two numbers so a backend or pool can carry one without
 * knowing who reads it.
 */

import type { BufferDescriptor, RenderTargetDescriptor, TextureDescriptor, TextureFormat } from './types';

/** Bytes one texel of `format` occupies. Unknown formats count as 4. */
export function bytesPerPixel(format: TextureFormat | string): number {
  switch (format) {
    case 'r8unorm':
      return 1;
    case 'rgba16float':
      return 8;
    case 'rgba32float':
      return 16;
    case 'rgba8unorm':
    case 'rgba8unorm-srgb':
    case 'bgra8unorm':
    case 'depth24plus':
    default:
      return 4;
  }
}

/** Sum of every mip level's texel count ≈ 4/3 of the base level. */
function mipChainBytes(width: number, height: number, bpp: number): number {
  let w = Math.max(1, width);
  let h = Math.max(1, height);
  let total = 0;
  for (;;) {
    total += w * h * bpp;
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return total;
}

/**
 * Estimated bytes for a sampled texture. `maxDim` mirrors the backends' clamp:
 * WebGPU refuses a texture over `maxTextureDimension2D`, so the backend clamps
 * the allocation and the estimate must follow it.
 */
export function estimateTextureBytes(desc: TextureDescriptor, maxDim = Infinity): number {
  const w = Math.max(1, Math.min(maxDim, desc.width));
  const h = Math.max(1, Math.min(maxDim, desc.height));
  const bpp = bytesPerPixel(desc.format);
  return desc.mipmapped ? mipChainBytes(w, h, bpp) : w * h * bpp;
}

/**
 * Estimated bytes for a render target: colour attachment, the MSAA attachment
 * it resolves from (WebGPU guarantees only 1 and 4 samples, so anything above
 * 1 is counted as 4), and the depth attachment when requested.
 */
export function estimateRenderTargetBytes(desc: RenderTargetDescriptor): number {
  const w = Math.max(1, desc.width);
  const h = Math.max(1, desc.height);
  const bpp = bytesPerPixel(desc.format);
  const samples = (desc.samples ?? 1) > 1 ? 4 : 1;
  let bytes = w * h * bpp;
  if (samples > 1) bytes += w * h * bpp * samples;
  if (desc.depth) bytes += w * h * 4 * samples;
  return bytes;
}

/** Estimated bytes for a buffer — its size, rounded up to 4 as the backends do. */
export function estimateBufferBytes(desc: BufferDescriptor): number {
  return (Math.max(0, desc.sizeBytes) + 3) & ~3;
}

/** A running byte counter with a high-water mark. */
export class GpuMemoryMeter {
  /** Bytes currently held. */
  bytes = 0;
  /** Highest `bytes` seen since construction or `resetPeak`. */
  peak = 0;

  add(bytes: number): void {
    if (!(bytes > 0)) return;
    this.bytes += bytes;
    if (this.bytes > this.peak) this.peak = this.bytes;
  }

  sub(bytes: number): void {
    if (!(bytes > 0)) return;
    this.bytes = Math.max(0, this.bytes - bytes);
  }

  resetPeak(): void {
    this.peak = this.bytes;
  }
}
