/**
 * Minimal WebM (Matroska) demux for the exact-frame path.
 *
 * Same {@link DemuxedVideo} contract as mp4Demuxer — WebCodecs VP8/VP9.
 * Alpha WebM: when `AlphaMode=1` and BlockAdditional (AddID=1) carries the
 * alpha plane, samples expose `alphaData` for a dual-decode composite. Opaque
 * tracks stay single-plane.
 *
 * EBML subset: Segment → Info (TimestampScale) → Tracks → Clusters with
 * SimpleBlock / BlockGroup (+ BlockAdditions). Enough for ffmpeg-encoded WebM
 * proxies and common VP9 uploads; not a full Matroska library.
 */

import type { DemuxedSample, DemuxedVideo } from './mp4Demuxer';

/** EBML element IDs we care about (big-endian). */
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  AlphaMode: 0x53c0,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAddID: 0xee,
  BlockAdditional: 0xa5,
} as const;

class EbmlReader {
  constructor(readonly bytes: Uint8Array, public pos = 0) {}

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  /** Variable-size EBML integer (VINT). Returns value + width in bytes. */
  readVint(): { value: number; width: number } | null {
    if (this.pos >= this.bytes.length) return null;
    const first = this.bytes[this.pos]!;
    let width = 1;
    let mask = 0x80;
    while (width <= 8 && (first & mask) === 0) {
      width++;
      mask >>= 1;
    }
    if (width > 8 || this.pos + width > this.bytes.length) return null;
    let value = first & (mask - 1);
    for (let i = 1; i < width; i++) {
      value = (value << 8) | this.bytes[this.pos + i]!;
    }
    this.pos += width;
    return { value, width };
  }

  readId(): number | null {
    const start = this.pos;
    const v = this.readVint();
    if (!v) return null;
    let id = 0;
    for (let i = 0; i < v.width; i++) {
      id = (id << 8) | this.bytes[start + i]!;
    }
    return id;
  }

  readSize(): number | null {
    const v = this.readVint();
    return v ? v.value : null;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readUint(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 8) | this.bytes[this.pos++]!;
    return v;
  }

  skip(n: number): void {
    this.pos += n;
  }
}

function codecFromId(id: string): string | null {
  if (id === 'V_VP8') return 'vp8';
  if (id === 'V_VP9') return 'vp09.00.10.08';
  return null;
}

interface TrackInfo {
  number: number;
  codec: string;
  width: number;
  height: number;
  alphaMode: boolean;
}

export type DemuxedSampleWithAlpha = DemuxedSample & {
  /** Dual-plane alpha bitstream (BlockAdditional AddID=1), when present. */
  alphaData?: Uint8Array;
};

/**
 * Demux the first video track of a WebM buffer into the exact-path sample table.
 */
