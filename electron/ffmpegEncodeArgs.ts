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
 * Hardware H.264/HEVC encoders ffmpeg can drive, when the build and the
 * machine have them. Opt-in: the software default is what every file has been
 * encoded with so far, and "same CRF, same bytes" only holds for it.
 */
export type HwVideoEncoder = 'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox';
export type VideoEncoder = 'libx264' | HwVideoEncoder;

export const HW_VIDEO_ENCODERS: ReadonlyArray<{ id: HwVideoEncoder; label: string; platforms: NodeJS.Platform[] }> = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC (H.264)', platforms: ['win32', 'linux'] },
  { id: 'hevc_nvenc', label: 'NVIDIA NVENC (HEVC)', platforms: ['win32', 'linux'] },
  { id: 'h264_qsv', label: 'Intel Quick Sync (H.264)', platforms: ['win32', 'linux'] },
  { id: 'h264_videotoolbox', label: 'Apple VideoToolbox (H.264)', platforms: ['darwin'] },
];

export function isHwVideoEncoder(v: unknown): v is HwVideoEncoder {
  return HW_VIDEO_ENCODERS.some((e) => e.id === v);
}

/**
 * Encoder names out of `ffmpeg -hide_banner -encoders`.
 *
 * Each encoder is one line of the form ` V....D h264_nvenc   NVIDIA NVENC …`:
 * a six-character capability column, the name, the description. Only the name
 * matters; a line is skipped rather than guessed at when it does not fit —
 * the header (`Encoders:`, the legend, the `------` rule) never does.
 */
export function parseFfmpegEncoders(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([VAS][.FXBD]{5})\s+([A-Za-z0-9_-]+)\s/.exec(`${line} `);
    if (m) names.add(m[2]!);
  }
  return names;
}

/**
 * The quality tiers, per encoder.
 *
 * Software CRF is the reference: 18 / 23 / 28 at High / Medium / Draft. The
 * hardware encoders have no CRF, so each gets its own quality knob set to the
 * value that lands nearest the same visual tier — none of them is a promise
 * of the same bytes, and the "bit-identical at the same CRF" gate applies to
 * libx264 only.
 *
 * | tier   | libx264            | h264_nvenc / hevc_nvenc      | h264_qsv                    | h264_videotoolbox |
 * |--------|--------------------|------------------------------|-----------------------------|-------------------|
 * | high   | -crf 18 -preset medium   | -rc vbr -cq 18 -preset p6 -tune hq | -global_quality 18 -preset medium   | -q:v 65 |
 * | medium | -crf 23 -preset medium   | -rc vbr -cq 23 -preset p5 -tune hq | -global_quality 23 -preset medium   | -q:v 55 |
 * | draft  | -crf 28 -preset veryfast | -rc vbr -cq 28 -preset p3          | -global_quality 28 -preset veryfast | -q:v 45 |
 *
 * NVENC: `-cq` is a constant-quality target on the same 0–51 scale as CRF and
 * needs `-rc vbr -b:v 0` or the bitrate default overrides it. The p-presets
 * run p1 (fastest) … p7 (slowest). QSV: `-global_quality` with no bitrate set
 * selects ICQ mode, again on a 1–51 scale; its `-preset` names match x264's.
 * VideoToolbox: `-q:v` is 1–100 with higher meaning better, and has no
 * documented CRF equivalence — the three values were chosen by eye against
 * the software tiers on 1080p motion graphics. The VBV ceiling
 * (`-maxrate`/`-bufsize`, see `h264MaxRate`) applies to all of them.
 */
export function videoEncoderArgs(encoder: VideoEncoder, quality: EncodeQuality = 'high'): string[] {
  const crf = quality === 'draft' ? '28' : quality === 'medium' ? '23' : '18';
  switch (encoder) {
    case 'h264_nvenc':
    case 'hevc_nvenc':
      return [
        '-c:v', encoder,
        '-preset', quality === 'draft' ? 'p3' : quality === 'medium' ? 'p5' : 'p6',
        ...(quality === 'draft' ? [] : ['-tune', 'hq']),
        '-rc', 'vbr', '-cq', crf, '-b:v', '0',
      ];
    case 'h264_qsv':
      return [
        '-c:v', 'h264_qsv',
        '-preset', quality === 'draft' ? 'veryfast' : 'medium',
        '-global_quality', crf,
      ];
    case 'h264_videotoolbox':
      return [
        '-c:v', 'h264_videotoolbox',
        '-q:v', quality === 'draft' ? '45' : quality === 'medium' ? '55' : '65',
      ];
    case 'libx264':
    default:
      return [
        '-c:v', 'libx264',
        '-preset', quality === 'draft' ? 'veryfast' : 'medium',
        '-crf', crf,
      ];
  }
}

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
export function rawVideoInput(width: number, height: number, fps: number, pixFmt: 'rgba' | 'rgba64le' = 'rgba'): string[] {
  return [
    '-f', 'rawvideo',
    // rgba64le: the engine's 16-bit output (F1, electron/engineExport.ts).
    '-pix_fmt', pixFmt,
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
  /**
   * mp4 only — which encoder writes the H.264/HEVC stream. Defaults to
   * libx264. Callers pass a hardware encoder only after `encoderProbe` has
   * confirmed it (this builder does not fall back; main.ts does).
   */
  videoEncoder?: VideoEncoder;
  /**
   * The frames arrive with NO colour description (raw rgba on stdin) — tag
   * them sRGB the way a decoded PNG is tagged, so the encoder writes the same
   * VUI (x264 SPS) / frame-header colour fields (ProRes) as the staged path.
   *
   * Frame properties via `setparams` in the filter graph, which is where the
   * PNG decoder sets them. NOT input-side `-color_primaries`/`-color_trc`:
   * those retag the stream and change the RGB→YUV conversion, so the pixels
   * come out different. Measured 2026-09-22 on ffmpeg 8.1.1: with this the
   * raw and PNG-staged mp4 and mov are byte-identical; without it they differ
   * by 2 bytes of SPS (mp4) or 2 bytes per ProRes frame header, and nothing
   * else.
   */
  tagSrgb?: boolean;
  out: string;
}

/** The frame-property tag a decoded PNG carries — see `EncodeArgsOptions.tagSrgb`. */
export const SRGB_FRAME_PARAMS = 'setparams=color_primaries=bt709:color_trc=iec61966-2-1';

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
  // the encode outright. Raw frames get their sRGB tag ahead of it.
  const evenScale = `${o.tagSrgb ? `${SRGB_FRAME_PARAMS},` : ''}scale=trunc(iw/2)*2:trunc(ih/2)*2`;
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
    default: {
      const encoder = o.videoEncoder ?? 'libx264';
      return [
        ...base,
        // libx264 by default: `-c:v libx264 -preset … -crf <crf>`. A hardware
        // encoder swaps in its own quality knob — see `videoEncoderArgs`.
        ...videoEncoderArgs(encoder, o.quality),
        // HEVC in MP4 needs the `hvc1` tag or QuickTime/Safari refuse the file.
        ...(encoder === 'hevc_nvenc' ? ['-tag:v', 'hvc1'] : []),
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
}
