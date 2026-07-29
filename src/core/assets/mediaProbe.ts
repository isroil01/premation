/**
 * Probing an imported file for what only a demuxer can tell us.
 *
 * Two facts the browser genuinely cannot supply, both of which the editor had
 * been guessing at:
 *
 *  - **Real frame rate.** Nothing in the browser reports a `<video>`'s rate, so
 *    frame blending bracketed on the COMPOSITION's rate instead. A 24fps source
 *    in a 30fps comp had both bracket times resolve to the same decoded frame
 *    and the blend silently collapsed to nearest-frame — for exactly the
 *    mismatched-rate case frame blending exists to fix.
 *  - **Whether there is an audio track at all.** `decodeAudioData` answers this
 *    only by throwing, at playback time, long after import. Deciding whether to
 *    show a layer's audio controls on "the decode failed eventually" is a much
 *    worse contract than asking the container.
 *
 * ## Degradation is explicit, and it is not only a web concern
 *
 * `resolveFfmpeg` in the main process falls back to bare `ffmpeg` on PATH and
 * may find nothing, so "no probe" is a real desktop state too, not a browser
 * special case. Three tiers, and every caller must handle all three:
 *
 * | tier | how | what is known |
 * |---|---|---|
 * | `probed`   | desktop + ffprobe present | rate, duration, PAR, codec, audio stream inventory |
 * | `elementOnly` | desktop without ffprobe, or browser | size and duration from the media element; **rate unknown**, audio presence unknown until decode |
 * | `none`     | probe threw or file unreadable | nothing beyond the bytes |
 *
 * An import NEVER fails or is skipped because a probe did not run. The probe
 * adds precision; its absence returns the editor to exactly the behaviour every
 * existing project already has.
 */

import type { MediaProbeResult } from '@app-types/motionEditor';

export type ProbeTier = 'probed' | 'elementOnly' | 'none';

export interface MediaFacts {
  tier: ProbeTier;
  width?: number;
  height?: number;
  durationSec?: number;
  /** Real source rate. Undefined means genuinely unknown — never substitute the
   *  composition's rate here; downstream readers rely on the distinction. */
  fps?: number;
  /** Pixel aspect from the container, when it is not square. */
  par?: number;
  /**
   * The source carries an alpha channel. Reliable (pix_fmt OR the container's
   * alpha_mode tag — see streamHasAlpha), and used only to decide whether the
   * Alpha interpretation control is worth showing. It says nothing about
   * whether the colour is premultiplied; no file records that.
   */
  hasAlpha?: boolean;
  container?: string;
  videoCodec?: string;
  /** Present and non-null only on the `probed` tier. `null` means the container
   *  was read and genuinely has NO audio stream — which is a different claim
   *  from `undefined` ("we did not look"). */
  audio?: { codec: string | null; channels: number | null; sampleRate: number | null } | null;
}

/** True when a real probe is available in this build. */
export function canProbe(): boolean {
  return typeof window !== 'undefined' && typeof window.motionEditor?.media?.probe === 'function';
}

/** Extension for the temp file the probe writes, so ffprobe picks the right
 *  demuxer. Falls back to a container guess from the MIME type. */
function extensionOf(file: File): string {
  const dot = file.name.lastIndexOf('.');
  if (dot > 0 && dot < file.name.length - 1) {
    const ext = file.name.slice(dot + 1);
    if (/^[a-z0-9]{1,5}$/i.test(ext)) return ext;
  }
  const sub = file.type.split('/')[1];
  return sub && /^[a-z0-9]{1,5}$/i.test(sub) ? sub : 'bin';
}

/**
 * Probe a file, or return `{ tier: 'elementOnly' }` when no probe is available.
 *
 * Never throws and never rejects: a failed probe is an absence of information,
 * not an error the import should surface.
 */
export async function probeMedia(file: File): Promise<MediaFacts> {
  const probe = window.motionEditor?.media?.probe;
  if (typeof probe !== 'function') return { tier: 'elementOnly' };

  let result: MediaProbeResult | null = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    result = await probe(bytes, extensionOf(file));
  } catch {
    return { tier: 'none' };
  }
  if (!result) return { tier: 'elementOnly' };

  const v = result.video;
  return {
    tier: 'probed',
    ...(v?.width ? { width: v.width } : {}),
    ...(v?.height ? { height: v.height } : {}),
    ...(result.durationSec ? { durationSec: result.durationSec } : {}),
    ...(v?.fps ? { fps: v.fps } : {}),
    // Only carry a PAR that actually differs from square. Writing 1 would
    // present "believe the file" as an explicit user override.
    ...(v?.par && Math.abs(v.par - 1) > 1e-3 ? { par: v.par } : {}),
    ...(v?.hasAlpha ? { hasAlpha: true } : {}),
    ...(result.container ? { container: result.container } : {}),
    ...(v?.codec ? { videoCodec: v.codec } : {}),
    audio: result.audio,
  };
}
