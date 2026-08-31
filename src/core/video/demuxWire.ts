/**
 * The wire format between the demux worker and its client.
 *
 * Its own module because both sides must agree on it and neither should import
 * the other — and because the interesting decision lives here rather than in
 * either endpoint.
 *
 * ## Why samples are flattened rather than posted as they are
 *
 * `DemuxedVideo.samples` is an array of `Uint8Array` views, and together those
 * views ARE the whole file. Posting that array back structured-CLONES every one
 * of them: a second full copy of a 300 MB file at the boundary, on the main
 * thread, to fix a stall on the main thread.
 *
 * So the worker packs every sample's bytes end to end into ONE `ArrayBuffer`
 * and sends offsets alongside. That buffer is TRANSFERRED — zero copy, and the
 * worker's own reference is detached — and the client rebuilds the views over
 * it. The result is byte-identical to what the pure demuxer returns; the views
 * simply share one backing store instead of being independently allocated.
 *
 * Explicit offsets rather than relying on transferring a buffer that cloned
 * views happen to reference. That behaviour is specified, and it is also the
 * kind of thing that is easy to get subtly wrong and impossible to notice
 * (a view silently re-pointing at the wrong offset produces frames that decode
 * to garbage rather than an error). Offsets are checkable.
 */

import type { DemuxedSample, DemuxedVideo } from './mp4Demuxer';

/** One sample, minus its bytes — those live in the shared buffer. */
export interface WireSample {
  dts: number;
  cts: number;
  isKey: boolean;
  duration: number;
  /** Byte offset into the packed buffer. */
  offset: number;
  length: number;
}

/** A demux result in transferable form. */
export interface WireDemux {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  timescale: number;
  /** Copied out rather than referenced: it is a few dozen bytes and keeping it
   *  separate means the packed buffer holds nothing but sample payloads. */
  description: Uint8Array | null;
  rotation?: 0 | 90 | 180 | 270;
  hasAlpha?: boolean;
  samples: WireSample[];
  /** Every sample's bytes, end to end. Transferred. */
  bytes: ArrayBuffer;
}

/** Pack a demux result for the wire. Returns the buffer to transfer. */
export function toWire(d: DemuxedVideo & { hasAlpha?: boolean }): WireDemux {
  let total = 0;
  for (const s of d.samples) total += s.data.byteLength;
  const packed = new Uint8Array(total);
  const samples: WireSample[] = [];
  let offset = 0;
  for (const s of d.samples) {
    packed.set(s.data, offset);
    samples.push({
      dts: s.dts, cts: s.cts, isKey: s.isKey, duration: s.duration,
      offset, length: s.data.byteLength,
    });
    offset += s.data.byteLength;
  }
  return {
    codec: d.codec,
    codedWidth: d.codedWidth,
    codedHeight: d.codedHeight,
    timescale: d.timescale,
    // A fresh copy, so the description does not keep the source file's whole
    // buffer alive through a view into it.
    description: d.description ? new Uint8Array(d.description) : null,
    ...(d.rotation !== undefined ? { rotation: d.rotation } : {}),
    ...(d.hasAlpha !== undefined ? { hasAlpha: d.hasAlpha } : {}),
    samples,
    bytes: packed.buffer,
  };
}

/** Rebuild the demux result from the wire. Views share the packed buffer. */
export function fromWire(w: WireDemux): DemuxedVideo & { hasAlpha?: boolean } {
  const bytes = new Uint8Array(w.bytes);
  const samples: DemuxedSample[] = w.samples.map((s) => ({
    data: bytes.subarray(s.offset, s.offset + s.length),
    dts: s.dts,
    cts: s.cts,
    isKey: s.isKey,
    duration: s.duration,
  }));
  return {
    codec: w.codec,
    codedWidth: w.codedWidth,
    codedHeight: w.codedHeight,
    timescale: w.timescale,
    description: w.description,
    ...(w.rotation !== undefined ? { rotation: w.rotation } : {}),
    ...(w.hasAlpha !== undefined ? { hasAlpha: w.hasAlpha } : {}),
    samples,
  };
}
