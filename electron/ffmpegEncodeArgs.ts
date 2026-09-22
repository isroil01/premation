/**
 * The ffmpeg command line for a delivered video — ONE builder, two inputs.
 *
 * Export reaches ffmpeg two ways now. The original path stages every frame as
 * an image file and encodes the sequence at the end (`frame_%04d.png`); the
 * streaming path pipes raw RGBA into a long-lived child as frames render
 * (`-f rawvideo … -i pipe:0`). The two must produce the SAME encode — same
 * codec, CRF, preset, pixel format, audio, chapters — or "which path ran" would
 * become something a user can see in their file. So the codec/container half of
 * the command line lives here once, and each path only supplies how the video
 * enters: `videoInput` is the part before the audio input, nothing more.
 *
 * Pure and electron-free so the equivalence is a unit test
 * (`ffmpegEncodeArgs.test.ts`) rather than a promise in a comment. HDR is not
 * here: it bakes mastering metadata measured over every frame into the encoder
 * parameters, which a stream cannot know before its first frame, and it retries
 * x265 → x264 over the same input — both of which need the staged files. It
 * stays inline in main.ts on the staged path.
 */

export type EncodeFormat = 'mp4' | 'webm' | 'gif' | 'mov';
export type EncodeQuality = 'high' | 'medium' | 'draft';
export type EncodeProresProfile = 'proxy' | 'lt' | '422' | 'hq' | '4444';

/**
 * ffmpeg-exact frame rate. The NTSC family are RATIONALS (30000/1001…);
 * handing ffmpeg the decimal builds a 2997/100 timebase — flagged by
 * broadcast QC, and drifting against the 48kHz mix on long renders.
 */
export function ffmpegRate(fps: number): string {
  if (Math.abs(fps - 23.976) < 0.001) return '24000/1001';
  if (Math.abs(fps - 29.97) < 0.001) return '30000/1001';
  if (Math.abs(fps - 59.94) < 0.001) return '60000/1001';
  return String(fps);
}

/** Input args for a staged image sequence (`frame_%04d.<ext>` in the job dir). */
export function stagedVideoInput(pattern: string, fps: number): string[] {
  return ['-framerate', ffmpegRate(fps), '-i', pattern];
}

/**
 * Input args for raw 8-bit RGBA frames on stdin.
 *
 * `rgba` is exactly what a staged PNG decodes to — the browser's PNG encoder
 * always writes 8-bit RGBA from the same unpremultiplied bytes `getImageData`
 * returns — so for every format that staged PNG the encoder sees identical
 * input. Formats that staged JPEG lose the JPEG generation instead.
 */
export function rawVideoInput(width: number, height: number, fps: number): string[] {
  return [
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-video_size', `${width}x${height}`,
    '-framerate', ffmpegRate(fps),
    '-i', 'pipe:0',
  ];
}

export interface EncodeArgsOptions {
  format: EncodeFormat;
  /** From `stagedVideoInput` or `rawVideoInput`. */
  videoInput: string[];
  quality?: EncodeQuality;
  /** mov only — ProRes flavour. Defaults to 4444 (the alpha-capable one). */
  proresProfile?: EncodeProresProfile;
  /** Path of the staged audio mix, or null for a silent encode. */
  audio: string | null;
  /** Path of the staged FFMETADATA1 chapters file, or null for none. Only MP4/MOV use it. */
  chaptersFile: string | null;
  /** The frames carry a real alpha channel (webm keeps it as yuva420p). */
  alpha: boolean;
  /** Frame size and rate, when the caller knows them — sizes the H.264 bitrate ceiling. */
  frame?: { width: number; height: number; fps: number };
  out: string;
}

/**
 * The H.264 bitrate CEILING for a frame size, in bits per second.
 *
 * CRF alone is a quality target with no upper bound: on grain, noise or dither
 * x264 spends whatever it takes, and a 60 s 1080p30 "High" export came out at
 * 96–113 Mbit/s (720–850 MB) — ten times a delivery bitrate, for no visible
 * gain. A VBV ceiling keeps CRF's quality on clean frames and bounds the busy
 * ones. Bits per pixel per frame: 0.32 at High is ~20 Mbit/s for 1080p30 and
 * ~80 for 4K30 — above every platform's upload recommendation, so it never
 * bites on normal motion graphics.
 */
export function h264MaxRate(width: number, height: number, fps: number, quality: EncodeQuality = 'high'): number {
  const bpp = quality === 'draft' ? 0.08 : quality === 'medium' ? 0.16 : 0.32;
  return Math.max(1_000_000, Math.round(width * height * fps * bpp));
}

