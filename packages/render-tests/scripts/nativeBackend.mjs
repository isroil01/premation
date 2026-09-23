/**
 * The `native` backend of the golden-frame suite — docs/NATIVE_CORE_PLAN.md D2.
 *
 * The C++ render graph (native/engine/src/render_graph) renders the SAME
 * FrameScene the TypeScript WebGPU backend rendered, and must produce the same
 * pixels. How a run works:
 *
 *   1. The webgpu Electron pass runs with HARNESS_SCENE_OUT set: after each
 *      frame it writes a RenderFrameFile (engine-api 96_render.eapi) — the
 *      FrameScene, viewport, colour state and every sampled texture's texels —
 *      to .artifacts/scenes/<scene>/<frame>.pfs.
 *   2. `premation-render --batch` renders every file headless on Dawn and writes
 *      .artifacts/actual/native/<scene>/<frame>.png plus a JSON report. A frame
 *      whose FrameScene uses a feature the C++ graph has not ported yet is
 *      reported `not-ported` with the reasons, and is not rendered.
 *   3. This gate compares each native frame against the WEBGPU frame of the same
 *      run (the parity target: same FrameScene, same GPU) with the webgpu
 *      ratchet's rules — an unlisted frame may differ by at most
 *      BACKEND_TOLERANCE, a listed one may not exceed its ceiling in
 *      native-baseline.json. `not-ported` frames are counted, never failed; a
 *      ported frame that renders wrong fails the build.
 *
 * The native frame is also measured against the committed reference, for the
 * report only (references are WebGL2-blessed; webgpu itself carries ceilings).
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { readPng } from './comparator.mjs';

const RESET = '\x1b[0m';
const c = (code, s) => `\x1b[${code}m${s}${RESET}`;
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const dim = (s) => c(2, s);

const pct = (r) => `${(r * 100).toFixed(3)}%`;

/** Where `premation-render` lives: NATIVE_RENDER_EXE, else the engine preset builds. */
export function findRenderExe(repoRoot) {
  if (process.env.NATIVE_RENDER_EXE) return existsSync(process.env.NATIVE_RENDER_EXE) ? process.env.NATIVE_RENDER_EXE : null;
  const exe = process.platform === 'win32' ? 'premation-render.exe' : 'premation-render';
  const presets = ['windows-clang-cl-engine', 'linux-clang-engine', 'macos-clang-engine'];
  for (const p of presets) {
    const f = path.join(repoRoot, 'native', 'build', p, 'engine', exe);
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * The webgpu pass's measured readback table (renderEntry.ts measureReadbackTable:
 * a 256×256 PNG, pixel (value, alpha) = what a premultiplied (value, alpha)
 * byte becomes in a webgpu PNG) → the raw 65 536-byte table premation-render
 * reads (index alpha·256 + value). Null when the run did not measure one.
 */
async function readbackTableFile(scenesDir) {
  const png = path.join(scenesDir, 'readback-table.png');
  if (!existsSync(png)) return null;
  const img = await readPng(png);
  if (img.width !== 256 || img.height !== 256) return null;
  const table = new Uint8Array(256 * 256);
  for (let i = 0; i < table.length; i++) table[i] = img.data[i * 4 + 1];
  const out = path.join(scenesDir, 'readback-table.bin');
  await fs.writeFile(out, table);
  return out;
}

/** Render every exported frame. Resolves with the exit code. */
export async function runNativeRenderer({ exe, scenesDir, outDir, reportFile, only }) {
  // A stale report from an earlier run must never be read as this run's.
  rmSync(reportFile, { force: true });
  const table = await readbackTableFile(scenesDir);
  if (!table) process.stdout.write(yellow('  ! [native] no measured readback table — low-alpha pixels may differ by 1/255 at rounding ties\n'));
  return new Promise((resolve) => {
    const args = ['--batch', scenesDir, '--out', outDir, '--report', reportFile];
    if (table) args.push('--readback-table', table);
    if (only && only.length) args.push('--only', only.join(','));
    const child = spawn(exe, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** Scene id → family, for the per-family table. First matching prefix wins. */
const FAMILIES = [
  ['blend-', 'blend modes'],
  ['alpha-', 'alpha'],
  ['matte-', 'masks + mattes'],
  ['mask-', 'masks + mattes'],
  ['precomp-', 'precomps'],
  ['adjustment-', 'adjustment layers'],
  ['preserve-transparency', 'blend modes'],
  ['motion-blur', 'motion blur'],
  ['effect-', 'effects'],
  ['blur-', 'effects'],
  ['glass-', 'glass'],
  ['three-d-', '3D'],
  ['light-', '3D'],
  ['shadow-', '3D'],
  ['ssao-', '3D'],
  ['env-', '3D'],
  ['ext-', '3D'],
  ['model-', '3D'],
  ['primitive-', '3D'],
  ['text-', 'text (TS raster)'],
  ['svg-', 'svg (TS raster)'],
  ['shape-', 'shapes (TS raster)'],
  ['stroke-', 'strokes (TS raster)'],
  ['paint-', 'strokes (TS raster)'],
  ['fill-', 'fills'],
  ['solid-', 'fills'],
  ['flat-', 'fills'],
  ['linear-gradient', 'fills'],
  ['hires-', 'text (TS raster)'],
  ['interior-', 'layer styles'],
  ['bevel-', 'layer styles'],
  ['layer-styles', 'layer styles'],
  ['rig-', 'rigging / meshes'],
  ['generator-', 'generators'],
  ['particles-', 'generators'],
  ['plugin-', 'plugins'],
  ['video-', 'video'],
  ['native-', 'native parity (32 bpc, overlays, viewer LUT)'],
];

export function familyOf(id) {
  for (const [prefix, fam] of FAMILIES) if (id.startsWith(prefix)) return fam;
  return 'other';
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

/**
 * The native gate. Returns the number of failures (ported frames that regressed
 * or render wrong, or renderer errors).
 */
export async function gateNative(scenes, opts) {
  const { actualDir, referencesDir, reportFile, baselineFile, updateBaseline, compareFrames, readPngSafe, tolerance, slack, tighten } = opts;
  const report = await readJson(reportFile, null);
  if (!report) {
    process.stdout.write('\n' + red('  native: no report from premation-render — the renderer did not run.\n'));
    return 1;
  }
  const byFrame = new Map((report.frames ?? []).map((f) => [`${f.scene}#${f.frame}`, f]));
  const baseline = (await readJson(baselineFile, {})).frames ?? {};

  const fam = new Map();
  const famRow = (name) => {
    if (!fam.has(name)) fam.set(name, { total: 0, ported: 0, passing: 0 });
    return fam.get(name);
  };
  const reasons = new Map();
  const regressed = [];
  const unlisted = [];
  const errors = [];
  const improved = [];
  const newBaseline = {};
  let ported = 0;
  let passing = 0;
  let total = 0;
  let notExported = 0;
  let refMatches = 0;
  let identical = 0;
  let within1 = 0;
  let worstDelta = 0;
  const inexact = [];

  for (const s of scenes) {
    for (const frame of s.frames) {
      const id = `${s.id}#${frame}`;
      const row = famRow(familyOf(s.id));
      const webgpu = await readPngSafe(path.join(actualDir, 'webgpu', s.id, `${frame}.png`));
      if (!webgpu) continue; // webgpu did not render it: nothing to be at parity with
      total++;
      row.total++;
      const rep = byFrame.get(id);
      if (!rep) { notExported++; continue; }
      if (rep.status === 'not-ported') {
        for (const r of rep.reasons ?? []) reasons.set(r, (reasons.get(r) ?? 0) + 1);
        continue;
      }
      if (rep.status !== 'rendered') {
        errors.push({ id, why: rep.error ?? rep.status });
        continue;
      }
      const native = await readPngSafe(path.join(actualDir, 'native', s.id, `${frame}.png`));
      if (!native) { errors.push({ id, why: 'reported rendered but no PNG' }); continue; }
      ported++;
      row.ported++;
      const vsWebgpu = compareFrames(native, webgpu, { tolerance: s.tolerance });
      // Byte-level agreement, beside the perceptual gate: how close the two
      // renderers really are for the same FrameScene on the same GPU.
      let maxDelta = 0;
      if (native.data.length === webgpu.data.length) {
        for (let k = 0; k < native.data.length; k++) {
          const d = Math.abs(native.data[k] - webgpu.data[k]);
          if (d > maxDelta) maxDelta = d;
        }
      } else maxDelta = 255;
      if (maxDelta === 0) identical++;
      else inexact.push({ id, maxDelta });
      if (maxDelta <= 1) within1++;
      worstDelta = Math.max(worstDelta, maxDelta);
      if (vsWebgpu.pass) { passing++; row.passing++; }
      const ref = s.fidelityOnly ? null : await readPngSafe(path.join(referencesDir, s.id, `${frame}.png`));
      if (ref && compareFrames(native, ref, { tolerance: s.tolerance }).pass) refMatches++;
      const ratio = vsWebgpu.ratio;
      if (ratio > tolerance) newBaseline[id] = Number(ratio.toFixed(5));
      const ceiling = baseline[id];
      if (ceiling === undefined) {
        if (ratio > tolerance) unlisted.push({ id, ratio });
      } else if (ratio > ceiling + slack) {
        regressed.push({ id, ratio, ceiling });
      } else if (ratio < ceiling - tighten) {
        improved.push({ id, ratio, ceiling });
      }
    }
  }

  process.stdout.write('\n' + dim('  native pixel parity (C++ render graph vs the TS WebGPU frame of the same FrameScene):\n'));
  process.stdout.write(dim(`  - adapter: ${report.adapter ?? '?'} (${report.backend ?? '?'})\n`));
  process.stdout.write(dim(`  - ${ported}/${total} frame(s) ported; ${passing}/${ported} within the scene tolerance of webgpu; `
    + `${refMatches}/${ported} also match the committed reference\n`));
  process.stdout.write(dim(`  - byte-exact: ${identical}/${ported} frame(s) bit-identical to webgpu, ${within1}/${ported} within 1/255 per channel (worst ${worstDelta}/255)\n`));
  for (const d of inexact.sort((a, b) => b.maxDelta - a.maxDelta).slice(0, 8)) {
    process.stdout.write(dim(`      not bit-exact: ${d.id} max Δ ${d.maxDelta}/255\n`));
  }
  if (notExported > 0) process.stdout.write(yellow(`  - ${notExported} frame(s) had no exported FrameScene\n`));
  process.stdout.write(dim('  family                   ported/total  passing\n'));
  for (const [name, r] of [...fam.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    process.stdout.write(dim(`    ${name.padEnd(24)} ${`${r.ported}/${r.total}`.padStart(9)}  ${String(r.passing).padStart(7)}\n`));
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    process.stdout.write(dim('  not ported yet (frames blocked, by feature):\n'));
    for (const [r, n] of top) process.stdout.write(dim(`    ${String(n).padStart(4)}  ${r}\n`));
  }
  if (report.timing) {
    process.stdout.write(dim(`  - C++ GPU frame time: mean ${report.timing.meanGpuMs?.toFixed?.(3)} ms over ${report.timing.frames} frame(s)\n`));
  }

  if (updateBaseline) {
    const body = {
      _comment:
        'Ceilings for how far the C++ render graph (native backend) may differ from the TS WebGPU frame of the SAME FrameScene. '
        + 'A LIST OF DEBTS: every entry is an undiagnosed C++-vs-TS disagreement on a ported scene. Frames not ported yet are '
        + 'not listed (they are reported, never failed). Entries are meant to be removed.',
      tolerance,
      frames: newBaseline,
    };
    await fs.writeFile(baselineFile, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    process.stdout.write(green(`  native baseline written: ${Object.keys(newBaseline).length} divergence(s)\n`));
    return errors.length;
  }

  for (const e of errors) process.stdout.write(red(`  x ${e.id} - native renderer error: ${e.why}\n`));
  for (const w of regressed) process.stdout.write(red(`  x ${w.id} ${pct(w.ratio)} - WORSE than its ${pct(w.ceiling)} ceiling\n`));
  for (const w of unlisted) process.stdout.write(red(`  x ${w.id} ${pct(w.ratio)} - differs from webgpu by more than ${pct(tolerance)}\n`));
  for (const w of improved.slice(0, 5)) process.stdout.write(green(`  v ${w.id} ${pct(w.ratio)} - better than its ${pct(w.ceiling)} ceiling; tighten it\n`));
  return errors.length + regressed.length + unlisted.length;
}
