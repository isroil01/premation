/**
 * Minimal Matroska/WebM muxer — pure bytes in, one WebM file out.
 *
 * This exists so the browser build can produce a REAL video file from WebCodecs
 * output. The alternative, `MediaRecorder` on a captured canvas, was the source
 * of the "exported video is a black screen" bug: it is paced by wall-clock, drops
 * or never captures frames from an off-screen canvas, and when it captures
 * nothing it still resolves successfully with a ~110-byte header-only file that
 * every player either refuses to open or shows as black. There is no way to ask
 * it how many frames it actually encoded.
 *
 * WebCodecs + this muxer is deterministic instead: exactly one encoded chunk per
 * rendered frame, timestamps derived from the frame index, and a frame count the
 * caller can assert on.
 *
 * Scope is deliberately narrow — progressive (non-live) files with one video
 * track and at most one Opus audio track, all sizes known up front because the
 * whole render is muxed at once. No lacing, no BlockGroups, no chapters.
 *
 * Reference: https://www.matroska.org/technical/elements.html
 */

// ── EBML primitives ──────────────────────────────────────────────────

/** Element IDs, already in their on-the-wire (class-prefixed) form. */
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,

  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,

  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  Language: 0x22b59c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  Range: 0x55b9,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,

  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,

  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

/**
 * One tick = 100µs (TimestampScale is measured in nanoseconds).
 *
 * This was 1ms, which quantised every block timestamp to the millisecond: at
 * 23.976/29.97/59.94 fps the true frame times land BETWEEN milliseconds, so
 * each frame carried up to ±0.5ms of jitter and A/V sync drifted audibly
 * against the sample-exact Opus track over long exports. 100µs represents
 * every WebCodecs timestamp this muxer is handed exactly enough (frame times
 * are themselves rounded to 1µs from the index), while int16 cluster-relative
 * times still span ±3.27s.
 */
const TIMESTAMP_SCALE_NS = 100_000;

/** Microseconds (WebCodecs' unit) → timestamp-scale ticks. */
const toTicks = (us: number): number => Math.round(us / 100);

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

/** An element id as its raw big-endian bytes (leading zero bytes stripped). */
export function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  let started = false;
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (id >>> shift) & 0xff;
    if (byte !== 0 || started) {
      out.push(byte);
      started = true;
    }
  }
  return new Uint8Array(out.length ? out : [0]);
}

/**
 * EBML variable-length integer. Width is the smallest that fits: `width` bytes
 * carry `7 * width` value bits behind a leading marker bit.
 */
export function vint(value: number): Uint8Array {
  if (value < 0) throw new Error(`vint: negative value ${value}`);
  let width = 1;
  while (width <= 8 && value >= 2 ** (7 * width) - 1) width++;
  if (width > 8) throw new Error(`vint: value too large (${value})`);

  const out = new Uint8Array(width);
  // The marker bit sits immediately above the value bits.
  let remaining = value + (width < 8 ? 2 ** (7 * width) : 0);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (width === 8) out[0]! |= 0x01; // 2**56 overflows a JS float's integer range
  return out;
}

/** Big-endian unsigned integer in as few bytes as possible (min 1). */
export function uintBytes(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = Math.max(0, Math.round(value));
  do {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return new Uint8Array(bytes);
}

function f64Bytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

function strBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `id + size + payload`, the only shape every Matroska element takes. */
export function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), vint(payload.length), payload]);
}

const uintEl = (id: number, v: number): Uint8Array => element(id, uintBytes(v));
const strEl = (id: number, v: string): Uint8Array => element(id, strBytes(v));
const floatEl = (id: number, v: number): Uint8Array => element(id, f64Bytes(v));

// ── Muxer ────────────────────────────────────────────────────────────

export type WebmVideoCodec = 'vp8' | 'vp9' | 'av1';

export interface WebmVideoTrack {
  codec: WebmVideoCodec;
  width: number;
  height: number;
  /** Frames per second — written as DefaultDuration so players report the rate. */
  fps: number;
  /** Codec-private data. Required for AV1, unused by VP8/VP9. */
  description?: Uint8Array;
}

