/**
 * The decoder session against a fake decoder — everything above the codec.
 *
 * jsdom has no WebCodecs, which is WHY the session has a DecoderIO seam; these
 * tests are the payoff. What they pin is the feeding discipline: a request
 * feeds exactly [GOP key .. feed-through] in decode order starting with a key
 * chunk, flushes, and caches every frame the flush emits — so stepping
 * forward is cache hits, a backward seek re-feeds an earlier GOP, an errored
 * decoder is abandoned and rebuilt, and eviction closes what it drops without
 * ever dropping the frame being served. The fake emits in presentation order
 * on flush, which is the only decoder behaviour the session relies on.
 */

import { ExactVideoSource, SequentialFrameReader, webCodecsAvailable, type DecoderIO, type DecodedFrameLike, type EncodedChunkInit } from './exactVideoSource';
import type { DemuxedVideo } from './mp4Demuxer';

const TS = 15360;
const DUR = 512;
const GOP_PRESENT = [0, 3, 1, 2, 6, 4, 5, 7];

/** Synthetic demux mirroring the B-frames fixture: 3 GOPs of 8 at 30fps. */
function demuxed(): DemuxedVideo {
  const samples = [];
  for (let g = 0; g < 3; g++) {
    for (let k = 0; k < 8; k++) {
      samples.push({
        data: new Uint8Array([g, k]),
        dts: (g * 8 + k) * DUR,
        cts: (g * 8 + GOP_PRESENT[k]! + 2) * DUR,
        isKey: k === 0,
        duration: DUR,
      });
    }
  }
  return { codec: 'avc1.4d400a', codedWidth: 64, codedHeight: 48, timescale: TS, description: new Uint8Array([1, 77]), samples };
}

interface FakeFrame extends DecodedFrameLike {
  closed: boolean;
}

function makeFakeIO(opts: { errorOnDecode?: () => boolean } = {}) {
  const feeds: EncodedChunkInit[][] = []; // per decoder session
  const configs: object[] = [];
  const framesMade: FakeFrame[] = [];
  let decodersBuilt = 0;

  const io: DecoderIO = {
    createDecoder(config, handlers) {
      decodersBuilt++;
      configs.push(config);
      feeds.push([]);
      const mine = feeds[feeds.length - 1]!;
      let pending: EncodedChunkInit[] = [];
      return {
        decode(chunk) {
          const c = chunk as EncodedChunkInit;
          mine.push(c);
          if (opts.errorOnDecode?.()) {
            handlers.error(new Error('bitstream error'));
            return;
          }
          pending.push(c);
        },
        async flush() {
          // Real decoders emit in presentation order once flushed.
          const sorted = [...pending].sort((a, b) => a.timestamp - b.timestamp);
          pending = [];
          for (const c of sorted) {
            const f: FakeFrame = {
              timestamp: c.timestamp,
              closed: false,
              close() { this.closed = true; },
            };
            framesMade.push(f);
            handlers.output(f);
          }
        },
        close() { /* nothing to release */ },
      };
    },
    createChunk: (init) => init,
  };
  return { io, feeds, configs, framesMade, decoders: () => decodersBuilt };
}

const frameUs = (i: number): number => Math.round((i * 1e6) / 30);

