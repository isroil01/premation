/**
 * `premation render` through the engine (cliEngineRender.ts): which CLI jobs
 * the engine takes, and the three endings the CLI acts on — done (the file is
 * delivered, the report carries the preflight's size and rate), a CLI feature
 * the engine does not have yet, failed; and `--aspect` through --prepare.
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
  it('takes a plain render and refuses what the engine does not do yet', () => {
    const plain = cliEngineSpec(job({ startFrame: 0, endFrame: 29, quality: 'draft', transparent: false }), ENGINE);
    expect(plain).toEqual({ spec: expect.objectContaining({ projectPath: job().projectPath, format: 'mp4', startFrame: 0, endFrame: 29, quality: 'draft' }) });
    expect(cliEngineSpec(job({ aspect: '9:16' }), ENGINE)).toHaveProperty('spec');
    expect(cliEngineSpec(job({ captionsPath: 'c.srt' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ commandsPath: 'c.jsonl' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ dataPath: 'rows.csv' }), ENGINE)).toHaveProperty('reason');
    expect(cliEngineSpec(job({ scale: 0.5 }), ENGINE)).toEqual({ spec: expect.objectContaining({ scale: 0.5 }) });
    expect(cliEngineSpec(job({ scale: 0.5, width: 960, height: 540 }), ENGINE)).toHaveProperty('spec');
    expect(cliEngineSpec(job({ format: 'png', startFrame: 12, endFrame: 40 }), ENGINE)).toEqual({ spec: expect.objectContaining({ format: 'png', startFrame: 12, endFrame: 12 }) });
    expect(cliEngineSpec(job(), null)).toEqual({ reason: 'premation-engine is not available' });
  });

  it('--aspect: prepares the reframed copy, then renders it targeting the new composition', async () => {
    const prepare = jest.fn(async () => ({ ok: true as const, result: { comp: 'comp_9x16', reframed: { comp: 'comp_9x16', width: 1080, height: 1920 } } }));
    let jobFile = '';
    const r = deps((e) => {
      e.say({ ev: 'preflight', ok: true, frames: 1, width: 1080, height: 1920, fps: 30, alpha: false, depth: 8, audio: null, comp: 'comp_9x16', compName: 'Promo 1080×1920' });
      e.say({ ev: 'done', frames: 1 });
      e.exit(0);
    });
    r.deps.fs!.writeFile = async (_p, text) => { jobFile = text; };
    const out = await runCliEngineRender(job({ aspect: '9:16', comp: 'Promo' }), r.deps, () => undefined, prepare);
    expect(out).toMatchObject({ kind: 'done', width: 1080, height: 1920 });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: job().projectPath, comp: 'Promo', reframe: { ratio: 9 / 16 } }),
      expect.objectContaining({ enginePath: ENGINE }),
    );
    const sent = JSON.parse(jobFile) as { projectPath: string; comp: string };
    expect(sent.comp).toBe('comp_9x16');
    expect(sent.projectPath).toMatch(/project\.motion$/);
  });

  it('--aspect: a failed prepare fails the render, and nothing is exported', async () => {
    const prepare = jest.fn(async () => ({ ok: false as const, message: 'Auto-reframe failed: no footage' }));
    const r = deps(() => { throw new Error('must not spawn'); });
    expect(await runCliEngineRender(job({ aspect: '1:1' }), r.deps, () => undefined, prepare)).toEqual({ kind: 'failed', message: 'Auto-reframe failed: no footage' });
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
    // What the engine does not do yet never starts it.
    const never = deps(() => { throw new Error('spawned'); });
    expect(await runCliEngineRender(job({ dataPath: 'rows.csv' }), never.deps, () => undefined)).toMatchObject({ kind: 'needsEditor' });
  });
});