export async function demuxWebm(data: ArrayBuffer): Promise<DemuxedVideo & { hasAlpha?: boolean }> {
  const bytes = new Uint8Array(data);
  if (bytes.length < 4 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    throw new Error('not a WebM/Matroska file');
  }

  const r = new EbmlReader(bytes);
  let timestampScale = 1_000_000;
  let track: TrackInfo | null = null;
  const samples: DemuxedSampleWithAlpha[] = [];

  const parseBlockPayload = (
    payload: Uint8Array,
    clusterTs: number,
    alphaPlane: Uint8Array | null,
  ): void => {
    if (!track || payload.length < 4) return;
    const br = new EbmlReader(payload);
    const trackV = br.readVint();
    if (!trackV || trackV.value !== track.number) return;
    if (br.remaining < 3) return;
    const rel = (br.bytes[br.pos]! << 8) | br.bytes[br.pos + 1]!;
    br.pos += 2;
    const signedRel = rel > 0x7fff ? rel - 0x10000 : rel;
    const flags = br.bytes[br.pos++]!;
    const isKey = (flags & 0x80) !== 0;
    const frame = br.bytes.subarray(br.pos);
    if (frame.length === 0) return;
    const absTs = clusterTs + signedRel;
    const cts = Math.round((absTs * timestampScale) / 1000);
    const sample: DemuxedSampleWithAlpha = {
      data: frame.slice(),
      dts: cts,
      cts,
      isKey,
      duration: 0,
    };
    if (alphaPlane && alphaPlane.length > 0) sample.alphaData = alphaPlane.slice();
    samples.push(sample);
  };

  const parseBlockAdditions = (end: number): Uint8Array | null => {
    let alpha: Uint8Array | null = null;
    while (r.pos < end) {
      const id = r.readId();
      const size = r.readSize();
      if (id === null || size === null) break;
      const cEnd = r.pos + size;
      if (id === ID.BlockMore) {
        let addId = 1;
        let additional: Uint8Array | null = null;
        while (r.pos < cEnd) {
          const mid = r.readId();
          const msize = r.readSize();
          if (mid === null || msize === null) break;
          const mEnd = r.pos + msize;
          if (mid === ID.BlockAddID) addId = r.readUint(msize);
          else if (mid === ID.BlockAdditional) additional = r.readBytes(msize).slice();
          else r.pos = mEnd;
          r.pos = Math.max(r.pos, mEnd);
        }
        if (addId === 1 && additional) alpha = additional;
      } else {
        r.pos = cEnd;
      }
    }
    return alpha;
  };

  const walk = (end: number, clusterTs = 0): void => {
    while (r.pos < end) {
      const idStart = r.pos;
      const id = r.readId();
      const size = r.readSize();
      if (id === null || size === null) break;
      if (size < 0 || r.pos + size > bytes.length) break;
      const contentEnd = r.pos + size;

      if (id === ID.TimestampScale) {
        timestampScale = r.readUint(size);
        r.pos = contentEnd;
      } else if (id === ID.Info || id === ID.Tracks || id === ID.TrackEntry || id === ID.Video
        || id === ID.Segment || id === ID.Cluster || id === ID.BlockGroup) {
        if (id === ID.Cluster) {
          let localTs = 0;
          const clusterEnd = contentEnd;
          while (r.pos < clusterEnd) {
            const cid = r.readId();
            const csize = r.readSize();
            if (cid === null || csize === null) break;
            const cEnd = r.pos + csize;
            if (cid === ID.Timestamp) {
              localTs = r.readUint(csize);
              r.pos = cEnd;
            } else if (cid === ID.SimpleBlock) {
              parseBlockPayload(r.readBytes(csize), localTs, null);
            } else if (cid === ID.BlockGroup) {
              walk(cEnd, localTs);
            } else {
              r.pos = cEnd;
            }
          }
          r.pos = contentEnd;
        } else if (id === ID.BlockGroup) {
          let blockPayload: Uint8Array | null = null;
          let alphaPlane: Uint8Array | null = null;
          const groupEnd = contentEnd;
          while (r.pos < groupEnd) {
            const gid = r.readId();
            const gsize = r.readSize();
            if (gid === null || gsize === null) break;
            const gEnd = r.pos + gsize;
            if (gid === ID.Block) {
              blockPayload = r.readBytes(gsize);
            } else if (gid === ID.BlockAdditions) {
              alphaPlane = parseBlockAdditions(gEnd);
            } else {
              r.pos = gEnd;
            }
            r.pos = Math.max(r.pos, gEnd);
          }
          if (blockPayload) parseBlockPayload(blockPayload, clusterTs, alphaPlane);
          r.pos = contentEnd;
        } else if (id === ID.TrackEntry) {
          let num = 0;
          let type = 0;
          let codecId = '';
          let width = 0;
          let height = 0;
          let alphaMode = false;
          while (r.pos < contentEnd) {
            const tid = r.readId();
            const tsize = r.readSize();
            if (tid === null || tsize === null) break;
            const tEnd = r.pos + tsize;
            if (tid === ID.TrackNumber) num = r.readUint(tsize);
            else if (tid === ID.TrackType) type = r.readUint(tsize);
            else if (tid === ID.CodecID) {
              codecId = new TextDecoder().decode(r.readBytes(tsize));
            } else if (tid === ID.Video) {
              const vEnd = tEnd;
              while (r.pos < vEnd) {
                const vid = r.readId();
                const vsize = r.readSize();
                if (vid === null || vsize === null) break;
                const ve = r.pos + vsize;
                if (vid === ID.PixelWidth) width = r.readUint(vsize);
                else if (vid === ID.PixelHeight) height = r.readUint(vsize);
                else if (vid === ID.AlphaMode) alphaMode = r.readUint(vsize) !== 0;
                else r.pos = ve;
              }
            } else {
              r.pos = tEnd;
            }
            r.pos = Math.max(r.pos, tEnd);
          }
          if (type === 1 && !track) {
            const codec = codecFromId(codecId.trim());
            if (codec && width > 0 && height > 0) {
              track = { number: num, codec, width, height, alphaMode };
            }
          }
          r.pos = contentEnd;
        } else {
          walk(contentEnd, clusterTs);
          r.pos = contentEnd;
        }
      } else if (id === ID.SimpleBlock) {
        parseBlockPayload(r.readBytes(size), clusterTs, null);
      } else if (id === ID.Block) {
        parseBlockPayload(r.readBytes(size), clusterTs, null);
      } else if (id === ID.EBML) {
        r.pos = contentEnd;
      } else {
        r.pos = contentEnd;
      }
      if (r.pos < idStart) break;
    }
  };

  walk(bytes.length);

  const found: TrackInfo | null = track as TrackInfo | null;
  if (!found) throw new Error('WebM: no VP8/VP9 video track found');
  if (samples.length === 0) throw new Error('WebM: no video samples');

  for (let i = 0; i < samples.length - 1; i++) {
    samples[i]!.duration = Math.max(1, samples[i + 1]!.cts - samples[i]!.cts);
  }
  if (samples.length > 0) {
    // The container carries no duration for the final block. Use the median of
    // what the stream actually ran at, not a hard-coded 30fps guess — a 24 or
    // 60fps clip would otherwise report a wrong total duration.
    const last = samples[samples.length - 1]!;
    const prior = samples.slice(0, -1).map((s) => s.duration).sort((a, b) => a - b);
    last.duration = prior.length > 0 ? prior[prior.length >> 1]! : Math.round(1_000_000 / 30);
  }

  const hasAlpha = found.alphaMode || samples.some((s) => !!s.alphaData);

  return {
    codec: found.codec,
    codedWidth: found.width,
    codedHeight: found.height,
    timescale: 1_000_000,
    // VP8/VP9 carry their configuration in-band; WebCodecs' registry says the
    // description must be ABSENT for them. Matroska CodecPrivate (when a muxer
    // writes one at all) is not a decoder config record — passing it through
    // made configure() reject on otherwise-decodable files.
    description: null,
    samples,
    hasAlpha,
  };
}

export function isWebmMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}
