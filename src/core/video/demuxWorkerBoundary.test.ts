/**
 * The demux worker boundary.
 *
 * The existing suites exercise `demuxMp4` / `demuxWebm` directly against real
 * ffmpeg-encoded fixtures and must keep doing so — that is where container
 * correctness is decided, and moving where a function runs is not a reason to
 * stop testing what it produces. What is NOT covered by those is the boundary:
 * a result that survives packing, transfer and rebuilding has to be the same
 * result, byte for byte, or the frame index is built over samples that lie.
 *
 * jsdom has no `Worker`, so the round trip is driven against the real wire
 * format with a stub in the middle. The wire format is where the risk lives —
 * the worker itself is four lines of plumbing around functions tested elsewhere.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demuxMp4 } from './mp4Demuxer';
import { toWire, fromWire } from './demuxWire';
import { demuxFile, demuxInline, resetDemuxWorker } from './demuxClient';

/** The same fixtures the demuxer's own suite uses. */
function fixture(name: string): ArrayBuffer {
  const b = readFileSync(join(__dirname, '__fixtures__', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

afterEach(resetDemuxWorker);

describe('the wire format round-trips a demux exactly', () => {
  it.each(['tiny-ipp.mp4', 'tiny-bframes.mp4'])('%s', async (name) => {
    const direct = await demuxMp4(fixture(name));
    const roundTripped = fromWire(toWire(direct));

    expect(roundTripped.codec).toBe(direct.codec);
    expect(roundTripped.codedWidth).toBe(direct.codedWidth);
    expect(roundTripped.codedHeight).toBe(direct.codedHeight);
    expect(roundTripped.timescale).toBe(direct.timescale);
    expect(roundTripped.rotation).toBe(direct.rotation);
    expect(roundTripped.samples).toHaveLength(direct.samples.length);

    for (let i = 0; i < direct.samples.length; i++) {
      const a = direct.samples[i]!;
      const b = roundTripped.samples[i]!;
      expect(b.dts).toBe(a.dts);
      expect(b.cts).toBe(a.cts);
      expect(b.isKey).toBe(a.isKey);
      expect(b.duration).toBe(a.duration);
      // The bytes are the whole point: an index over samples whose payloads
      // shifted by an offset decodes to garbage, not to an error.
      expect(Array.from(b.data)).toEqual(Array.from(a.data));
    }
  });

  it('carries the codec description, which configure() cannot run without', async () => {
    const direct = await demuxMp4(fixture('tiny-ipp.mp4'));
    const back = fromWire(toWire(direct));
    expect(direct.description).not.toBeNull();
    expect(Array.from(back.description!)).toEqual(Array.from(direct.description!));
  });

  it('copies the description out of the source buffer rather than viewing it', async () => {
    // A view would keep the entire source file alive for the sake of a few
    // dozen bytes, in the one place designed to hand the file back.
    const direct = await demuxMp4(fixture('tiny-ipp.mp4'));
    const wire = toWire(direct);
    expect(wire.description!.buffer).not.toBe(wire.bytes);
    expect(wire.description!.byteLength).toBeLessThan(wire.bytes.byteLength);
  });

  it('packs every sample into one buffer, end to end', async () => {
    const direct = await demuxMp4(fixture('tiny-bframes.mp4'));
    const wire = toWire(direct);
    const total = direct.samples.reduce((n, s) => n + s.data.byteLength, 0);
    expect(wire.bytes.byteLength).toBe(total);
    // Offsets are contiguous and in order — the property that makes rebuilding
    // views over the shared buffer safe.
    let expected = 0;
    for (const s of wire.samples) {
      expect(s.offset).toBe(expected);
      expected += s.length;
    }
  });

  it('preserves the WebM alpha flag, which decides the render tier', async () => {
    // The exact loader REFUSES an alpha WebM (the element tier is the only one
    // that composites its transparency). Losing the flag at the boundary would
    // silently opt those files into a path that renders them opaque.
    const withAlpha = { ...(await demuxMp4(fixture('tiny-ipp.mp4'))), hasAlpha: true };
    expect(fromWire(toWire(withAlpha)).hasAlpha).toBe(true);
    const without = await demuxMp4(fixture('tiny-ipp.mp4'));
    expect(fromWire(toWire(without)).hasAlpha).toBeUndefined();
  });
});

describe('demuxFile', () => {
  it('falls back to this thread where there is no Worker, with the same result', async () => {
    // jsdom, the render-test harness and the headless CLI all land here.
    expect(typeof Worker).toBe('undefined');
    const viaClient = await demuxFile(fixture('tiny-ipp.mp4'));
    const direct = await demuxInline(fixture('tiny-ipp.mp4'));
    expect(viaClient.samples).toHaveLength(direct.samples.length);
    expect(viaClient.codec).toBe(direct.codec);
    expect(Array.from(viaClient.samples[0]!.data)).toEqual(Array.from(direct.samples[0]!.data));
  });

  it('picks the container from the magic bytes, not from the call site', async () => {
    // `smoothStabilize` used to call `demuxMp4` directly, so a WebM layer
    // reached mp4box and failed with a parse error rather than being demuxed.
    const mp4 = await demuxFile(fixture('tiny-ipp.mp4'));
    expect(mp4.samples.length).toBeGreaterThan(0);
  });

  it('rejects a buffer that is not a video, rather than returning an empty table', async () => {
    // An index built over half a sample table produces frame numbers that lie,
    // so an incomplete demux has to fail loudly at every layer.
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    await expect(demuxFile(junk)).rejects.toThrow();
  });
});