export interface WebmAudioTrack {
  /** Opus is the only audio codec WebM players are guaranteed to support. */
  sampleRate: number;
  channels: number;
  /** The OpusHead blob from `AudioEncoder`'s decoderConfig.description. */
  description: Uint8Array;
}

/** One encoded frame, ready to become a SimpleBlock. */
export interface WebmSample {
  /** Presentation time in MICROseconds (WebCodecs' unit). */
  timestampUs: number;
  keyFrame: boolean;
  data: Uint8Array;
}

const MATROSKA_CODEC_ID: Record<WebmVideoCodec, string> = {
  vp8: 'V_VP8',
  vp9: 'V_VP9',
  av1: 'V_AV1',
};

/**
 * A SimpleBlock: track vint, int16 timestamp relative to its cluster (in
 * timestamp-scale ticks), flags, then the frame. Relative timestamps are why
 * clusters exist at all — 16 bits only spans ±32767 ticks (±3.27s at 100µs).
 */
function simpleBlock(track: number, relativeTicks: number, keyFrame: boolean, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(3);
  new DataView(header.buffer).setInt16(0, relativeTicks, false);
  header[2] = keyFrame ? 0x80 : 0x00;
  return element(ID.SimpleBlock, concat([vint(track), header, data]));
}

/** Longest span of one cluster, in ticks (3s). Inside the int16 ±32767 limit. */
const MAX_CLUSTER_TICKS = 30_000;

interface PendingBlock {
  track: number;
  ticks: number;
  keyFrame: boolean;
  data: Uint8Array;
}

/**
 * Mux encoded samples into a complete WebM file.
 *
 * Throws when there are no video samples: a zero-frame video file is the exact
 * failure this whole module replaced, so it must never be produced silently.
 */
