/**
 * pixelChannel: the route-A pixel message (fd 5) — the byte layout
 * native/protocol/include/premation/protocol/pixel_channel.hpp writes, and
 * every malformed payload refused.
 */

import { PIXEL_HEADER_BYTES, decodePixelFrame, encodePixelFrame } from './pixelChannel';

describe('pixelChannel', () => {
  const data = new Uint8Array(2 * 12).map((_, i) => i);
  const frame = { generation: 7, slot: 2, width: 3, height: 2, bytesPerRow: 12, data };

  it('round-trips, with the header layout the engine writes', () => {
    const bytes = encodePixelFrame(frame);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('PXF1');
    expect(bytes[4]).toBe(7);
    expect(bytes[20]).toBe(12);
    expect(bytes.length).toBe(PIXEL_HEADER_BYTES + 24);
    const back = decodePixelFrame(bytes)!;
    expect(back).toMatchObject({ generation: 7, slot: 2, width: 3, height: 2, bytesPerRow: 12, format: 0 });
    expect([...back.data]).toEqual([...data]);
  });

  it('refuses short, mis-sized, narrow-row and wrong-magic payloads', () => {
    const bytes = encodePixelFrame(frame);
    expect(decodePixelFrame(bytes.subarray(0, 16))).toBeNull();
    expect(decodePixelFrame(bytes.subarray(0, bytes.length - 1))).toBeNull();
    const bad = bytes.slice();
    bad[0] = 0x51;
    expect(decodePixelFrame(bad)).toBeNull();
    expect(decodePixelFrame(encodePixelFrame({ ...frame, bytesPerRow: 8, data: new Uint8Array(16) }))).toBeNull();
    expect(decodePixelFrame(encodePixelFrame({ ...frame, width: 0 }))).toBeNull();
  });
});
