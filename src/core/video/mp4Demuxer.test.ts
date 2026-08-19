/**
 * The demuxer, pinned against real ffmpeg-encoded MP4s — not hand-built box
 * soup. Two fixtures, one distinction: `tiny-ipp.mp4` has no B-frames so
 * decode order IS presentation order, and `tiny-bframes.mp4` reorders, which
 * is the entire reason frameIndex.ts exists. Both are 24 frames, 30fps,
 * 64×48, keyframes every 8 (`-g 8 -sc_threshold 0`), so every structural
 * fact asserted here was CHOSEN at encode time, not observed and enshrined.
 */

import * as fs from 'fs';
import * as path from 'path';
import { demuxMp4 } from './mp4Demuxer';
import { buildFrameIndex, frameAtTime } from './frameIndex';

const fixture = (name: string): ArrayBuffer => {
  const b = fs.readFileSync(path.join(__dirname, '__fixtures__', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('demuxMp4 on the I/P-only fixture', () => {
  it('extracts the facts the encoder was told to produce', async () => {
    const v = await demuxMp4(fixture('tiny-ipp.mp4'));
    expect(v.codec.startsWith('avc1')).toBe(true);
    expect(v.codedWidth).toBe(64);
    expect(v.codedHeight).toBe(48);
    expect(v.samples).toHaveLength(24);
    // -g 8: sync samples at decode indices 0, 8, 16.
    expect(v.samples.map((s, i) => (s.isKey ? i : -1)).filter((i) => i >= 0)).toEqual([0, 8, 16]);
    // Every sample carries real bytes.
    for (const s of v.samples) expect(s.data.length).toBeGreaterThan(0);
  });

  it('carries an avcC description for configure()', async () => {
    const v = await demuxMp4(fixture('tiny-ipp.mp4'));
    expect(v.description).not.toBeNull();
    // AVCDecoderConfigurationRecord begins with configurationVersion = 1 —
    // the byte that proves the 8-byte box header was stripped.
    expect(v.description![0]).toBe(1);
    expect(v.description!.length).toBeGreaterThan(6);
  });

  it('without B-frames, presentation order equals decode order', async () => {
    const v = await demuxMp4(fixture('tiny-ipp.mp4'));
    for (let i = 1; i < v.samples.length; i++) {
      expect(v.samples[i]!.cts).toBeGreaterThan(v.samples[i - 1]!.cts);
    }
  });
});

describe('demuxMp4 on the B-frames fixture', () => {
  it('shows genuine reorder: some sample presents EARLIER than its predecessor', async () => {
    const v = await demuxMp4(fixture('tiny-bframes.mp4'));
    expect(v.samples).toHaveLength(24);
    const reordered = v.samples.some((s, i) => i > 0 && s.cts < v.samples[i - 1]!.cts);
    expect(reordered).toBe(true);
  });

  it('end-to-end with the index: 24 frames on an exact 30fps grid from t=0', async () => {
    const v = await demuxMp4(fixture('tiny-bframes.mp4'));
    const index = buildFrameIndex(v.samples, v.timescale);
    expect(index.frames).toHaveLength(24);
    for (let i = 0; i < 24; i++) {
      // The container's cts starts late by the B-frame delay; normalization
      // must land frame i exactly on the 30fps grid anyway.
      expect(index.frames[i]!.timeUs).toBe(Math.round((i * 1e6) / 30));
      // …and looking the time back up returns the same frame.
      expect(frameAtTime(index, index.frames[i]!.timeUs)).toBe(i);
      expect(frameAtTime(index, index.frames[i]!.timeUs + 16_000)).toBe(i); // mid-frame
    }
    // NOT 24/30s: ffmpeg pads the LAST sample's duration by the 2-frame
    // B-delay (1024 units, not 512), so the container honestly claims
    // 766667 + 66667. The first draft of this test asserted 800000 from
    // arithmetic; the fixture corrected it.
    expect(index.frames[23]!.durationUs).toBe(66_667);
    expect(index.durationUs).toBe(833_334);
  });

  it('every frame decodes from ITS GOP keyframe, through at least itself', async () => {
    const v = await demuxMp4(fixture('tiny-bframes.mp4'));
    const index = buildFrameIndex(v.samples, v.timescale);
    for (const f of index.frames) {
      expect([0, 8, 16]).toContain(f.keyDecodeIndex);
      expect(f.keyDecodeIndex).toBeLessThanOrEqual(f.decodeIndex);
      expect(f.feedThroughDecodeIndex).toBeGreaterThanOrEqual(f.decodeIndex);
      // The feed range never crosses INTO the next GOP.
      const nextKey = f.keyDecodeIndex + 8;
      expect(f.feedThroughDecodeIndex).toBeLessThan(nextKey);
    }
  });
});

describe('demuxMp4 failure paths', () => {
  it('rejects garbage instead of resolving an empty table', async () => {
    const junk = new Uint8Array(256);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) & 0xff;
    await expect(demuxMp4(junk.buffer)).rejects.toThrow(/demux failed/);
  });

  it('rejects an empty buffer', async () => {
    await expect(demuxMp4(new ArrayBuffer(0))).rejects.toThrow(/demux failed/);
  });
});