export function muxWebm(
  video: WebmVideoTrack,
  videoSamples: ReadonlyArray<WebmSample>,
  audio?: { track: WebmAudioTrack; samples: ReadonlyArray<WebmSample> },
): Uint8Array {
  if (videoSamples.length === 0) {
    throw new Error('muxWebm: no video samples — refusing to write an empty file.');
  }

  const header = element(
    ID.EBML,
    concat([
      uintEl(ID.EBMLVersion, 1),
      uintEl(ID.EBMLReadVersion, 1),
      uintEl(ID.EBMLMaxIDLength, 4),
      uintEl(ID.EBMLMaxSizeLength, 8),
      strEl(ID.DocType, 'webm'),
      uintEl(ID.DocTypeVersion, 2),
      uintEl(ID.DocTypeReadVersion, 2),
    ]),
  );

  const lastUs = videoSamples[videoSamples.length - 1]!.timestampUs;
  // Duration is in TimestampScale units: last frame's start plus one frame.
  const durationTicks = toTicks(lastUs + 1e6 / Math.max(1, video.fps));

  const info = element(
    ID.Info,
    concat([
      uintEl(ID.TimestampScale, TIMESTAMP_SCALE_NS),
      strEl(ID.MuxingApp, 'Premation'),
      strEl(ID.WritingApp, 'Premation'),
      floatEl(ID.Duration, durationTicks),
    ]),
  );

  const videoEntry = element(
    ID.TrackEntry,
    concat([
      uintEl(ID.TrackNumber, VIDEO_TRACK),
      uintEl(ID.TrackUID, VIDEO_TRACK),
      uintEl(ID.TrackType, 1),
      uintEl(ID.FlagLacing, 0),
      strEl(ID.Language, 'und'),
      strEl(ID.CodecID, MATROSKA_CODEC_ID[video.codec]),
      ...(video.description ? [element(ID.CodecPrivate, video.description)] : []),
      uintEl(ID.DefaultDuration, Math.round(1e9 / Math.max(1, video.fps))),
      element(
        ID.Video,
        concat([
          uintEl(ID.PixelWidth, video.width),
          uintEl(ID.PixelHeight, video.height),
          // BT.709 limited range — what Chromium's VideoEncoder actually
          // produces from an RGB canvas. Without the Colour element players
          // guess (often BT.601), which visibly shifts reds and greens on the
          // exact same file across players.
          element(
            ID.Colour,
            concat([
              uintEl(ID.MatrixCoefficients, 1),
              uintEl(ID.Primaries, 1),
              uintEl(ID.TransferCharacteristics, 1),
              uintEl(ID.Range, 1),
            ]),
          ),
        ]),
      ),
    ]),
  );

  const audioEntry = audio
    ? element(
        ID.TrackEntry,
        concat([
          uintEl(ID.TrackNumber, AUDIO_TRACK),
          uintEl(ID.TrackUID, AUDIO_TRACK),
          uintEl(ID.TrackType, 2),
          uintEl(ID.FlagLacing, 0),
          strEl(ID.Language, 'und'),
          strEl(ID.CodecID, 'A_OPUS'),
          element(ID.CodecPrivate, audio.track.description),
          element(
            ID.Audio,
            concat([
              floatEl(ID.SamplingFrequency, audio.track.sampleRate),
              uintEl(ID.Channels, audio.track.channels),
            ]),
          ),
        ]),
      )
    : null;

  const tracks = element(ID.Tracks, concat(audioEntry ? [videoEntry, audioEntry] : [videoEntry]));

  // Interleave both tracks in presentation order; a player reads blocks
  // sequentially, so out-of-order audio would stall playback.
  const blocks: PendingBlock[] = videoSamples.map((s) => ({
    track: VIDEO_TRACK,
    ticks: toTicks(s.timestampUs),
    keyFrame: s.keyFrame,
    data: s.data,
  }));
  if (audio) {
    for (const s of audio.samples) {
      blocks.push({ track: AUDIO_TRACK, ticks: toTicks(s.timestampUs), keyFrame: true, data: s.data });
    }
    blocks.sort((a, b) => a.ticks - b.ticks || a.track - b.track);
  }

  // Clusters break on video keyframes so every cluster is independently
  // decodable, and on MAX_CLUSTER_TICKS so relative timestamps stay in int16.
  const clusters: Array<{ timeTicks: number; bytes: Uint8Array }> = [];
  let current: PendingBlock[] = [];
  let clusterStart = blocks[0]!.ticks;

  const flush = (): void => {
    if (current.length === 0) return;
    const payload = concat([
      uintEl(ID.Timestamp, clusterStart),
      ...current.map((b) => simpleBlock(b.track, b.ticks - clusterStart, b.keyFrame, b.data)),
    ]);
    clusters.push({ timeTicks: clusterStart, bytes: element(ID.Cluster, payload) });
    current = [];
  };

  for (const b of blocks) {
    const wouldSpanTooLong = b.ticks - clusterStart >= MAX_CLUSTER_TICKS;
    const startsNewCluster = b.track === VIDEO_TRACK && b.keyFrame && current.length > 0;
    if (wouldSpanTooLong || startsNewCluster) {
      flush();
      clusterStart = b.ticks;
    }
    current.push(b);
  }
  flush();

  // Cues make the file seekable. Positions are byte offsets from the start of
  // the Segment's payload, so they are known only once the preceding elements
  // have their final sizes — hence this two-step layout.
  const segmentPrefixLength = info.length + tracks.length;
  const cuePoints: Uint8Array[] = [];
  let clusterOffset = segmentPrefixLength;
  for (const c of clusters) {
    cuePoints.push(
      element(
        ID.CuePoint,
        concat([
          uintEl(ID.CueTime, c.timeTicks),
          element(
            ID.CueTrackPositions,
            concat([uintEl(ID.CueTrack, VIDEO_TRACK), uintEl(ID.CueClusterPosition, clusterOffset)]),
          ),
        ]),
      ),
    );
    clusterOffset += c.bytes.length;
  }
  const cues = element(ID.Cues, concat(cuePoints));

  const segment = element(
    ID.Segment,
    concat([info, tracks, ...clusters.map((c) => c.bytes), cues]),
  );

  return concat([header, segment]);
}
