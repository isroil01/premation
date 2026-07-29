/**
 * Parsing ffprobe's JSON into the shape the renderer consumes.
 *
 * Split out of `main.ts` so it can be tested against REAL ffprobe output
 * without spawning Electron. The spawning and temp-file handling around it are
 * thin; this is where the actual decisions live — which rate to believe, which
 * stream is the one we mean, and what "unknown" looks like.
 */

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number | string;
  height?: number | string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  channels?: number | string;
  sample_rate?: number | string;
  duration?: number | string;
  pix_fmt?: string;
  tags?: Record<string, string | undefined>;
}

export interface ProbeJson {
  streams?: ProbeStream[];
  format?: { format_name?: string; duration?: number | string };
}

export interface ParsedProbe {
  container: string | null;
  durationSec: number | null;
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    par: number | null;
    /** Does the video stream carry an alpha channel at all? */
    hasAlpha: boolean;
  } | null;
  audio: { codec: string | null; channels: number | null; sampleRate: number | null } | null;
}

/**
 * `30000/1001` → 29.97.
 *
 * ffprobe reports rates as exact rationals and NTSC rates are genuinely not
 * integers. Rounding 30000/1001 to 30 would silently undo the pulldown the file
 * is asking for, which is the entire thing conform exists to control.
 */
export function parseRational(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const [n, d] = v.split('/');
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) return null;
  return num / den;
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Does this video stream carry alpha?
 *
 * TWO signals, because neither is sufficient. Measured against real files:
 *
 *   VP9 / WebM with alpha  pix_fmt yuv420p       tags.alpha_mode "1"
 *   ProRes 4444 / MOV      pix_fmt yuva444p12le  no tag
 *   PNG                    pix_fmt rgba          no tag
 *   TGA                    pix_fmt bgra          no tag
 *   H.264 / MP4, opaque    pix_fmt yuv420p       no tag
 *
 * A `pix_fmt`-only test — the obvious implementation — reports WebM alpha as
 * opaque, because Matroska carries the alpha channel as a separate stream and
 * announces it with a container tag rather than in the pixel format. WebM is one
 * of the two formats people actually deliver alpha in, so that miss would matter.
 *
 * This says whether alpha EXISTS. Nothing in any of these files says whether the
 * colour was PREMULTIPLIED by it — see FootageInterpretation.alpha.
 */
export function streamHasAlpha(v: ProbeStream | undefined): boolean {
  if (!v) return false;
  const tag = v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE;
  if (tag !== undefined && tag !== '0' && tag !== '') return true;
  const pf = typeof v.pix_fmt === 'string' ? v.pix_fmt : '';
  // yuva*/ya* cover the planar alpha formats; the packed ones are named directly.
  return /^(yuva|ya)/.test(pf) || ['rgba', 'bgra', 'argb', 'abgr', 'rgba64le', 'rgba64be'].includes(pf);
}

export function parseProbeJson(parsed: ProbeJson): ParsedProbe {
  const streams = parsed.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');

  return {
    container: strOrNull(parsed.format?.format_name),
    // Container duration first: a stream's own duration can be absent or
    // shorter than the file (a cover-art video stream in an mp3, for one).
    durationSec: numOrNull(parsed.format?.duration) ?? numOrNull(v?.duration) ?? null,
    video: v
      ? {
          codec: strOrNull(v.codec_name),
          width: numOrNull(v.width),
          height: numOrNull(v.height),
          // avg_frame_rate is the honest average over the file. r_frame_rate is
          // the container's nominal rate and reads 1000/1 on some variable-rate
          // phone footage, so it is only the fallback.
          fps: parseRational(v.avg_frame_rate) ?? parseRational(v.r_frame_rate),
          // ffprobe writes PAR with a colon ("1:1"), not a slash.
          par: parseRational(String(v.sample_aspect_ratio ?? '').replace(':', '/')),
          hasAlpha: streamHasAlpha(v),
        }
      : null,
    audio: a
      ? {
          codec: strOrNull(a.codec_name),
          channels: numOrNull(a.channels),
          sampleRate: numOrNull(a.sample_rate),
        }
      : null,
  };
}
