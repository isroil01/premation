#!/usr/bin/env node
/**
 * F1 parity + speed: the engine's export jobs against today's Chromium raw pipe.
 *
 *   node scripts/bench-export-engine.cjs [--frames 300] [--formats mp4,mov]
 *        [--scenes a,b,c] [--scenes-dir DIR] [--scene-frames 30] [--threads N]
 *        [--label TEXT] [--repeat 2] [--keep] [--out report.json]
 *
 * The "8 cores" measurement confines the whole run (node, Electron, the engine,
 * ffmpeg — children inherit it) to 8 logical CPUs:
 *   cmd /c start /affinity FF /wait node scripts/bench-export-engine.cjs …
 *
 * Both renderers are run END TO END, from process start to a delivered file:
 *   chromium  the real headless CLI (`premation render`, a hidden window, the
 *             raw pipe into main's ffmpeg) — the path scripts/bench-export-
 *             pipeline.cjs measured at 121 fps;
 *   engine    `premation-engine --export`, driven through dist-electron/
 *             engineExport.js — the supervisor's own launcher — so the ffmpeg
 *             command line is the one the supervisor sends.
 *
 * Checks, per project:
 *   raw       FFMPEG_PATH / the encoder replaced by premation-export-sink: the
 *             exact straight-RGBA byte streams each renderer hands its encoder,
 *             compared frame by frame (md5, max channel delta, pixels > 0 / > 16);
 *   encoded   real ffmpeg at the same settings: file md5 (the plan's "md5-
 *             identical output") and wall-clock fps.
 *
 * Projects: the export benchmark fixture (1920x1080, 6 shapes + 3 texts), a
 * heavy variant (MOTION_EXPORT_BENCH_SHAPES / _TEXTS), and render-tests scenes
 * (read-only: their project.json files are opened in place, never written).
 *
 * Needs `npx tsc -p electron/tsconfig.json`, a renderer build in dist/
 * (`vite build`, local edition), the engine preset built, and ffmpeg.
 */

const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const MAIN = path.join(REPO, 'dist-electron', 'main.js');
const RENDERER = path.join(REPO, 'dist', 'index.html');
const PRESET = process.platform === 'win32' ? 'windows-clang-cl-engine' : process.platform === 'darwin' ? 'macos-clang-engine' : 'linux-clang-engine';
const EXE = process.platform === 'win32' ? '.exe' : '';
const ENGINE_DIR = path.join(REPO, 'native', 'build', PRESET, 'engine');
const ENGINE = path.join(ENGINE_DIR, `premation-engine${EXE}`);
const SINK = path.join(ENGINE_DIR, `premation-export-sink${EXE}`);

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const FRAMES = Number(arg('frames', '300'));
const FORMATS = arg('formats', 'mp4').split(',');
const SCENES = arg('scenes', '').split(',').filter(Boolean);
const SCENES_DIR = arg('scenes-dir', path.join(REPO, '..', '..', '..', 'packages', 'render-tests', '.artifacts', 'scenes'));
const SCENE_FRAMES = Number(arg('scene-frames', '30'));
const THREADS = arg('threads', '');
const LABEL = arg('label', '');
const REPEAT = Number(arg('repeat', '1'));
const KEEP = argv.includes('--keep');
const SKIP_HEAVY = argv.includes('--no-heavy');
const SKIP_BENCH = argv.includes('--no-bench');
const REPORT = arg('out', '');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
for (const [what, p] of [['dist-electron', MAIN], ['dist renderer', RENDERER], ['premation-engine', ENGINE], ['premation-export-sink', SINK]]) {
  if (!existsSync(p)) {
    console.error(`[bench-export-engine] missing ${what}: ${p}`);
    process.exit(2);
  }
}

const { startEngineExport } = require(path.join(REPO, 'dist-electron', 'engineExport.js'));
const electron = require(path.join(REPO, 'node_modules', 'electron'));
const work = mkdtempSync(path.join(tmpdir(), 'bench-export-engine-'));

function genFixture(name, env) {
  const file = path.join(work, `${name}.json`);
  const r = spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'jest', 'bin', 'jest.js'), 'src/core/export/exportBenchFixture.test.ts'], {
    cwd: REPO, env: { ...process.env, MOTION_EXPORT_BENCH_FIXTURE: file, ...env }, encoding: 'utf8',
  });
  if (!existsSync(file)) throw new Error(`fixture ${name} failed:\n${r.stdout}\n${r.stderr}`);
  return file;
}

