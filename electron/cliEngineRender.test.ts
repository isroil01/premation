/**
 * `premation render` through the engine (cliEngineRender.ts): which CLI jobs
 * the engine takes, and the three endings the CLI acts on — done (the file is
 * delivered, the report carries the preflight's size and rate), fallback (the
 * hidden window renders it), failed.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { CliRenderJob } from './cliArgs';
import { cliEngineSpec, runCliEngineRender } from './cliEngineRender';
import type { EngineExportDeps } from './engineExport';

const abs = (...parts: string[]): string => path.join(process.platform === 'win32' ? 'C:\\' : '/', ...parts);
const ENGINE = abs('bin', 'premation-engine.exe');

class FakeEngine extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  say(obj: unknown): void { this.stdout.write(`${JSON.stringify(obj)}\n`); }
  exit(code: number | null): void {
    this.stdout.end();
    setTimeout(() => this.emit('close', code, null), 0);
  }
  kill(): boolean { this.exit(null); return true; }
}

function deps(script: (e: FakeEngine) => void, enginePath: string | null = ENGINE): { deps: EngineExportDeps; moved: Array<[string, string]> } {
  const moved: Array<[string, string]> = [];
  return {
    moved,
    deps: {
      enginePath,
      ffmpegPath: () => abs('bin', 'ffmpeg.exe'),
      workDirFor: (id) => abs('tmp', id),
      spawn: (() => {
        const e = new FakeEngine();
        setTimeout(() => script(e), 0);
        return e;
      }) as unknown as EngineExportDeps['spawn'],
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        rename: async (a, b) => { moved.push([a, b]); },
        copyFile: async () => undefined,
        rm: async () => undefined,
      },
      log: () => undefined,
    },
  };
}

const job = (over: Partial<CliRenderJob> = {}): CliRenderJob => ({
  projectPath: abs('p', 'Promo.motion'),
  outPath: abs('out', 'promo.mp4'),
  format: 'mp4',
  ...over,
});

describe('premation render through premation-engine --export', () => {
  it('takes a plain render and leaves the editor-only ones to the window', () => {
    const plain = cliEngineSpec(job({ startFrame: 0, endFrame: 29, quality: 'draft', transparent: false }), ENGINE);
    expect(plain).toEqual({ spec: expect.objectContaining({ projectPath: job().projectPath, format: 'mp4', startFrame: 0, endFrame: 29, quality: 'draft' }) });
    expect(cliEngineSpec(job({ aspect: '9:16' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ captionsPath: 'c.srt' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ commandsPath: 'c.jsonl' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ dataPath: 'rows.csv' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ scale: 0.5 }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ scale: 0.5, width: 960, height: 540 }), ENGINE)).toHaveProperty('spec');
    expect(cliEngineSpec(job({ format: 'png' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job(), null)).toEqual({ reason: 'premation-engine is not available' });
  });

  it('renders, delivers the file and reports the preflight size and rate', async () => {
    const r = deps((e) => {
      e.say({ ev: 'preflight', ok: true, frames: 30, width: 1920, height: 1080, fps: 30, alpha: false, depth: 8, audio: null, comp: 'c1', compName: 'Promo' });
      e.say({ ev: 'progress', frame: 30, total: 30 });
      e.say({ ev: 'done', frames: 30 });
      e.exit(0);
    });
    const progress: number[] = [];
    const out = await runCliEngineRender(job(), r.deps, (f) => progress.push(f));
    expect(out).toEqual({ kind: 'done', frames: 30, width: 1920, height: 1080, fps: 30, compositionName: 'Promo' });
    expect(progress).toContain(1);
    expect(r.moved).toHaveLength(1);
    expect(r.moved[0]![0]).toMatch(/out\.mp4$/);
    expect(r.moved[0]![1]).toBe(job().outPath);
  });

  it('fails on an unported frame and on an encoder failure (no window fallback)', async () => {
    const unported = deps((e) => {
      e.say({ ev: 'preflight', ok: false, reason: 'frame 3: a plugin effect' });
      e.exit(3);
    });
    expect(await runCliEngineRender(job(), unported.deps, () => undefined)).toEqual({ kind: 'failed', message: 'The engine could not render this job: preflight: frame 3: a plugin effect' });
    const encoder = deps((e) => {
      e.say({ ev: 'preflight', ok: true, frames: 1, width: 2, height: 2, fps: 30, alpha: false, depth: 8, audio: null, comp: 'c', compName: 'C' });
      e.say({ ev: 'error', fallback: false, message: 'ffmpeg exited 1' });
      e.exit(1);
    });
    expect(await runCliEngineRender(job(), encoder.deps, () => undefined)).toEqual({ kind: 'failed', message: 'ffmpeg exited 1' });
    // Editor-only jobs never start the engine.
    const never = deps(() => { throw new Error('spawned'); });
    expect(await runCliEngineRender(job({ aspect: '1:1' }), never.deps, () => undefined)).toMatchObject({ kind: 'needsEditor' });
  });
});
