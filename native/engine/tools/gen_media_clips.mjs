#!/usr/bin/env node
// E1 bench clips: generates the codec matrix premation-decode-bench measures
// (docs/NATIVE_CORE_PLAN.md Phase E, "E1 local results"). The clips are large
// (4K ProRes HQ is ~0.8 Gbit/s) and machine-made, so they are NEVER committed:
// the default output is native/build/media-clips (git-ignored).
//
//   node native/engine/tools/gen_media_clips.mjs [--out DIR] [--seconds S] [--only name,name] [--force]
//
// Needs an ffmpeg on PATH (or FFMPEG=path) built with prores_ks, dnxhd,
// libx264, libvpx-vp9 and libx265 or hevc_nvenc. Content is testsrc2 (sharp
// edges, moving text) plus temporal grain, so intra codecs spend a realistic
// number of bits per frame instead of coding flat fields.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const out = resolve(opt('--out', join(here, '..', '..', 'build', 'media-clips')));
const seconds = Number(opt('--seconds', '5'));
const only = opt('--only', '')
  .split(',')
  .filter(Boolean);
const force = args.includes('--force');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const rate = '24000/1001';

const encoders = (() => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`ffmpeg not runnable (${ffmpeg}): ${r.error ?? r.stderr}`);
    process.exit(1);
  }
  return r.stdout;
})();
const has = (e) => new RegExp(`\\s${e}\\s`).test(encoders);

const src = (w, h, grain = 10) => `testsrc2=s=${w}x${h}:r=${rate},noise=alls=${grain}:allf=t`;
// Straight alpha that varies over the frame (a diagonal gradient), for 4444 / VP9 alpha.
const withAlpha = (w, h, fmt, grain = 10) =>
  `${src(w, h, grain)}[c];gradients=s=${w}x${h}:r=${rate}:c0=white:c1=0x202020:type=linear,format=gray[a];[c][a]alphamerge,format=${fmt}`;
// BT.709 limited, tagged in the stream AND the container.
const tags709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];

const hevcEnc = has('hevc_nvenc')
  ? ['-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-g', '48', '-bf', '2']
  : ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast', '-x265-params', 'keyint=48:bframes=2', '-crf', '20'];

const clips = [
  { name: '4k-prores422hq.mov', vf: `${src(3840, 2160)},format=yuv422p10le`, enc: ['-c:v', 'prores_ks', '-profile:v', 'hq', '-vendor', 'apl0', ...tags709] },
  {
    // 4444 is graphics / CG with alpha more than camera grain: light grain keeps it near Apple's ~1 Gbit/s at 4K 24p
    // (with the camera clips' grain prores_ks makes ~4 Gbit/s, 4x ProRes 4444 XQ). 3 s (72 frames) for disk space.
    name: '4k-prores4444.mov',
    maxSeconds: 3,
    fc: withAlpha(3840, 2160, 'yuva444p10le', 2),
    enc: ['-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0', ...tags709],
  },
  {
    // Stress case: the same 4444 under camera grain (~4 Gbit/s, 21 MB a frame).
    name: '4k-prores4444-grain.mov',
    maxSeconds: 3,
    fc: withAlpha(3840, 2160, 'yuva444p10le'),
    enc: ['-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0', ...tags709],
  },
  { name: '1080p-prores422hq.mov', vf: `${src(1920, 1080)},format=yuv422p10le`, enc: ['-c:v', 'prores_ks', '-profile:v', 'hq', '-vendor', 'apl0', ...tags709] },
  { name: '1080p-dnxhr-hq.mov', vf: `${src(1920, 1080)},format=yuv422p`, enc: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', ...tags709] },
  { name: '4k-dnxhr-hq.mov', vf: `${src(3840, 2160)},format=yuv422p`, enc: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', ...tags709] },
  { name: '4k-dnxhr-hqx.mov', vf: `${src(3840, 2160)},format=yuv422p10le`, enc: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', ...tags709] },
  {
    name: '4k-h264.mp4',
    vf: `${src(3840, 2160)},format=yuv420p`,
    enc: ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', '18', '-g', '48', '-bf', '2', ...tags709],
  },
  {
    name: '1080p-h264.mp4',
    vf: `${src(1920, 1080)},format=yuv420p`,
    enc: ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', '18', '-g', '48', '-bf', '2', ...tags709],
  },
  { name: '4k-hevc10.mp4', vf: `${src(3840, 2160)},format=yuv420p10le`, enc: [...hevcEnc, ...tags709, '-tag:v', 'hvc1'] },
  {
    name: '1080p-vp9alpha.webm',
    fc: withAlpha(1920, 1080, 'yuva420p'),
    enc: ['-c:v', 'libvpx-vp9', '-b:v', '12M', '-g', '48', '-auto-alt-ref', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', ...tags709],
  },
];

mkdirSync(out, { recursive: true });
let failed = 0;
for (const c of clips) {
  if (only.length && !only.includes(c.name)) continue;
  const path = join(out, c.name);
  if (existsSync(path) && !force) {
    console.log(`skip ${c.name} (exists)`);
    continue;
  }
  const d = Math.min(seconds, c.maxSeconds ?? seconds);
  const input = c.fc
    ? ['-filter_complex', c.fc.replace('testsrc2=', `testsrc2=d=${d}:`).replace('gradients=', `gradients=d=${d}:`)]
    : ['-f', 'lavfi', '-i', c.vf.replace('testsrc2=', `testsrc2=d=${d}:`)];
  const cmd = ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-an', ...c.enc, path];
  const t0 = Date.now();
  process.stdout.write(`${c.name} … `);
  const r = spawnSync(ffmpeg, cmd, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.log(`FAILED (${ffmpeg} ${cmd.join(' ')})`);
    ++failed;
    continue;
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(`clips in ${out}`);
process.exit(failed ? 1 : 0);
