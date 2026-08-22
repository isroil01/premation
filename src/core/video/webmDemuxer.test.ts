/**
 * Smoke test for the WebM EBML reader — magic + empty/invalid rejection.
 * Full demux needs a real VP9 fixture (Chromium decode); this pins the gate.
 */

import { isWebmMagic, demuxWebm } from './webmDemuxer';

describe('webmDemuxer', () => {
  it('detects Matroska magic', () => {
    expect(isWebmMagic(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toBe(true);
    expect(isWebmMagic(new Uint8Array([0x00, 0x00, 0x00, 0x18]))).toBe(false);
  });

  it('rejects non-WebM buffers', async () => {
    await expect(demuxWebm(new Uint8Array([0, 0, 0, 0]).buffer)).rejects.toThrow(/not a WebM/);
  });

  it('rejects WebM magic without a video track', async () => {
    // Minimal EBML header only — no Segment/Tracks.
    const bytes = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01,
    ]);
    await expect(demuxWebm(bytes.buffer)).rejects.toThrow(/no VP8\/VP9|no video/);
  });
});
