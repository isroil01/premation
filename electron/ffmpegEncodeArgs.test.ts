/**
 * The staged and streaming encodes are the SAME encode.
 *
 * The literal arrays below are the command lines `render:encode` built inline
 * before the builder existed, copied verbatim. Pinning them is what makes
 * "moved into a shared module" a refactor and not a change of output; the
 * stream cases then assert the ONLY difference is how the video enters.
 */

import { buildEncodeArgs, h264MaxRate, ffmpegRate, rawVideoInput, stagedVideoInput } from './ffmpegEncodeArgs';

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

describe('buildEncodeArgs — the stream differs ONLY in its video input', () => {
  const formats = ['mp4', 'webm', 'gif', 'mov'] as const;
  for (const format of formats) {
    it(format, () => {
      const common = { format, quality: 'high' as const, audio: '/a.wav', chaptersFile: '/c', alpha: true, out: '/o' };
      const staged = buildEncodeArgs({ ...common, videoInput: stagedVideoInput(IN, 30) });
      const stream = buildEncodeArgs({ ...common, videoInput: rawVideoInput(1920, 1080, 30) });
      const strip = (args: string[], input: string[]): string[] => {
        const at = args.indexOf(input[0]!);
        return [...args.slice(0, at), ...args.slice(at + input.length)];
      };
      expect(strip(stream, rawVideoInput(1920, 1080, 30))).toEqual(strip(staged, stagedVideoInput(IN, 30)));
    });
  }

  it('declares raw 8-bit RGBA at the exact size and rational rate', () => {
    expect(rawVideoInput(3840, 2160, 23.976)).toEqual([
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', '3840x2160', '-framerate', '24000/1001', '-i', 'pipe:0',
    ]);
    expect(ffmpegRate(59.94)).toBe('60000/1001');
    expect(ffmpegRate(60)).toBe('60');
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
