/**
 * Real ffmpeg, real output: does a generated proxy actually stay aligned with
 * its source?
 *
 * The unit tests assert that `proxyEncodeArgs` carries no timing flags. That is
 * an argument about the arguments. This runs the encode and measures the FILE —
 * frame count, duration and stream geometry — because "no -r flag" and "same
 * number of frames" are different claims and only the second one matters.
 *
 * Skips itself when ffmpeg/ffprobe are absent. That is a real state on desktop
 * (see `resolveFfmpeg`'s PATH fallback) and the whole suite must not go red on
 * a machine without codec tools.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxyEncodeArgs, proxyResolution } from './proxy';

const has = (bin: string): boolean => {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};
const HAVE_FFMPEG = has('ffmpeg') && has('ffprobe');
const d = HAVE_FFMPEG ? describe : describe.skip;

/** One ffprobe field for the first video stream. */
function probe(file: string, entry: string): string {
  return execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entry, '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  ).trim().split('\n')[0]!.trim();
}

/** Frames actually present, counted rather than read from a header. */
const frameCount = (file: string): number =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file],
      { encoding: 'utf8' },
    ).trim(),
  );

let dir: string;
beforeAll(() => {
  if (HAVE_FFMPEG) dir = mkdtempSync(join(tmpdir(), 'proxy-enc-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

d('a generated proxy is frame-for-frame aligned with its source', () => {
  jest.setTimeout(180_000);

  const SRC_W = 1920;
  const SRC_H = 1080;
  const FPS = 30;
  const SECONDS = 2;

  let src: string;
  let out: string;

  beforeAll(() => {
    src = join(dir, 'src.mp4');
    out = join(dir, 'proxy.mp4');
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${SRC_W}x${SRC_H}:rate=${FPS}:duration=${SECONDS}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', src,
    ]);
    const size = proxyResolution(SRC_W, SRC_H)!;
    execFileSync('ffmpeg', proxyEncodeArgs(src, out, size, false));
  });

  it('produces a file at the resolution the rule chose', () => {
    expect(existsSync(out)).toBe(true);
    expect(Number(probe(out, 'stream=width'))).toBe(960);
    expect(Number(probe(out, 'stream=height'))).toBe(540);
  });

  it('has EXACTLY as many frames as the source — the alignment invariant', () => {
    expect(frameCount(out)).toBe(frameCount(src));
    expect(frameCount(out)).toBe(FPS * SECONDS);
  });

  it('has the same duration as the source', () => {
    const dur = (f: string): number =>
      Number(
        execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], {
          encoding: 'utf8',
        }).trim(),
      );
    expect(dur(out)).toBeCloseTo(dur(src), 1);
  });

  it('keeps the source frame rate, so a conformed source stays conformed', () => {
    expect(probe(out, 'stream=r_frame_rate')).toBe(probe(src, 'stream=r_frame_rate'));
  });

  it('is materially smaller — otherwise the whole feature buys nothing', () => {
    const size = (f: string): number => Number(probe(f, 'stream=width')) * Number(probe(f, 'stream=height'));
    expect(size(out)).toBeLessThan(size(src) / 3);
  });

  it('has a short GOP, which is half of why it seeks faster', () => {
    // Count keyframes: 60 frames at -g 12 should give ~5, versus 1 at -g 60.
    const keyframes = (f: string): number =>
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', f],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter((l) => l.trim().startsWith('1')).length;
    expect(keyframes(out)).toBeGreaterThan(keyframes(src));
    expect(keyframes(out)).toBeGreaterThanOrEqual(4);
  });
});

/**
 * VP9/WebM alpha is a CONTAINER TAG, not a pixel format.
 *
 * A VP9 alpha stream reports `pix_fmt=yuv420p` and carries `alpha_mode=1` in
 * its stream tags — `mediaProbe`'s module doc records the same finding, and
 * `streamHasAlpha` in electron/main.ts already checks both. Asserting on
 * pix_fmt here reported a false failure on an encode that had in fact kept the
 * alpha. ffprobe's tag casing differs between input and output files
 * (`alpha_mode` vs `ALPHA_MODE`), so the lookup is case-insensitive.
 */
function hasAlphaTag(file: string): boolean {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_tags', '-of', 'default=nw=1', file],
    { encoding: 'utf8' },
  );
  return /alpha_mode\s*=\s*1/i.test(out);
}

d('an alpha source keeps its alpha through the proxy', () => {
  jest.setTimeout(180_000);

  let src: string;
  beforeAll(() => {
    src = join(dir, 'alpha-src.webm');
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=1',
      '-vf', 'format=yuva420p,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=128',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '40', '-b:v', '0',
      '-deadline', 'realtime', '-cpu-used', '8', src,
    ]);
  });

  it('the fixture really does carry alpha, or the rest of this proves nothing', () => {
    expect(hasAlphaTag(src)).toBe(true);
  });

  it('carries the alpha through to the proxy', () => {
    const out = join(dir, 'alpha-proxy.webm');
    const size = proxyResolution(1920, 1080)!;
    execFileSync('ffmpeg', proxyEncodeArgs(src, out, size, /* hasAlpha */ true));

    expect(existsSync(out)).toBe(true);
    expect(hasAlphaTag(out)).toBe(true);
    expect(Number(probe(out, 'stream=width'))).toBe(960);
  });

  it('the SAME source encoded as if opaque loses it — pinning why proxyCodec branches', () => {
    const wrong = join(dir, 'alpha-wrong.mp4');
    execFileSync('ffmpeg', proxyEncodeArgs(src, wrong, { width: 960, height: 540 }, /* hasAlpha */ false));
    // H.264 in mp4 has nowhere to put the matte. Silently flattening it is
    // exactly the "looks like a rendering bug" failure the branch avoids.
    expect(hasAlphaTag(wrong)).toBe(false);
  });
});
