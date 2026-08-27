/**
 * WebM muxer tests.
 *
 * A muxer is all offsets and length prefixes, so the failure mode is a file that
 * looks plausible and plays as nothing — the exact bug this module was written to
 * fix. These tests pin the byte layout (EBML varints, element framing, cluster
 * splitting, cue positions) rather than just "it returned some bytes", and parse
 * the output back with an independent reader so a mistake in the writer cannot
 * hide behind a matching mistake in the assertions.
 */

import { muxWebm, vint, uintBytes, idBytes, element, type WebmSample } from './webmMuxer';

const bytes = (...v: number[]): Uint8Array => new Uint8Array(v);

describe('EBML primitives', () => {
  it('encodes 1-byte varints with the high marker bit', () => {
    expect(vint(0)).toEqual(bytes(0x80));
    expect(vint(1)).toEqual(bytes(0x81));
    expect(vint(126)).toEqual(bytes(0xfe));
  });

  it('widens at the reserved all-ones value, not at the byte boundary', () => {
    // 127 is the "unknown size" escape for width 1, so it must widen.
    expect(vint(127)).toEqual(bytes(0x40, 0x7f));
    expect(vint(128)).toEqual(bytes(0x40, 0x80));
    expect(vint(300)).toEqual(bytes(0x41, 0x2c));
  });

  it('widens again past 14 bits', () => {
    expect(vint(16_383)).toEqual(bytes(0x20, 0x3f, 0xff));
    expect(vint(1_000_000)).toEqual(bytes(0x2f, 0x42, 0x40));
  });

  it('encodes unsigned ints in as few bytes as possible', () => {
    expect(uintBytes(0)).toEqual(bytes(0));
    expect(uintBytes(1)).toEqual(bytes(1));
    expect(uintBytes(255)).toEqual(bytes(0xff));
    expect(uintBytes(256)).toEqual(bytes(0x01, 0x00));
    expect(uintBytes(1_000_000)).toEqual(bytes(0x0f, 0x42, 0x40));
  });

  it('strips leading zero bytes from element ids', () => {
    expect(idBytes(0xae)).toEqual(bytes(0xae));
    expect(idBytes(0x4286)).toEqual(bytes(0x42, 0x86));
    expect(idBytes(0x1a45dfa3)).toEqual(bytes(0x1a, 0x45, 0xdf, 0xa3));
  });

  it('frames an element as id + size + payload', () => {
    expect(element(0xae, bytes(1, 2, 3))).toEqual(bytes(0xae, 0x83, 1, 2, 3));
  });
});

// ── A minimal independent EBML reader, for verifying the output ───────

interface Node {
  id: number;
  size: number;
  start: number;
  data: Uint8Array;
}

function readVintLength(b: Uint8Array, at: number): number {
  const first = b[at]!;
  for (let w = 1; w <= 8; w++) {
    if (first & (1 << (8 - w))) return w;
  }
  throw new Error(`invalid vint at ${at}`);
}

function readVintValue(b: Uint8Array, at: number): { value: number; width: number } {
  const width = readVintLength(b, at);
  let value = b[at]! & ((1 << (8 - width)) - 1);
  for (let i = 1; i < width; i++) value = value * 256 + b[at + i]!;
  return { value, width };
}

/** Every direct child element of `b`. */
function children(b: Uint8Array): Node[] {
  const out: Node[] = [];
  let at = 0;
  while (at < b.length) {
    const idWidth = readVintLength(b, at);
    let id = 0;
    for (let i = 0; i < idWidth; i++) id = id * 256 + b[at + i]!;
    const size = readVintValue(b, at + idWidth);
    const dataStart = at + idWidth + size.width;
    out.push({ id, size: size.value, start: dataStart, data: b.subarray(dataStart, dataStart + size.value) });
    at = dataStart + size.value;
  }
  return out;
}

const find = (nodes: Node[], id: number): Node | undefined => nodes.find((n) => n.id === id);
const findAll = (nodes: Node[], id: number): Node[] => nodes.filter((n) => n.id === id);
const readUint = (b: Uint8Array): number => b.reduce((acc, byte) => acc * 256 + byte, 0);

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_CODEC_ID = 0x86;
const ID_TRACK_TYPE = 0x83;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_VIDEO = 0xe0;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_CLUSTER_POSITION = 0xf1;

const sample = (index: number, fps: number, keyFrame: boolean, size = 8): WebmSample => ({
  timestampUs: Math.round((index * 1e6) / fps),
  keyFrame,
  data: new Uint8Array(size).fill(index % 256),
});

