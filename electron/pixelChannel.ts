/**
 * The route-A pixel stream (the engine's fd 5) — the TypeScript twin of
 * native/protocol/include/premation/protocol/pixel_channel.hpp.
 *
 * Framing: 4-byte little-endian length (engineFraming.FrameDecoder), then a
 * 32-byte little-endian header, then height × bytesPerRow bytes of RGBA8.
 *
 *   0 magic 'PXF1' · 4 generation · 8 slot · 12 width · 16 height ·
 *   20 bytesPerRow · 24 format (0 = rgba8unorm) · 28 reserved
 *
 * The engine writes one pixel message and then the frame's FrameReady on fd 3;
 * the two pipes are not ordered, so FrameForwarder pairs them by
 * (generation, slot).
 */

export const PIXEL_MAGIC = 0x31465850;
export const PIXEL_HEADER_BYTES = 32;
/** Largest payload accepted: an 8K RGBA8 frame plus the header (pixel_channel.hpp kMaxPayload). */
export const MAX_PIXEL_PAYLOAD = PIXEL_HEADER_BYTES + 7680 * 4320 * 4;

export interface PixelFrame {
  generation: number;
  slot: number;
  width: number;
  height: number;
  bytesPerRow: number;
  format: number;
  /** The rows (a view into the payload; the payload is a private copy). */
  data: Uint8Array;
}

/** Parse one payload; null when it is not a well-formed pixel message. */
export function decodePixelFrame(payload: Uint8Array): PixelFrame | null {
  if (payload.length < PIXEL_HEADER_BYTES || payload.length > MAX_PIXEL_PAYLOAD) return null;
  const v = new DataView(payload.buffer, payload.byteOffset, PIXEL_HEADER_BYTES);
  if (v.getUint32(0, true) !== PIXEL_MAGIC) return null;
  const width = v.getUint32(12, true);
  const height = v.getUint32(16, true);
  const bytesPerRow = v.getUint32(20, true);
  if (width === 0 || height === 0 || bytesPerRow < width * 4) return null;
  if (payload.length - PIXEL_HEADER_BYTES !== bytesPerRow * height) return null;
  return {
    generation: v.getUint32(4, true),
    slot: v.getUint32(8, true),
    width,
    height,
    bytesPerRow,
    format: v.getUint32(24, true),
    data: payload.subarray(PIXEL_HEADER_BYTES),
  };
}

/** Build one payload (tests, and any host-side tool that fakes an engine). */
export function encodePixelFrame(f: Omit<PixelFrame, 'format'> & { format?: number }): Uint8Array {
  const out = new Uint8Array(PIXEL_HEADER_BYTES + f.data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, PIXEL_MAGIC, true);
  v.setUint32(4, f.generation, true);
  v.setUint32(8, f.slot, true);
  v.setUint32(12, f.width, true);
  v.setUint32(16, f.height, true);
  v.setUint32(20, f.bytesPerRow, true);
  v.setUint32(24, f.format ?? 0, true);
  out.set(f.data, PIXEL_HEADER_BYTES);
  return out;
}
