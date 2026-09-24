#!/usr/bin/env node
// E1 measurement matrix: runs premation-decode-bench over the clips
// gen_media_clips.mjs makes, per decode path, and prints a markdown table
// (the "E1 local results" in docs/NATIVE_CORE_PLAN.md came from this).
//
//   node native/engine/tools/run_decode_bench.mjs [--exe PATH] [--clips DIR] [--vendor 0x10de]
//        [--only scrub|play] [--n 60] [--seconds 6] [--idle 35] [--paths sw,d3d11va,nvdec]
//
// Every run first waits (up to 5 min) for machine CPU load under --idle % and
// records the load it started at: a scrub number taken while something else
// saturates the cores is not the machine's number, and the table says so.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const exe = resolve(
  opt('--exe', join(here, '..', '..', 'build', 'windows-clang-cl-engine', 'engine', process.platform === 'win32' ? 'premation-decode-bench.exe' : 'premation-decode-bench')),
);
const clips = resolve(opt('--clips', join(here, '..', '..', 'build', 'media-clips')));
const vendor = opt('--vendor', '');
const only = opt('--only', '');
const n = opt('--n', '60');
const seconds = opt('--seconds', '6');
const idle = Number(opt('--idle', '35'));
const paths = opt('--paths', 'sw,d3d11va,nvdec').split(',');
if (!existsSync(exe)) {
  console.error(`no bench at ${exe} (build the engine preset first)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function load() {
  const a = cpus().map((c) => c.times);
  await sleep(1000);
  const b = cpus().map((c) => c.times);
  let busy = 0;
  let total = 0;
  b.forEach((t, i) => {
    if (!a[i]) return; // os.cpus() can come back short on Windows
    const d = (k) => t[k] - a[i][k];
    const all = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    busy += all - d('idle');
    total += all;
  });
  return total ? (100 * busy) / total : 0;
}
async function waitIdle() {
  let l = await load();
  for (let i = 0; i < 300 && l > idle; ++i) l = await load();
  return l;
}

function run(argv) {
  const r = spawnSync(exe, argv, { encoding: 'utf8', timeout: 600000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const intra = (name) => /prores|dnxhr/.test(name);
// d3d11va is the bench's default device: no --path, so older bench builds (without the flag) run too.
const pathArgs = (p) => (p === 'sw' ? ['--hw', 'sw'] : p === 'd3d11va' ? ['--hw', 'hw'] : ['--hw', 'hw', '--path', p]);
const vendorArgs = vendor ? ['--vendor', vendor] : [];
const rows = [];

const clipNames = [
  '4k-prores422hq.mov',
  '4k-prores4444.mov',
  '4k-prores4444-grain.mov',
  '1080p-prores422hq.mov',
  '1080p-dnxhr-hq.mov',
  '4k-dnxhr-hq.mov',
  '4k-dnxhr-hqx.mov',
  '4k-h264.mp4',
  '1080p-h264.mp4',
  '4k-hevc10.mp4',
  '1080p-vp9alpha.webm',
].filter((c) => existsSync(join(clips, c)));

for (const clip of clipNames) {
  const file = join(clips, clip);
  // Intra codecs have no hardware decoder on these GPUs: software only.
  // VP9 alpha is libvpx (the hardware decoders drop the alpha side channel).
  const clipPaths = intra(clip) || clip.includes('vp9alpha') ? ['sw'] : paths;
  for (const p of clipPaths) {
    if (only !== 'play') {
      const l = await waitIdle();
      const r = run(['scrub', file, '--n', n, ...pathArgs(p), ...vendorArgs]);
      const m = r.out.match(/decoded p50 ([\d.]+) p95 ([\d.]+) max ([\d.]+) ms \| texture p50 ([\d.]+) p95 ([\d.]+) max ([\d.]+)/);
      const path = r.out.match(/decode path: (\S+)/)?.[1] ?? '?';
      const fd = r.out.match(/frames decoded (\d+) for (\d+) targets/);
      const zc = r.out.match(/zero-copy (\d+)\/(\d+)/);
      rows.push(
        m
          ? `| ${clip} | scrub | ${p} → ${path} | ${m[1]} / ${m[2]} / ${m[3]} | ${m[4]} / ${m[5]} / ${m[6]} | ${fd ? `${fd[1]}/${fd[2]}` : ''} | ${zc ? `${zc[1]}/${zc[2]}` : ''} | ${l.toFixed(0)}% |`
          : `| ${clip} | scrub | ${p} | FAILED: ${r.out.trim().split('\n').pop()} | | | | ${l.toFixed(0)}% |`,
      );
      console.log(rows.at(-1));
    }
    if (only !== 'scrub') {
      const l = await waitIdle();
      const r = run(['play', file, '--seconds', seconds, ...pathArgs(p), ...vendorArgs]);
      const m = r.out.match(/: ([\d.]+) fps per stream \(file rate ([\d.]+)\)/);
      const path = r.out.match(/decode path: (\S+)/)?.[1] ?? '?';
      const ft = r.out.match(/frame time p50 ([\d.]+) p95 ([\d.]+) ms; CPU (\d+)%/);
      rows.push(
        m
          ? `| ${clip} | play ×1 | ${p} → ${path} | ${m[1]} fps (file ${Number(m[2]).toFixed(2)}) | frame p50 ${ft?.[1]} p95 ${ft?.[2]} ms | CPU ${ft?.[3]}% | | ${l.toFixed(0)}% |`
          : `| ${clip} | play ×1 | ${p} | FAILED: ${r.out.trim().split('\n').pop()} | | | | ${l.toFixed(0)}% |`,
      );
      console.log(rows.at(-1));
    }
  }
}

// The plan's second exit criterion: 6 × 1080p layers at full rate, paced at the file's rate.
if (only !== 'scrub') {
  for (const clip of ['1080p-h264.mp4', '1080p-prores422hq.mov', '1080p-dnxhr-hq.mov'].filter((c) => clipNames.includes(c))) {
    for (const p of intra(clip) ? ['sw'] : paths) {
      const l = await waitIdle();
      const r = run(['play', join(clips, clip), '--streams', '6', '--paced', '--seconds', seconds, ...pathArgs(p), ...vendorArgs]);
      const m = r.out.match(/: ([\d.]+) fps per stream \(file rate ([\d.]+)\) — (.*)/);
      const late = r.out.match(/late frames: (\d+) of (\d+)/);
      const path = r.out.match(/decode path: (\S+)/)?.[1] ?? '?';
      rows.push(
        m
          ? `| ${clip} | play ×6 paced | ${p} → ${path} | ${m[1]} fps — ${m[3].trim()} | late ${late?.[1]}/${late?.[2]} | | | ${l.toFixed(0)}% |`
          : `| ${clip} | play ×6 paced | ${p} | FAILED: ${r.out.trim().split('\n').pop()} | | | | ${l.toFixed(0)}% |`,
      );
      console.log(rows.at(-1));
    }
  }
}

console.log('\n| clip | mode | path (asked → got) | decoded p50/p95/max ms | texture p50/p95/max ms | frames decoded / targets | zero-copy | CPU load at start |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
