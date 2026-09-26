/**
 * The engine export job's protocol against a fake premation-engine: the job
 * file it is handed, the encoder command line it gets back after preflight
 * (the Chromium path's own `buildEncodeArgs`), progress, delivery, and every
 * way a job can end — done, fallback (preflight, crash, no executable), failed,
 * cancelled.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  EXPORT_EXIT,
  engineEncodeArgs,
  engineIneligible,
  engineJobFile,
  startEngineExport,
  type EngineExportDeps,
  type EngineExportSpec,
  type EnginePreflight,
} from './engineExport';
import { buildEncodeArgs, rawVideoInput } from './ffmpegEncodeArgs';

const abs = (...parts: string[]): string => path.join(process.platform === 'win32' ? 'C:\\' : '/', ...parts);

class FakeEngine extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  received: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => {
      for (const l of String(d).split('\n')) if (l.trim()) this.received.push(l.trim());
    });
  }
  say(obj: unknown): void { this.stdout.write(`${JSON.stringify(obj)}\n`); }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    setTimeout(() => this.emit('close', code, signal), 0);
  }
  kill(): boolean { this.killed = true; this.exit(null, 'SIGTERM'); return true; }
}

interface Rig {
  deps: EngineExportDeps;
  engines: FakeEngine[];
  files: Map<string, string>;
  moved: Array<[string, string]>;
  spawned: Array<{ bin: string; args: string[] }>;
}

function rig(enginePath: string | null = abs('bin', 'premation-engine.exe')): Rig {
  const engines: FakeEngine[] = [];
  const files = new Map<string, string>();
  const moved: Array<[string, string]> = [];
  const spawned: Array<{ bin: string; args: string[] }> = [];
  const deps: EngineExportDeps = {
    enginePath,
    ffmpegPath: () => 'ffmpeg',
    workDirFor: (id) => abs('jobs', id, 'engine'),
    spawn: ((bin: string, args: string[]) => {
      spawned.push({ bin, args });
      const e = new FakeEngine();
      engines.push(e);
      return e;
    }) as unknown as EngineExportDeps['spawn'],
    fs: {
      mkdir: async () => undefined,
      writeFile: async (p, t) => { files.set(p, t); },
      rename: async (a, b) => { moved.push([a, b]); },
      copyFile: async () => undefined,
      rm: async () => undefined,
    },
    log: () => undefined,
  };
  return { deps, engines, files, moved, spawned };
}

const spec = (over: Partial<EngineExportSpec> = {}): EngineExportSpec => ({
  projectPath: abs('jobs', 'j1', 'project.motion'),
  outPath: abs('out', 'promo.mp4'),
  format: 'mp4',
  comp: 'comp_1',
  startFrame: 0,
  endFrame: 47,
  fps: 24,
  width: 1920,
  height: 1080,
  quality: 'high',
  transparent: false,
  ...over,
});

const pre: EnginePreflight = { frames: 48, width: 1920, height: 1080, fps: 24, alpha: false, depth: 8, audio: abs('jobs', 'j1', 'engine', 'audio.wav'), comp: 'comp_1', compName: 'Promo' };

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

describe('engineIneligible', () => {
  it('takes the streamable formats and nothing that needs the editor', () => {
    const exe = abs('bin', 'premation-engine.exe');
    expect(engineIneligible(spec(), exe)).toBeNull();
    expect(engineIneligible(spec({ format: 'gif' }), exe)).toBeNull();
    expect(engineIneligible(spec(), null)).toMatch(/not available/);
    expect(engineIneligible(spec({ format: 'png-sequence' }), exe)).toBeNull();
    expect(engineIneligible(spec({ format: 'jpg-sequence' }), exe)).toMatch(/jpg-sequence/);
    expect(engineIneligible(spec({ chapters: [{ t: 0, title: 'A' }] }), exe)).toMatch(/chapters/);
    expect(engineIneligible(spec({ chapters: [{ startMs: 0, endMs: 1000, title: 'Intro' }] }), exe)).toBeNull();
    expect(engineIneligible(spec({ videoEncoder: 'h264_nvenc' }), exe)).toBeNull();
    expect(engineEncodeArgs(spec({ videoEncoder: 'h264_nvenc' }), pre, abs('w', 'out.mp4'))).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc']));
    expect(engineIneligible(spec({ videoEncoder: 'libx264' }), exe)).toBeNull();
  });
});

describe('the job file and the encoder command line', () => {
  it('passes the spec through and skips the mix for a GIF', () => {
    const job = engineJobFile(spec(), abs('w'));
    expect(job).toMatchObject({ projectPath: spec().projectPath, workDir: abs('w'), comp: 'comp_1', startFrame: 0, endFrame: 47, fps: 24, width: 1920, height: 1080, transparent: false, audio: true });
    expect(engineJobFile(spec({ format: 'gif' }), abs('w')).audio).toBe(false);
    expect(engineJobFile(spec({ format: 'png-sequence' }), abs('w'))).toMatchObject({ sequence: 'png-zip', audio: false });
    expect(engineJobFile(spec({ chapters: [{ startMs: 0, endMs: 1000, title: 'Intro' }] }), abs('w')).chapters).toEqual([{ startMs: 0, endMs: 1000, title: 'Intro' }]);
  });

  it('is render:openStream\'s command line, byte for byte', () => {
    const out = abs('w', 'out.mp4');
    expect(engineEncodeArgs(spec(), pre, out)).toEqual(buildEncodeArgs({
      format: 'mp4',
      videoInput: rawVideoInput(1920, 1080, 24),
      frame: { width: 1920, height: 1080, fps: 24 },
      quality: 'high',
      proresProfile: undefined,
      audio: pre.audio,
      chaptersFile: null,
      alpha: false,
      videoEncoder: 'libx264',
      tagSrgb: true,
      out,
    }));
    const mov = engineEncodeArgs(spec({ format: 'mov', proresProfile: '4444' }), { ...pre, alpha: true, audio: null }, abs('w', 'out.mov'));
    expect(mov).toContain('prores_ks');
    expect(mov).toContain('yuva444p10le');
    expect(mov.join(' ')).toContain('setparams=color_primaries=bt709:color_trc=iec61966-2-1');
  });

  it('16-bit: the job asks for depth 16 and the encoder reads rgba64le', () => {
    expect(engineJobFile(spec({ format: 'mov', bitDepth: 16 }), abs('w')).depth).toBe(16);
    expect(engineJobFile(spec({ format: 'mov' }), abs('w'))).not.toHaveProperty('depth');
    const args = engineEncodeArgs(spec({ format: 'mov', proresProfile: '4444', bitDepth: 16 }), { ...pre, depth: 16 }, abs('w', 'out.mov'));
    expect(args.slice(0, 6)).toEqual(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba64le', '-video_size']);
    expect(args).toContain('yuva444p10le');
  });
});

describe('startEngineExport', () => {
  it('preflight → encode → progress → done, then delivers the file', async () => {
    const r = rig();
    const progress: number[] = [];
    const run = startEngineExport('j1', spec(), { progress: (f) => progress.push(f) }, r.deps);
    await until(() => r.engines.length === 1);
    const e = r.engines[0]!;
    const jobPath = abs('jobs', 'j1', 'engine', 'job.json');
    expect(r.spawned[0]).toEqual({ bin: abs('bin', 'premation-engine.exe'), args: ['--export', jobPath] });
    expect(JSON.parse(r.files.get(jobPath)!)).toMatchObject({ projectPath: spec().projectPath });
    e.say({ ev: 'preflight', ok: true, ...pre });
    await until(() => e.received.length === 1);
    const enc = JSON.parse(e.received[0]!).encode;
    expect(enc.bin).toBe('ffmpeg');
    expect(enc.args).toEqual(engineEncodeArgs(spec(), pre, abs('jobs', 'j1', 'engine', 'out.mp4')));
    e.say({ ev: 'progress', frame: 24, total: 48 });
    e.say({ ev: 'progress', frame: 48, total: 48 });
    e.say({ ev: 'done', frames: 48, stats: { fps: 400 } });
    e.exit(EXPORT_EXIT.ok);
    await expect(run.done).resolves.toEqual({ kind: 'completed', frames: 48, stats: { fps: 400 } });
    expect(progress).toEqual([0.5, 1]);
    expect(r.moved).toEqual([[abs('jobs', 'j1', 'engine', 'out.mp4'), abs('out', 'promo.mp4')]]);
  });

  it('an unported frame in preflight falls back, delivering nothing', async () => {
    const r = rig();
    const run = startEngineExport('j1', spec(), { progress: () => undefined }, r.deps);
    await until(() => r.engines.length === 1);
    r.engines[0]!.say({ ev: 'preflight', ok: false, reason: 'frame 12: particles', unported: [{ frame: 12, reason: 'particles' }] });
    r.engines[0]!.exit(EXPORT_EXIT.fallback);
    await expect(run.done).resolves.toEqual({ kind: 'fallback', reason: 'preflight: frame 12: particles' });
    expect(r.moved).toEqual([]);
  });

  it('a crash mid-render (no terminal line) falls back', async () => {
    const r = rig();
    const run = startEngineExport('j1', spec(), { progress: () => undefined }, r.deps);
    await until(() => r.engines.length === 1);
    r.engines[0]!.say({ ev: 'preflight', ok: true, ...pre });
    r.engines[0]!.say({ ev: 'progress', frame: 3, total: 48 });
    r.engines[0]!.exit(3221225477);  // 0xC0000005, an access violation
    const out = await run.done;
    expect(out.kind).toBe('fallback');
    expect((out as { reason: string }).reason).toMatch(/stopped unexpectedly \(exit code 3221225477\)/);
    expect(r.moved).toEqual([]);
  });

  it('an encoder failure fails the job; an engine error with fallback set falls back', async () => {
    const r = rig();
    const a = startEngineExport('j1', spec(), { progress: () => undefined }, r.deps);
    await until(() => r.engines.length === 1);
    r.engines[0]!.say({ ev: 'error', fallback: false, message: 'The encode failed: ffmpeg exited 1' });
    r.engines[0]!.exit(EXPORT_EXIT.failed);
    await expect(a.done).resolves.toEqual({ kind: 'failed', message: 'The encode failed: ffmpeg exited 1' });
    const b = startEngineExport('j2', spec(), { progress: () => undefined }, r.deps);
    await until(() => r.engines.length === 2);
    r.engines[1]!.say({ ev: 'error', fallback: true, message: 'the GPU could not be started' });
    r.engines[1]!.exit(EXPORT_EXIT.fallback);
    await expect(b.done).resolves.toEqual({ kind: 'fallback', reason: 'the GPU could not be started' });
  });

  it('no executable, or one that will not spawn, falls back', async () => {
    const none = startEngineExport('j1', spec(), { progress: () => undefined }, rig(null).deps);
    await expect(none.done).resolves.toMatchObject({ kind: 'fallback' });
    const r = rig();
    const run = startEngineExport('j2', spec(), { progress: () => undefined }, r.deps);
    await until(() => r.engines.length === 1);
    r.engines[0]!.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(run.done).resolves.toMatchObject({ kind: 'fallback', reason: expect.stringMatching(/could not start/) });
  });

  it('cancel asks the engine to stop, and a process that ignores it is killed', async () => {
    const r = rig();
    const run = startEngineExport('j1', spec(), { progress: () => undefined }, r.deps);
    await until(() => r.engines.length === 1);
    r.engines[0]!.say({ ev: 'preflight', ok: true, ...pre });
    await until(() => r.engines[0]!.received.length === 1);
    run.cancel();
    await until(() => r.engines[0]!.received.length === 2);
    expect(JSON.parse(r.engines[0]!.received[1]!)).toEqual({ cancel: true });
    expect(r.engines[0]!.killed).toBe(false);
    // The fake ignores the request; the launcher kills it after its grace period.
    await expect(run.done).resolves.toEqual({ kind: 'cancelled' });
    expect(r.engines[0]!.killed).toBe(true);
    expect(r.moved).toEqual([]);
  }, 10_000);
});