function chromium(project, format, range, out, sink) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MOTION_EDITION: 'local' };
    delete env.MOTION_EXPORT_PIPELINE;
    if (sink) env.FFMPEG_PATH = SINK;
    const started = Date.now();
    const n = range[1] - range[0] + 1;
    const child = spawn(electron, [MAIN, 'render', project, '--format', format, '--range', `${range[0]}-${range[1]}`, '--out', out, '--json'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let buf = '';
    // Steady state: from the first progress event (the first frame is in the
    // pipe) to the end — the same span the engine's `renderMs` covers.
    let first = null;
    child.stdout.on('data', (d) => {
      log += d;
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (first || !line.startsWith('{"event":"progress"')) continue;
        try { first = { t: Date.now(), f: JSON.parse(line).fraction }; } catch { /* not ours */ }
      }
    });
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const end = Date.now();
      const ms = end - started;
      if (code !== 0 || !existsSync(out)) {
        reject(new Error(`chromium ${format} exited ${code}:\n${log.slice(-1500)}`));
        return;
      }
      const renderFps = first && end > first.t ? (n * (1 - first.f)) / ((end - first.t) / 1000) : null;
      resolve({ ms, renderFps });
    });
  });
}
let jobSeq = 0;
function engine(project, format, range, out, sink) {
  const id = `e${++jobSeq}`;
  const spec = { projectPath: project, outPath: out, format, startFrame: range[0], endFrame: range[1] };
  const started = Date.now();
  const deps = {
    enginePath: ENGINE,
    ffmpegPath: () => (sink ? SINK : ffmpeg),
    workDirFor: (jid) => path.join(work, 'engine', jid),
    log: (m) => console.log(`  [engine] ${m}`),
  };
  // The job file is written by the launcher; a thread override rides in the environment.
  if (THREADS) process.env.PREMATION_EXPORT_THREADS = THREADS;
  const run = startEngineExport(id, spec, { progress: () => undefined }, deps);
  return run.done.then((o) => {
    const ms = Date.now() - started;
    if (o.kind !== 'completed') throw new Error(`engine ${format}: ${o.kind}: ${o.reason ?? o.message ?? ''}`);
    return { ms, stats: o.stats };
  });
}

function md5(file) {
  return createHash('md5').update(readFileSync(file)).digest('hex');
}

/** Frame-by-frame comparison of two raw RGBA streams. */
function compareRaw(a, b, frameBytes) {
  const sa = statSync(a).size;
  const sb = statSync(b).size;
  const frames = Math.min(sa, sb) / frameBytes;
  const fa = openSync(a, 'r');
  const fb = openSync(b, 'r');
  const ba = Buffer.alloc(frameBytes);
  const bb = Buffer.alloc(frameBytes);
  let identical = 0;
  let maxDelta = 0;
  let px0 = 0;
  let px16 = 0;
  for (let f = 0; f < frames; f++) {
    readSync(fa, ba, 0, frameBytes, f * frameBytes);
    readSync(fb, bb, 0, frameBytes, f * frameBytes);
    if (ba.equals(bb)) { identical++; continue; }
    for (let i = 0; i < frameBytes; i += 4) {
      let m = 0;
      for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(ba[i + c] - bb[i + c]));
      if (m > 0) px0++;
      if (m > 16) px16++;
      if (m > maxDelta) maxDelta = m;
    }
  }
  closeSync(fa);
  closeSync(fb);
  const pixels = frames * (frameBytes / 4);
  return {
    sizes: sa === sb ? sa : `${sa} vs ${sb}`,
    frames,
    identicalFrames: identical,
    md5Equal: sa === sb && md5(a) === md5(b),
    maxDelta,
    pctPixelsDiffer: pixels ? +(100 * px0 / pixels).toFixed(4) : 0,
    pctOver16: pixels ? +(100 * px16 / pixels).toFixed(4) : 0,
  };
}

function compSize(project) {
  const doc = JSON.parse(readFileSync(project, 'utf8'));
  const comps = doc.comps ?? {};
  const first = Object.values(comps).find((c) => !c.pristine) ?? Object.values(comps)[0] ?? {};
  return { w: first.width ?? 1920, h: first.height ?? 1080, fps: first.fps ?? 30, dur: first.durationSeconds ?? 10 };
}