const track = { codec: 'vp9' as const, width: 320, height: 180, fps: 10 };

describe('muxWebm', () => {
  it('refuses to write a file with no frames', () => {
    // The whole point: an empty video file must be an error, never an output.
    expect(() => muxWebm(track, [])).toThrow(/no video samples/i);
  });

  it('writes a parseable EBML header declaring webm', () => {
    const file = muxWebm(track, [sample(0, 10, true)]);
    const top = children(file);

    expect(top.map((n) => n.id)).toEqual([ID_EBML, ID_SEGMENT]);
    const docType = find(children(top[0]!.data), 0x4282);
    expect(new TextDecoder().decode(docType!.data)).toBe('webm');
  });

  it('declares the video track with codec and pixel dimensions', () => {
    const file = muxWebm(track, [sample(0, 10, true)]);
    const segment = children(children(file)[1]!.data);
    const entry = find(children(find(segment, ID_TRACKS)!.data), ID_TRACK_ENTRY)!;
    const fields = children(entry.data);

    expect(new TextDecoder().decode(find(fields, ID_CODEC_ID)!.data)).toBe('V_VP9');
    expect(readUint(find(fields, ID_TRACK_TYPE)!.data)).toBe(1); // video
    const video = children(find(fields, ID_VIDEO)!.data);
    expect(readUint(find(video, ID_PIXEL_WIDTH)!.data)).toBe(320);
    expect(readUint(find(video, ID_PIXEL_HEIGHT)!.data)).toBe(180);
  });

  it('carries every frame through as a SimpleBlock, in order', () => {
    const samples = Array.from({ length: 12 }, (_, i) => sample(i, 10, i === 0));
    const file = muxWebm(track, samples);
    const segment = children(children(file)[1]!.data);
    const blocks = findAll(segment, ID_CLUSTER).flatMap((c) => findAll(children(c.data), ID_SIMPLE_BLOCK));

    expect(blocks).toHaveLength(12);
    // Payload = track vint (1 byte for track 1) + int16 timestamp + flags byte.
    blocks.forEach((b, i) => {
      expect(b.data[0]).toBe(0x81); // track 1
      expect(b.data.subarray(4)).toEqual(samples[i]!.data);
    });
  });

  it('flags only keyframes', () => {
    const samples = [sample(0, 10, true), sample(1, 10, false), sample(2, 10, false)];
    const file = muxWebm(track, samples);
    const segment = children(children(file)[1]!.data);
    const blocks = findAll(segment, ID_CLUSTER).flatMap((c) => findAll(children(c.data), ID_SIMPLE_BLOCK));

    expect(blocks.map((b) => b.data[3])).toEqual([0x80, 0x00, 0x00]);
  });

  it('starts a new cluster at each keyframe, with timestamps relative to it', () => {
    // Keyframes every 5 frames at 10fps → clusters at 0s, 0.5s, 1s. Times are
    // in 100µs ticks (TimestampScale 100_000), so 0.5s = 5000 ticks.
    const samples = Array.from({ length: 15 }, (_, i) => sample(i, 10, i % 5 === 0));
    const file = muxWebm(track, samples);
    const segment = children(children(file)[1]!.data);
    const clusters = findAll(segment, ID_CLUSTER);

    expect(clusters).toHaveLength(3);
    const clusterTimes = clusters.map((c) => readUint(find(children(c.data), ID_TIMESTAMP)!.data));
    expect(clusterTimes).toEqual([0, 5000, 10_000]);

    // Each cluster's first block sits at relative 0, and none exceed the span.
    for (const c of clusters) {
      const blocks = findAll(children(c.data), ID_SIMPLE_BLOCK);
      const rel = blocks.map((b) => new DataView(b.data.buffer, b.data.byteOffset + 1, 2).getInt16(0, false));
      expect(rel[0]).toBe(0);
      expect(Math.max(...rel)).toBeLessThan(5000);
    }
  });

  it('breaks clusters before relative timestamps could overflow int16', () => {
    // 40 seconds at 1fps with a single keyframe: without a span limit the
    // relative timestamps would run to 400000 ticks and wrap negative in int16.
    const samples = Array.from({ length: 40 }, (_, i) => sample(i, 1, i === 0));
    const file = muxWebm({ ...track, fps: 1 }, samples);
    const segment = children(children(file)[1]!.data);
    const clusters = findAll(segment, ID_CLUSTER);

    expect(clusters.length).toBeGreaterThan(1);
    for (const c of clusters) {
      const blocks = findAll(children(c.data), ID_SIMPLE_BLOCK);
      for (const b of blocks) {
        const rel = new DataView(b.data.buffer, b.data.byteOffset + 1, 2).getInt16(0, false);
        expect(rel).toBeGreaterThanOrEqual(0);
        expect(rel).toBeLessThan(32_768);
      }
    }
  });

  it('points each cue at the real byte offset of its cluster', () => {
    const samples = Array.from({ length: 15 }, (_, i) => sample(i, 10, i % 5 === 0));
    const file = muxWebm(track, samples);
    const segmentNode = children(file)[1]!;
    const segment = children(segmentNode.data);

    const cuePositions = findAll(children(find(segment, ID_CUES)!.data), ID_CUE_POINT)
      .map((p) => find(children(p.data), ID_CUE_TRACK_POSITIONS)!)
      .map((tp) => readUint(find(children(tp.data), ID_CUE_CLUSTER_POSITION)!.data));

    // Cue positions are byte offsets from the start of the Segment's payload, so
    // the bytes at each one must be a Cluster id. A cue that points anywhere else
    // makes the file seek to garbage.
    expect(cuePositions).toHaveLength(3);
    for (const pos of cuePositions) {
      const idAt = segmentNode.data.subarray(pos, pos + 4);
      expect(Array.from(idAt)).toEqual([0x1f, 0x43, 0xb6, 0x75]);
    }
  });

  it('reports a duration that covers the last frame', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i, 10, i === 0));
    const file = muxWebm(track, samples);
    const segment = children(children(file)[1]!.data);
    const duration = find(children(find(segment, ID_INFO)!.data), 0x4489)!;
    const ticks = new DataView(duration.data.buffer, duration.data.byteOffset, 8).getFloat64(0, false);

    // 10 frames at 10fps = 1s of content; duration (in 100µs ticks) must
    // include the last frame.
    expect(ticks).toBeCloseTo(10_000, 0);
  });

  it('declares BT.709 limited-range colour on the video track', () => {
    const file = muxWebm(track, [sample(0, 10, true)]);
    const segment = children(children(file)[1]!.data);
    const entry = find(children(find(segment, ID_TRACKS)!.data), ID_TRACK_ENTRY)!;
    const video = children(find(children(entry.data), ID_VIDEO)!.data);
    const colour = children(find(video, 0x55b0)!.data);

    expect(readUint(find(colour, 0x55b1)!.data)).toBe(1); // MatrixCoefficients
    expect(readUint(find(colour, 0x55bb)!.data)).toBe(1); // Primaries
    expect(readUint(find(colour, 0x55ba)!.data)).toBe(1); // TransferCharacteristics
    expect(readUint(find(colour, 0x55b9)!.data)).toBe(1); // Range (limited)
  });

  it('keeps NTSC-rate frame times exact to 100µs (no 1ms quantisation)', () => {
    // At 29.97fps frame 1 sits at 33366.7µs. The old 1ms scale rounded it to
    // 33ms; 100µs ticks carry 334 — within half a tick of the true time.
    const samples = [sample(0, 29.97, true), sample(1, 29.97, false)];
    const file = muxWebm({ ...track, fps: 29.97 }, samples);
    const segment = children(children(file)[1]!.data);
    const blocks = findAll(segment, ID_CLUSTER).flatMap((c) => findAll(children(c.data), ID_SIMPLE_BLOCK));
    const rel = new DataView(blocks[1]!.data.buffer, blocks[1]!.data.byteOffset + 1, 2).getInt16(0, false);

    expect(rel).toBe(334); // 33.4ms in 100µs ticks
  });

  it('interleaves audio blocks with video in presentation order', () => {
    const video = Array.from({ length: 5 }, (_, i) => sample(i, 10, i === 0));
    const audio = Array.from({ length: 5 }, (_, i) => sample(i, 10, true, 4));
    const file = muxWebm(track, video, {
      track: { sampleRate: 48_000, channels: 2, description: new Uint8Array([1, 2, 3]) },
      samples: audio,
    });
    const segment = children(children(file)[1]!.data);

    // Two track entries now.
    expect(findAll(children(find(segment, ID_TRACKS)!.data), ID_TRACK_ENTRY)).toHaveLength(2);

    const blocks = findAll(segment, ID_CLUSTER).flatMap((c) => findAll(children(c.data), ID_SIMPLE_BLOCK));
    expect(blocks).toHaveLength(10);

    // Timestamps must be non-decreasing across the interleaved stream.
    const times = blocks.map((b) => new DataView(b.data.buffer, b.data.byteOffset + 1, 2).getInt16(0, false));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
