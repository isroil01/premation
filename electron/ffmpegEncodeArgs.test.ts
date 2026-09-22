/**
 * The staged and streaming encodes are the SAME encode.
 *
 * The literal arrays below are the command lines `render:encode` built inline
 * before the builder existed, copied verbatim. Pinning them is what makes
 * "moved into a shared module" a refactor and not a change of output; the
 * stream cases then assert the ONLY difference is how the video enters.
 */

import {
  buildEncodeArgs, h264MaxRate, ffmpegRate, rawVideoInput, stagedVideoInput,
  parseFfmpegEncoders, videoEncoderArgs, HW_VIDEO_ENCODERS, isHwVideoEncoder, SRGB_FRAME_PARAMS,
} from './ffmpegEncodeArgs';

const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
const IN = '/job/frame_%04d.png';
const OUT = '/job/out.mp4';

describe('buildEncodeArgs — staged input matches the pre-refactor command lines', () => {
  it('mp4 with audio and chapters', () => {
    expect(buildEncodeArgs({
      format: 'mp4', videoInput: stagedVideoInput(IN, 30), quality: 'high',
      audio: '/job/audio.wav', chaptersFile: '/job/chapters.ffmetadata', alpha: false, out: OUT,
    })).toEqual([
      '-y', '-framerate', '30', '-i', IN, '-i', '/job/audio.wav', '-i', '/job/chapters.ffmetadata',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-vf', even,
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-map_chapters', '2', OUT,
    ]);
  });

  it('draft mp4, silent, chapters map to input 1', () => {
    expect(buildEncodeArgs({
      format: 'mp4', videoInput: stagedVideoInput(IN, 29.97), quality: 'draft',
      audio: null, chaptersFile: '/c', alpha: false, out: OUT,
    })).toEqual([
      '-y', '-framerate', '30000/1001', '-i', IN, '-i', '/c',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-vf', even, '-map_chapters', '1', OUT,
    ]);
  });

  it('webm keeps alpha only for alpha frames, and never takes chapters', () => {
    expect(buildEncodeArgs({
      format: 'webm', videoInput: stagedVideoInput(IN, 24), quality: 'medium',
      audio: '/a.wav', chaptersFile: '/c', alpha: true, out: '/o.webm',
    })).toEqual([
      '-y', '-framerate', '24', '-i', IN, '-i', '/a.wav',
      '-c:v', 'libvpx-vp9', '-crf', '23', '-b:v', '0', '-row-mt', '1', '-threads', '0',
      '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-vf', even,
      '-c:a', 'libopus', '-b:a', '160k', '-shortest', '/o.webm',
    ]);
    const opaque = buildEncodeArgs({
      format: 'webm', videoInput: stagedVideoInput(IN, 24), audio: null, chaptersFile: null, alpha: false, out: '/o.webm',
    });
    expect(opaque).toContain('yuv420p');
    expect(opaque).not.toContain('-auto-alt-ref');
  });

  it('gif is a palette graph with no audio', () => {
    expect(buildEncodeArgs({
      format: 'gif', videoInput: stagedVideoInput(IN, 15), audio: '/a.wav', chaptersFile: null, alpha: false, out: '/o.gif',
    })).toEqual([
      '-y', '-framerate', '15', '-i', IN, '-filter_complex',
      `[0:v] ${even},split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      '-loop', '0', '/o.gif',
    ]);
  });

  it('mov picks the ProRes profile and 4444 by default', () => {
    expect(buildEncodeArgs({
      format: 'mov', videoInput: stagedVideoInput(IN, 25), proresProfile: '422',
      audio: '/a.wav', chaptersFile: null, alpha: false, out: '/o.mov',
    })).toEqual([
      '-y', '-framerate', '25', '-i', IN, '-i', '/a.wav',
      '-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', '-vf', even,
      '-c:a', 'pcm_s16le', '-shortest', '/o.mov',
    ]);
    expect(buildEncodeArgs({
      format: 'mov', videoInput: stagedVideoInput(IN, 25), audio: null, chaptersFile: null, alpha: true, out: '/o.mov',
    })).toEqual(expect.arrayContaining(['-profile:v', '4', 'yuva444p10le']));
  });
});

describe('buildEncodeArgs — the stream differs ONLY in its video input and the sRGB frame tag', () => {
  const formats = ['mp4', 'webm', 'gif', 'mov'] as const;
  for (const format of formats) {
    it(format, () => {
      const common = { format, quality: 'high' as const, audio: '/a.wav', chaptersFile: '/c', alpha: true, out: '/o' };
      const staged = buildEncodeArgs({ ...common, videoInput: stagedVideoInput(IN, 30) });
      const stream = buildEncodeArgs({ ...common, videoInput: rawVideoInput(1920, 1080, 30), tagSrgb: true });
      const strip = (args: string[], input: string[]): string[] => {
        const at = args.indexOf(input[0]!);
        return [...args.slice(0, at), ...args.slice(at + input.length)]
          .map((a) => a.replace(`${SRGB_FRAME_PARAMS},`, ''));
      };
      // The tag rides inside the filter graph, ahead of the even-size scale.
      expect(stream.some((a) => a.includes(`${SRGB_FRAME_PARAMS},scale=`))).toBe(true);
      expect(staged.some((a) => a.includes('setparams'))).toBe(false);
      expect(strip(stream, rawVideoInput(1920, 1080, 30))).toEqual(strip(staged, stagedVideoInput(IN, 30)));
    });
  }

  it('the sRGB tag is what a decoded PNG carries: bt709 primaries, IEC 61966-2-1 transfer, as frame params', () => {
    expect(SRGB_FRAME_PARAMS).toBe('setparams=color_primaries=bt709:color_trc=iec61966-2-1');
    const untagged = buildEncodeArgs({ format: 'mp4', videoInput: rawVideoInput(320, 240, 30), audio: null, chaptersFile: null, alpha: false, out: '/o' });
    expect(untagged.join(' ')).not.toContain('setparams');
  });

  it('declares raw 8-bit RGBA at the exact size and rational rate', () => {
    expect(rawVideoInput(3840, 2160, 23.976)).toEqual([
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', '3840x2160', '-framerate', '24000/1001', '-i', 'pipe:0',
    ]);
    expect(ffmpegRate(59.94)).toBe('60000/1001');
    expect(ffmpegRate(60)).toBe('60');
  });
});

describe('hardware encoders', () => {
  const base = { format: 'mp4' as const, videoInput: rawVideoInput(1920, 1080, 30), audio: null, chaptersFile: null, alpha: false, out: 'o.mp4' };
  // From `-c:v` up to the VBV ceiling (or, without a frame size, the output
  // pix_fmt). lastIndexOf: the raw input carries its own `-pix_fmt rgba`.
  const codecArgs = (args: string[]): string[] => {
    const end = args.includes('-maxrate') ? args.indexOf('-maxrate') : args.lastIndexOf('-pix_fmt');
    return args.slice(args.indexOf('-c:v'), end);
  };

  it('libx264 is the default and unchanged by the option existing', () => {
    expect(buildEncodeArgs({ ...base, quality: 'high' })).toEqual(buildEncodeArgs({ ...base, quality: 'high', videoEncoder: 'libx264' }));
    expect(codecArgs(buildEncodeArgs({ ...base, quality: 'high' }))).toEqual(['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']);
  });

  /** The documented table, pinned: tier → (software CRF, per-encoder equivalent). */
  it.each([
    ['high', '18', 'p6', 'medium', '65'],
    ['medium', '23', 'p5', 'medium', '55'],
    ['draft', '28', 'p3', 'veryfast', '45'],
  ] as const)('%s maps CRF %s to -cq / -global_quality / -q:v', (quality, crf, nvPreset, qsvPreset, vtQ) => {
    expect(videoEncoderArgs('libx264', quality)).toContain(crf);
    const nvenc = videoEncoderArgs('h264_nvenc', quality);
    expect(nvenc).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc', '-preset', nvPreset, '-rc', 'vbr', '-cq', crf, '-b:v', '0']));
    expect(nvenc.includes('-tune')).toBe(quality !== 'draft');
    expect(videoEncoderArgs('hevc_nvenc', quality)).toEqual(expect.arrayContaining(['-c:v', 'hevc_nvenc', '-cq', crf]));
    expect(videoEncoderArgs('h264_qsv', quality)).toEqual(['-c:v', 'h264_qsv', '-preset', qsvPreset, '-global_quality', crf]);
    expect(videoEncoderArgs('h264_videotoolbox', quality)).toEqual(['-c:v', 'h264_videotoolbox', '-q:v', vtQ]);
  });

  it('a hardware encoder changes only the codec args; container, ceiling and audio stay', () => {
    const common = { ...base, quality: 'medium' as const, audio: '/a.wav', chaptersFile: '/c', frame: { width: 1920, height: 1080, fps: 30 } };
    const soft = buildEncodeArgs({ ...common, videoEncoder: 'libx264' });
    for (const hw of HW_VIDEO_ENCODERS.map((e) => e.id)) {
      const hard = buildEncodeArgs({ ...common, videoEncoder: hw });
      expect(codecArgs(hard)).toEqual(hw === 'hevc_nvenc'
        ? [...videoEncoderArgs(hw, 'medium'), '-tag:v', 'hvc1']
        : videoEncoderArgs(hw, 'medium'));
      // Everything from -maxrate onwards is identical: same VBV ceiling, same
      // yuv420p, faststart, scale, audio, chapters, output.
      expect(hard.slice(hard.indexOf('-maxrate'))).toEqual(soft.slice(soft.indexOf('-maxrate')));
      expect(hard.slice(0, hard.indexOf('-c:v'))).toEqual(soft.slice(0, soft.indexOf('-c:v')));
      expect(hard).not.toContain('libx264');
    }
  });

  it('is ignored for every non-mp4 container', () => {
    for (const format of ['webm', 'gif', 'mov'] as const) {
      expect(buildEncodeArgs({ ...base, format, videoEncoder: 'h264_nvenc', out: 'o' }))
        .toEqual(buildEncodeArgs({ ...base, format, out: 'o' }));
    }
  });

  it('parses ffmpeg -encoders output into names, ignoring the header', () => {
    const text = [
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
      ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
      ' V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)',
      ' V....D libx265              libx265 H.265 / HEVC (codec hevc)',
      ' A....D aac                  AAC (Advanced Audio Coding)',
      ' S..... webvtt               WebVTT subtitle',
      '',
    ].join('\r\n');
    const names = parseFfmpegEncoders(text);
    expect([...names]).toEqual(['libx264', 'h264_nvenc', 'h264_qsv', 'libx265', 'aac', 'webvtt']);
    expect(names.has('Video')).toBe(false);
    expect(parseFfmpegEncoders('')).toEqual(new Set());
  });

  it('knows which names are hardware encoders', () => {
    expect(isHwVideoEncoder('h264_nvenc')).toBe(true);
    expect(isHwVideoEncoder('libx264')).toBe(false);
    expect(isHwVideoEncoder('h264_amf')).toBe(false);
  });
});

describe('H.264 bitrate ceiling', () => {
  const base = { format: 'mp4' as const, videoInput: ['-i', 'x'], audio: null, chaptersFile: null, alpha: false, out: 'o.mp4' };

  it('bounds a 1080p30 High export near 20 Mbit/s — CRF alone reached 100+', () => {
    const args = buildEncodeArgs({ ...base, quality: 'high', frame: { width: 1920, height: 1080, fps: 30 } });
    const max = Number(args[args.indexOf('-maxrate') + 1]);
    expect(max).toBeGreaterThan(15_000_000);
    expect(max).toBeLessThan(25_000_000);
    expect(Number(args[args.indexOf('-bufsize') + 1])).toBe(max * 2);
    expect(args).toContain('-crf'); // still quality-targeted underneath
  });

  it('scales with the frame and steps down with quality', () => {
    expect(h264MaxRate(3840, 2160, 30, 'high')).toBe(h264MaxRate(1920, 1080, 30, 'high') * 4);
    expect(h264MaxRate(1920, 1080, 30, 'draft')).toBeLessThan(h264MaxRate(1920, 1080, 30, 'medium'));
  });

  it('adds nothing when the frame size is unknown', () => {
    expect(buildEncodeArgs({ ...base, quality: 'high' })).not.toContain('-maxrate');
  });
});