(async () => {
  const rows = [];
  const projects = [];
  if (!SKIP_BENCH) projects.push({ name: 'bench-1080p (6 shapes + 3 text)', file: genFixture('bench', {}), frames: FRAMES, speed: true });
  if (!SKIP_HEAVY) projects.push({ name: 'heavy-1080p (300 shapes + 12 text)', file: genFixture('heavy', { MOTION_EXPORT_BENCH_SHAPES: '300', MOTION_EXPORT_BENCH_TEXTS: '12' }), frames: FRAMES, speed: true });
  for (const s of SCENES) projects.push({ name: s, file: path.join(SCENES_DIR, s, 'project.json'), frames: SCENE_FRAMES, speed: false });

  for (const p of projects) {
    const size = compSize(p.file);
    const total = Math.max(1, Math.round(size.dur * size.fps));
    const range = [0, Math.min(total, p.frames) - 1];
    const n = range[1] - range[0] + 1;
    const row = { project: p.name, size: `${size.w}x${size.h}`, frames: n };
    // Raw streams (pre-encode bytes).
    try {
      const rc = path.join(work, `${rows.length}-chromium-raw.mov`);
      const re = path.join(work, `${rows.length}-engine-raw.mov`);
      const c = await chromium(p.file, 'mov', range, rc, true);
      const e = await engine(p.file, 'mov', range, re, true);
      row.raw = compareRaw(rc, re, size.w * size.h * 4);
      // No encoder at all (the sink): the pipelines' own throughput.
      row.raw.chromiumFps = +(n / (c.ms / 1000)).toFixed(1);
      row.raw.engineFps = +(n / (e.ms / 1000)).toFixed(1);
      row.raw.chromiumRenderFps = c.renderFps ? +c.renderFps.toFixed(1) : null;
      row.raw.engineRenderFps = e.stats ? +Number(e.stats.fps).toFixed(1) : null;
      row.raw.engineStats = e.stats;
      if (!KEEP) {
        rmSync(rc, { force: true });
        rmSync(re, { force: true });
      }
    } catch (err) {
      row.raw = { error: String(err.message ?? err).slice(0, 400) };
    }
    if (!p.speed) {
      // The delivered files at the same settings, real ffmpeg: md5.
      for (const format of FORMATS) {
        try {
          const oc = path.join(work, `${rows.length}-c.${format}`);
          const oe = path.join(work, `${rows.length}-e.${format}`);
          await chromium(p.file, format, range, oc, false);
          await engine(p.file, format, range, oe, false);
          row[format] = { md5Identical: md5(oc) === md5(oe) };
        } catch (err) {
          row[format] = { error: String(err.message ?? err).slice(0, 400) };
        }
      }
    }
    if (p.speed) {
      for (const format of FORMATS) {
        const best = { chromium: Infinity, engine: Infinity, chromiumRender: 0 };
        let stats;
        let same;
        try {
          // Warm-up (shader caches, font caches) for each side, not measured.
          await chromium(p.file, format, range, path.join(work, `warm-c.${format}`), false).catch(() => undefined);
          await engine(p.file, format, range, path.join(work, `warm-e.${format}`), false).catch(() => undefined);
          for (let k = 0; k < REPEAT; k++) {
            const oc = path.join(work, `c.${format}`);
            const oe = path.join(work, `e.${format}`);
            const c = await chromium(p.file, format, range, oc, false);
            const e = await engine(p.file, format, range, oe, false);
            best.chromium = Math.min(best.chromium, c.ms);
            best.chromiumRender = Math.max(best.chromiumRender, c.renderFps ?? 0);
            if (e.ms < best.engine) { best.engine = e.ms; stats = e.stats; }
            same = md5(oc) === md5(oe);
          }
          row[format] = {
            chromiumFps: +(n / (best.chromium / 1000)).toFixed(1),
            engineFps: +(n / (best.engine / 1000)).toFixed(1),
            speedup: +(best.chromium / best.engine).toFixed(2),
            chromiumRenderFps: +best.chromiumRender.toFixed(1),
            engineRenderFps: stats ? +Number(stats.fps).toFixed(1) : null,
            renderSpeedup: stats && best.chromiumRender ? +(Number(stats.fps) / best.chromiumRender).toFixed(2) : null,
            md5Identical: same,
            engineStats: stats,
          };
        } catch (err) {
          row[format] = { error: String(err.message ?? err).slice(0, 400) };
        }
      }
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  if (REPORT) writeFileSync(REPORT, JSON.stringify({ label: LABEL || null, cpus: require('node:os').cpus().length, rows }, null, 2));
  if (!KEEP) rmSync(work, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