describe('ExactVideoSource', () => {
  it('feeds exactly [key .. feed-through] in decode order, key chunk first', async () => {
    const { io, feeds } = makeFakeIO();
    const src = new ExactVideoSource(demuxed(), io);
    const f = await src.frameAt(1); // pres 1 = decode 2; needs dec 0..2
    expect(f.timestamp).toBe(frameUs(1));
    const fed = feeds[0]!;
    expect(fed).toHaveLength(3);
    expect(fed[0]!.type).toBe('key');
    expect(fed.slice(1).every((c) => c.type === 'delta')).toBe(true);
    // Decode order carries the B-frame reorder: timestamps are pres 0, 3, 1.
    expect(fed.map((c) => c.timestamp)).toEqual([frameUs(0), frameUs(3), frameUs(1)]);
    src.close();
  });

  it('caches every frame the flush emitted — stepping forward is free', async () => {
    const { io, feeds } = makeFakeIO();
    const src = new ExactVideoSource(demuxed(), io);
    await src.frameAt(3); // feeds dec 0..3, emits pres 0..3
    const fedAfterFirst = feeds[0]!.length;
    const f0 = await src.frameAt(0);
    const f2 = await src.frameAt(2);
    expect(f0.timestamp).toBe(frameUs(0));
    expect(f2.timestamp).toBe(frameUs(2));
    expect(feeds[0]!).toHaveLength(fedAfterFirst); // no new chunks fed
    src.close();
  });

  it('a backward seek to an earlier GOP re-feeds from THAT keyframe', async () => {
    const { io, feeds } = makeFakeIO();
    const src = new ExactVideoSource(demuxed(), io);
    await src.frameAt(17); // GOP 3 (decode 16..)
    const before = feeds[0]!.length;
    const f = await src.frameAt(9); // GOP 2: key at decode 8
    expect(f.timestamp).toBe(frameUs(9));
    expect(feeds[0]![before]!.type).toBe('key');
    expect(feeds[0]![before]!.timestamp).toBe(frameUs(8));
    src.close();
  });

  it('eviction closes dropped frames but never the frame being served', async () => {
    const { io, framesMade } = makeFakeIO();
    const src = new ExactVideoSource(demuxed(), io, /* maxCached */ 4);
    const f7 = await src.frameAt(7); // whole GOP: 8 frames emitted, budget 4
    expect((f7 as FakeFrame).closed).toBe(false);
    const closedCount = framesMade.filter((f) => f.closed).length;
    expect(closedCount).toBe(4); // 8 made, 4 kept
    src.close();
    expect(framesMade.every((f) => f.closed)).toBe(true);
  });

  it('a decoder error rejects that request and the NEXT one gets a fresh decoder', async () => {
    let failing = true;
    const { io, decoders } = makeFakeIO({ errorOnDecode: () => failing });
    const src = new ExactVideoSource(demuxed(), io);
    await expect(src.frameAt(0)).rejects.toThrow('bitstream error');
    failing = false;
    const f = await src.frameAt(0);
    expect(f.timestamp).toBe(frameUs(0));
    expect(decoders()).toBe(2);
    src.close();
  });

  it('serializes concurrent requests — a decoder is one machine, not a pool', async () => {
    const { io, feeds } = makeFakeIO();
    const src = new ExactVideoSource(demuxed(), io);
    const [a, b] = await Promise.all([src.frameAt(1), src.frameAt(9)]);
    expect(a.timestamp).toBe(frameUs(1));
    expect(b.timestamp).toBe(frameUs(9));
    // The two feed bursts must not interleave: all of GOP1's chunks precede
    // all of GOP2's.
    const keyIdxs = feeds[0]!.map((c, i) => (c.type === 'key' ? i : -1)).filter((i) => i >= 0);
    expect(keyIdxs[0]).toBe(0);
    expect(feeds[0]!.slice(0, keyIdxs[1]).every((c) => c.timestamp < frameUs(8))).toBe(true);
    src.close();
  });

  it('clamps out-of-range requests to the clip', async () => {
    const { io } = makeFakeIO();
    const src = new ExactVideoSource(demuxed(), io);
    expect((await src.frameAt(-5)).timestamp).toBe(frameUs(0));
    expect((await src.frameAt(999)).timestamp).toBe(frameUs(23));
    src.close();
  });

  it('exposes the index arithmetic for transports', () => {
    const { io } = makeFakeIO();
    const src = new ExactVideoSource(demuxed(), io);
    expect(src.frameCount).toBe(24);
    expect(src.durationUs).toBe(800_000);
    expect(src.timeUsOf(10)).toBe(frameUs(10));
    expect(src.frameIndexAt(frameUs(10) + 10)).toBe(10);
    src.close();
  });

  it('webCodecsAvailable is false where there is no WebCodecs (here)', () => {
    expect(webCodecsAvailable()).toBe(false);
  });
});

