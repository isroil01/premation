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
