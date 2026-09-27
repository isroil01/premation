/**
 * The worker's render through the C++ engine: `premation-engine --export
 * JOB.json` (native/engine/src/export/export_job.hpp) opens the document
 * itself, renders the range offline and writes raw RGBA frames straight into
 * the ffmpeg this module hands it — no offscreen window, no staged frames.
 *
 * The encode is encode.cjs's matrix, exactly as the frames path muxes it; only
 * the input differs (`-f rawvideo -pix_fmt rgba … -i pipe:0` instead of a
 * frame sequence).
 *
 * Returns `{ kind: 'fallback' }` whenever the engine cannot take the job — no
 * engine binary, a frame its preflight reports as not ported, a GPU that will
 * not start, an engine crash — and main.cjs then renders the job in its
 * offscreen window as before. A failure of the encode itself is `failed`.
 *
 * Electron-free (spawn and fs injectable) so it is tested against a fake
 * engine (engineRender.test.cjs).
 */

const { spawn: nodeSpawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { encodeArgs, resolveEncode, wantsAlpha } = require('./encode.cjs');

/** Exit codes of `premation-engine --export` (export_job.hpp). */
const EXIT = { ok: 0, failed: 1, fallback: 3, cancelled: 4, usage: 64 };

/**
 * The engine binary: PREMATION_ENGINE_PATH, else the one packaged beside the
 * app (resources/engine), else null (the window path renders everything).
 */
function resolveEngine(env = process.env, resourcesPath = process.resourcesPath, exists = existsSync) {
  const explicit = (env.PREMATION_ENGINE_PATH ?? '').trim();
  if (explicit) return exists(explicit) ? explicit : null;
  if (!resourcesPath) return null;
  const name = process.platform === 'win32' ? 'premation-engine.exe' : 'premation-engine';
  const packaged = path.join(resourcesPath, 'engine', name);
  return exists(packaged) ? packaged : null;
}

/** The composition the engine should render: the document's only / first comp, as renderEntry picks it. */
function firstComp(document) {
  const comps = document && typeof document === 'object' ? document.comps : null;
  if (!comps || typeof comps !== 'object') return null;
  const entry = Object.entries(comps).find(([, c]) => c && typeof c === 'object');
  return entry ? { id: entry[0], ...entry[1] } : null;
}

/** The export job file for `spec` (the worker's { document, output, durationSeconds }). */
function engineJob(spec, projectPath, workDir) {
  const output = spec.output ?? {};
  const job = { projectPath, workDir, audio: false, transparent: wantsAlpha(output) };
  const comp = firstComp(spec.document);
  if (comp && typeof comp.id === 'string') job.comp = comp.id;
  for (const k of ['width', 'height', 'fps']) {
    if (typeof output[k] === 'number' && output[k] > 0) job[k] = output[k];
  }
  const fps = Number(output.fps ?? comp?.fps) || 0;
  if (typeof spec.durationSeconds === 'number' && spec.durationSeconds > 0 && fps > 0) {
    job.startFrame = 0;
    job.endFrame = Math.max(0, Math.ceil(spec.durationSeconds * fps) - 1);
  }
  return job;
}

/** The encoder command line for a preflighted job: raw RGBA on stdin, encode.cjs's matrix out. */
function engineEncode(output, pre, out) {
  return [
    '-y',
    '-f', 'rawvideo', '-pix_fmt', pre.depth === 16 ? 'rgba64le' : 'rgba',
    '-s', `${pre.width}x${pre.height}`,
    '-framerate', String(pre.fps),
    '-i', 'pipe:0',
    ...encodeArgs(output, { hasAudio: false, hasAlphaFrames: pre.alpha, fps: pre.fps }),
    out,
  ];
}

/**
 * Render `spec` into `dir` through the engine. Resolves
 *   { kind: 'done', file, frames, fps }  |  { kind: 'fallback', reason }  |  { kind: 'failed', message }
 * — never rejects.
 */
async function renderViaEngine(spec, dir, deps = {}) {
  const engine = deps.enginePath !== undefined ? deps.enginePath : resolveEngine();
  if (!engine) return { kind: 'fallback', reason: 'premation-engine is not available' };
  const fs = deps.fs ?? fsp;
  const spawn = deps.spawn ?? nodeSpawn;
  const ffmpeg = deps.ffmpegPath ?? 'ffmpeg';
  let container;
  try {
    ({ container } = resolveEncode(spec.output ?? {}));
  } catch (err) {
    return { kind: 'failed', message: err.message };
  }
  const projectPath = path.join(dir, 'project.motion');
  const jobPath = path.join(dir, 'job.json');
  const out = path.join(dir, `out.${container}`);
  try {
    await fs.writeFile(projectPath, JSON.stringify(spec.document ?? {}), 'utf8');
    await fs.writeFile(jobPath, JSON.stringify(engineJob(spec, projectPath, dir)), 'utf8');
  } catch (err) {
    return { kind: 'fallback', reason: `the engine job could not be written: ${err.message}` };
  }

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(engine, ['--export', jobPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ kind: 'fallback', reason: `premation-engine could not start: ${err.message}` });
      return;
    }
    let pre = null;
    let terminal = null;
    let buffered = '';
    let stderrTail = '';
    proc.stderr?.on('data', (d) => { stderrTail = (stderrTail + String(d)).slice(-2048); });
    proc.stdin?.on('error', () => undefined);
    const onLine = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ev === 'preflight') {
        if (msg.ok !== true) {
          terminal = { kind: 'fallback', reason: `preflight: ${String(msg.reason ?? 'a frame is outside the engine port')}` };
          return;
        }
        pre = {
          frames: Number(msg.frames),
          width: Number(msg.width),
          height: Number(msg.height),
          fps: Number(msg.fps),
          alpha: msg.alpha === true,
          depth: msg.depth === 16 ? 16 : 8,
        };
        proc.stdin?.write(`${JSON.stringify({ encode: { bin: ffmpeg, args: engineEncode(spec.output ?? {}, pre, out) } })}\n`);
      } else if (msg.ev === 'progress') {
        deps.progress?.(Number(msg.frame) / (Number(msg.total) || pre?.frames || 1));
      } else if (msg.ev === 'done') {
        terminal = { kind: 'done', file: out, frames: Number(msg.frames), fps: pre?.fps ?? 0 };
      } else if (msg.ev === 'error') {
        terminal = msg.fallback === true
          ? { kind: 'fallback', reason: String(msg.message ?? 'the engine could not render this job') }
          : { kind: 'failed', message: String(msg.message ?? 'the engine render failed') };
      }
    };
    proc.stdout?.on('data', (d) => {
      buffered += String(d);
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    proc.once('error', (err) => resolve({ kind: 'fallback', reason: `premation-engine could not start: ${err.message}` }));
    proc.once('close', (code, signal) => {
      if (buffered.trim()) onLine(buffered.trim());
      if (code === EXIT.ok && terminal?.kind === 'done') resolve(terminal);
      else if (terminal && terminal.kind !== 'done') resolve(terminal);
      else {
        // No terminal line: the engine crashed; its encoder died with it and
        // nothing was delivered — the window path renders the job.
        const why = signal ? `signal ${signal}` : `exit code ${code}`;
        resolve({ kind: 'fallback', reason: `premation-engine stopped unexpectedly (${why})${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}` });
      }
    });
  });
}

module.exports = { EXIT, resolveEngine, engineJob, engineEncode, renderViaEngine };