/**
 * Incremental fake for the streaming reader: unlike the flush-only fake
 * above, this emits during decode the way real decoders do — holding a small
 * reorder window (3 frames), releasing in ascending presentation order, and
 * draining on flush. The reader depends on incremental emission (it only
 * flushes once, at end of stream), so this is the decoder behaviour to fake.
 */
function makeStreamingFakeIO() {
  const feeds: EncodedChunkInit[][] = [];
  let decodersBuilt = 0;
  const io: DecoderIO = {
    createDecoder(_config, handlers) {
      decodersBuilt++;
      feeds.push([]);
      const mine = feeds[feeds.length - 1]!;
      let held: EncodedChunkInit[] = [];
      const emit = (c: EncodedChunkInit): void => {
        const f: FakeFrame = {
          timestamp: c.timestamp,
          closed: false,
          close() { this.closed = true; },
        };
        handlers.output(f);
      };
      return {
        decode(chunk) {
          const c = chunk as EncodedChunkInit;
          mine.push(c);
          held.push(c);
          held.sort((a, b) => a.timestamp - b.timestamp);
          while (held.length > 3) emit(held.shift()!);
        },
        async flush() {
          for (const c of held) emit(c);
          held = [];
        },
        close() { /* nothing */ },
      };
    },
    createChunk: (init) => init,
  };
  return { io, feeds, decoders: () => decodersBuilt };
}

describe('SequentialFrameReader', () => {
  it('feeds each sample exactly once for the whole walk, in decode order', async () => {
    const { io, feeds, decoders } = makeStreamingFakeIO();
    const reader = new SequentialFrameReader(demuxed(), 0, 23, io);
    for (let i = 0; i <= 23; i++) {
      const f = await reader.frameAt(i);
      expect(f.timestamp).toBe(frameUs(i));
    }
    reader.close();
    expect(decoders()).toBe(1);
    // 24 samples, one decode() each — the whole point vs frameAt's prefixes.
    expect(feeds[0]!.length).toBe(24);
    const seen = new Set(feeds[0]!.map((c) => c.timestamp));
    expect(seen.size).toBe(24);
  });

  it('starts mid-stream at the GOP key', async () => {
    const { io, feeds } = makeStreamingFakeIO();
    const reader = new SequentialFrameReader(demuxed(), 9, 15, io);
    const f = await reader.frameAt(9);
    expect(f.timestamp).toBe(frameUs(9));
    expect(feeds[0]![0]!.type).toBe('key');
    expect(feeds[0]![0]!.timestamp).toBe(frameUs(8)); // GOP 2's key frame
    reader.close();
  });

  it('closes the previous frame on the next request, and skipped frames outright', async () => {
    const { io } = makeStreamingFakeIO();
    const reader = new SequentialFrameReader(demuxed(), 0, 23, io);
    const f0 = (await reader.frameAt(0)) as FakeFrame;
    // Duplicate request: same frame back, still open.
    expect(await reader.frameAt(0)).toBe(f0);
    expect(f0.closed).toBe(false);
    const f5 = (await reader.frameAt(5)) as FakeFrame; // skips 1..4
    expect(f0.closed).toBe(true);
    expect(f5.closed).toBe(false);
    reader.close();
    expect(f5.closed).toBe(true);
  });

  it('rejects decreasing requests instead of silently rewinding', async () => {
    const { io } = makeStreamingFakeIO();
    const reader = new SequentialFrameReader(demuxed(), 0, 23, io);
    await reader.frameAt(6);
    await expect(reader.frameAt(3)).rejects.toThrow(/non-decreasing/);
    reader.close();
  });

  it('drains the tail through the single end-of-stream flush', async () => {
    const { io } = makeStreamingFakeIO();
    const reader = new SequentialFrameReader(demuxed(), 20, 23, io);
    // The last frames sit inside the fake's reorder hold until flush.
    for (let i = 20; i <= 23; i++) {
      expect((await reader.frameAt(i)).timestamp).toBe(frameUs(i));
    }
    reader.close();
  });
});