/** The full non-HDR ffmpeg argument list. */
export function buildEncodeArgs(o: EncodeArgsOptions): string[] {
  // Even dimensions are required by yuv420p; odd-sized comps otherwise fail
  // the encode outright.
  const evenScale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const crf = o.quality === 'draft' ? '28' : o.quality === 'medium' ? '23' : '18';
  const hasAudio = !!o.audio;

  /*
    Chapters ride in as an extra INPUT, not as a flag.

    ffmpeg has no "set chapter" option: chapters are read from a demuxer, so
    the only way to attach them is to hand it a file it can parse chapters
    OUT of — an FFMETADATA1 text file — and then map that input's chapters
    onto the output.

    `-map_chapters` rather than `-map_metadata`: the latter would also
    replace the output's GLOBAL metadata with the (empty) metadata of a file
    that contains nothing but chapters. Only MP4/MOV get it — the WebM muxer
    has no Chapters element.
  */
  const wantsChapters = (o.format === 'mp4' || o.format === 'mov') && !!o.chaptersFile;
  const chapterInput = wantsChapters ? ['-i', o.chaptersFile!] : [];
  // Input indices: frames are 0, the audio mix (when present) is 1, so the
  // metadata file is whatever comes next. Off by one here silently maps the
  // AUDIO input's (non-existent) chapters and delivers a file with none.
  const chapterMap = wantsChapters ? ['-map_chapters', String(hasAudio ? 2 : 1)] : [];

  const base = [
    '-y', ...o.videoInput,
    ...(hasAudio ? ['-i', o.audio!] : []),
    ...chapterInput,
  ];

  switch (o.format) {
    case 'webm':
      return [
        ...base,
        '-c:v', 'libvpx-vp9',
        '-crf', crf, '-b:v', '0',
        // VP9 encodes far faster with row-based threading, and an export is
        // the one place where using every core is exactly what the user wants.
        '-row-mt', '1', '-threads', '0',
        // VP9 is the only mainstream video codec with an alpha channel, so a
        // transparent comp keeps its transparency here. alt-ref frames must be
        // off for alpha, or the channel is discarded.
        ...(o.alpha ? ['-pix_fmt', 'yuva420p', '-auto-alt-ref', '0'] : ['-pix_fmt', 'yuv420p']),
        '-vf', evenScale,
        ...(hasAudio ? ['-c:a', 'libopus', '-b:a', '160k', '-shortest'] : []),
        o.out,
      ];
    case 'gif':
      // Two passes in one graph: palettegen builds an optimal 256-colour
      // palette for the whole animation, paletteuse dithers against it. A
      // single-pass GIF quantises per frame and visibly bands and flickers.
      return [
        '-y', ...o.videoInput,
        '-filter_complex',
        `[0:v] ${evenScale},split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
        '-loop', '0',
        o.out,
      ];
    case 'mov': {
      // ProRes 4444 keeps the alpha channel (the classic reason to pick a
      // .mov); the 422 family halves the file for opaque delivery/edit
      // handoff, matching what AE's output modules offer.
      const profile = o.proresProfile ?? '4444';
      const proresArgs: Record<string, [string, string]> = {
        proxy: ['0', 'yuv422p10le'],
        lt: ['1', 'yuv422p10le'],
        '422': ['2', 'yuv422p10le'],
        hq: ['3', 'yuv422p10le'],
        '4444': ['4', 'yuva444p10le'],
      };
      const [profileFlag, pixFmt] = proresArgs[profile] ?? proresArgs['4444']!;
      return [
        ...base,
        '-c:v', 'prores_ks', '-profile:v', profileFlag, '-pix_fmt', pixFmt,
        '-vf', evenScale,
        ...(hasAudio ? ['-c:a', 'pcm_s16le', '-shortest'] : []),
        ...chapterMap,
        o.out,
      ];
    }
    case 'mp4':
    default:
      return [
        ...base,
        '-c:v', 'libx264',
        '-preset', o.quality === 'draft' ? 'veryfast' : 'medium',
        '-crf', crf,
        // Quality-targeted, but bounded — see `h264MaxRate`.
        ...(o.frame
          ? ((rate: number) => ['-maxrate', String(rate), '-bufsize', String(rate * 2)])(
              h264MaxRate(o.frame.width, o.frame.height, o.frame.fps, o.quality))
          : []),
        // H.264 carries no alpha. A transparent comp arrives as RGBA and this
        // conversion flattens it over BLACK — ffmpeg's own behaviour, relied on
        // deliberately rather than stumbled into, and stated in the composition
        // settings dialog so nobody first discovers it in a delivered file.
        // mov (ProRes 4444) and webm (VP9) keep alpha.
        '-pix_fmt', 'yuv420p',
        // Streaming-friendly: without faststart the moov atom lands at the
        // end and browsers refuse to play the file until it fully downloads.
        '-movflags', '+faststart',
        '-vf', evenScale,
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
        ...chapterMap,
        o.out,
      ];
  }
}
