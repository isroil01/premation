/**
 * MP4 demuxing for the exact decode path — the container half of the "real
 * decoder" that videoFrameCache.ts spent its header explaining it was not.
 *
 * mp4box.js is the demuxer. It is pure JavaScript — no WASM, so the CSP
 * objection that ruled out Rapier for physics does not apply, and the same
 * fact is why THIS file's behaviour is pinned by jest tests against real
 * ffmpeg-encoded fixtures instead of by faith: the whole demux runs in Node.
 *
 * What comes out is exactly what `VideoDecoder.configure` + `decode` need and
 * nothing else: the WebCodecs codec string the track advertises, the
 * codec-private description (avcC/hvcC/… payload with the 8-byte box header
 * stripped — configure wants the box CONTENTS, not the box), and the sample
 * table in decode order with the fields frameIndex.ts turns into random
 * access.
 *
 * KNOWN LIMITS, on purpose:
 *  • The whole file is demuxed from one in-memory buffer. mp4box can stream,
 *    but the first consumer is the footage preview stepping through frames,
 *    and "the file you are previewing fits in memory" is the same contract
 *    the import path already makes when it copies the clip into the project.
 *  • The first video track wins. Multi-track footage is rare enough that
 *    picking is a UI question to answer when someone actually has one.
 *  • Edit lists are not applied beyond what cts normalization does (see
 *    frameIndex.ts) — a container trimmed via elst will show its media, not
 *    its trim. ffprobe-driven duration already has the same posture.
 */

import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample } from 'mp4box';

export interface DemuxedSample {
  /** Encoded bytes, AVCC/length-prefixed as stored — NOT Annex B. */
  data: Uint8Array;
  dts: number;
  cts: number;
  isKey: boolean;
  /** In `timescale` units, like cts/dts. */
  duration: number;
}

export interface DemuxedVideo {
  /** WebCodecs codec string, e.g. "avc1.4d400a". */
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** Units-per-second for dts/cts/duration. */
  timescale: number;
  /** avcC/hvcC/vpcC payload for `VideoDecoderConfig.description`, or null for
   *  codecs that carry their config in-band (AV1, VP8). */
  description: Uint8Array | null;
  /** Decode order. */
  samples: DemuxedSample[];
  /**
   * Display rotation from the container (tkhd matrix), clockwise degrees.
   * `VideoDecoder` output is UNROTATED — `HTMLVideoElement` applies this
   * automatically, so consumers of decoded frames must apply it themselves or
   * phone-shot portrait footage renders sideways on the exact tier only.
   */
  rotation?: 0 | 90 | 180 | 270;
}

/** A box that can serialize itself — the shape shared by avcC/hvcC/vpcC. */
interface WritableBox {
  write(stream: DataStream): void;
}

/** The stsd entry fields we go looking for. mp4box types the entry as a broad
 *  union; the codec-config boxes are only present on the matching codec. */
interface ConfigCarryingEntry {
  avcC?: WritableBox;
  hvcC?: WritableBox;
  vpcC?: WritableBox;
  av1C?: WritableBox;
}

/**
 * Display rotation from a tkhd/track matrix (9 values, 16.16 fixed-point for
 * the 2×2 part). Only the four axis-aligned rotations exist in practice —
 * anything else (skew, flip) is treated as unrotated rather than guessed at.
 */
function rotationOf(matrix: unknown): 0 | 90 | 180 | 270 {
  const m = matrix as ArrayLike<number> | null | undefined;
  if (!m || typeof m.length !== 'number' || m.length < 5) return 0;
  const a = (m[0] ?? 0) / 65536;
  const b = (m[1] ?? 0) / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const norm = ((deg % 360) + 360) % 360;
  return norm === 90 || norm === 180 || norm === 270 ? norm : 0;
}

/** Serialize a codec-config box and strip its 8-byte header: configure()
 *  wants the contents (for avcC, the AVCDecoderConfigurationRecord starting
 *  with version 0x01), not the framed box. */
function descriptionOf(entry: ConfigCarryingEntry): Uint8Array | null {
  const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? null;
  if (!box) return null;
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  const end = stream.getPosition();
  if (end <= 8) return null;
  return new Uint8Array(stream.buffer.slice(8, end));
}

/**
 * Demux one whole MP4. Resolves once every sample of the first video track is
 * extracted; rejects for parse errors, missing video track, or a truncated
 * table — an INCOMPLETE demux must fail loudly, because an index built over
 * half a sample table produces frame numbers that lie.
 */
export function demuxMp4(data: ArrayBuffer): Promise<DemuxedVideo> {
  return new Promise<DemuxedVideo>((resolve, reject) => {
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    const file = createFile();
    const collected: Sample[] = [];
    let expected = -1;
    let result: Omit<DemuxedVideo, 'samples'> | null = null;

    file.onError = (module: string, message: string) => fail(`mp4 demux failed: ${module}: ${message}`);

    file.onReady = (info) => {
      const track = info.videoTracks[0];
      if (!track) {
        fail('mp4 demux failed: no video track');
        return;
      }
      expected = track.nb_samples;
      const trak = file.getTrackById(track.id);
      const entry = (trak?.mdia?.minf?.stbl?.stsd?.entries?.[0] ?? {}) as ConfigCarryingEntry;
      const matrix =
        (track as unknown as { matrix?: ArrayLike<number> }).matrix
        ?? (trak as unknown as { tkhd?: { matrix?: ArrayLike<number> } } | null)?.tkhd?.matrix;
      result = {
        codec: track.codec,
        codedWidth: track.video?.width ?? track.track_width,
        codedHeight: track.video?.height ?? track.track_height,
        timescale: track.timescale,
        description: descriptionOf(entry),
        rotation: rotationOf(matrix),
      };
      file.setExtractionOptions(track.id, undefined, { nbSamples: Math.max(1, expected) });
      file.start();
    };

    file.onSamples = (_id, _user, samples) => {
      collected.push(...samples);
    };

    try {
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data, 0), true);
      file.flush();
    } catch (e) {
      fail(`mp4 demux failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // mp4box's callbacks fire synchronously off appendBuffer/flush for a
    // complete buffer, so by here the table is either whole or it never will
    // be — there is no more input coming.
    if (settled) return;
    // The cast undoes flow analysis, not adds a claim: `result` is assigned
    // inside onReady, which TS's narrowing treats as never-ran and so calls
    // the variable still-null here.
    const header = result as Omit<DemuxedVideo, 'samples'> | null;
    if (!header) {
      fail('mp4 demux failed: file never became ready (not an MP4?)');
      return;
    }
    if (collected.length < expected) {
      fail(`mp4 demux failed: extracted ${collected.length} of ${expected} samples`);
      return;
    }
    settled = true;
    resolve({
      codec: header.codec,
      codedWidth: header.codedWidth,
      codedHeight: header.codedHeight,
      timescale: header.timescale,
      description: header.description,
      ...(header.rotation ? { rotation: header.rotation } : {}),
      samples: collected.map((s) => ({
        data: s.data ?? new Uint8Array(0),
        dts: s.dts,
        cts: s.cts,
        isKey: s.is_sync === true,
        duration: s.duration,
      })),
    });
  });
}
