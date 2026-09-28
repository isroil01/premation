/**
 * The render worker's engine path (engineRender.cjs) against a fake
 * `premation-engine --export`: the job file, the encode handed over after the
 * preflight (encode.cjs's matrix on raw RGBA), and the outcomes that send the
 * job back to the offscreen window.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { engineJob, engineEncode, renderViaEngine } = require('./engineRender.cjs') as {
  engineJob: (spec: unknown, projectPath: string, workDir: string) => Record<string, unknown>;
  engineEncode: (output: unknown, pre: unknown, out: string) => string[];
  renderViaEngine: (spec: unknown, dir: string, deps: unknown) => Promise<Record<string, unknown>>;
};

interface FakeProc extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeEngine(script: (p: FakeProc, stdinLines: string[]) => void): { spawn: jest.Mock; lines: string[] } {
  const lines: string[] = [];
  const spawn = jest.fn(() => {
    const p = new EventEmitter() as FakeProc;
    p.stdin = new PassThrough();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin.on('data', (d: Buffer) => lines.push(...String(d).split('\n').filter(Boolean)));
    setTimeout(() => script(p, lines), 0);
    return p;
  });
  return { spawn, lines };
}

const fs = { writeFile: jest.fn(async () => undefined) };
const doc = { comps: { comp_a: { name: 'Main', fps: 30, width: 1080, height: 1920 } } };

describe('render worker through premation-engine --export', () => {
  it('writes the job for the document\'s comp, the duration as a frame range', () => {
    const job = engineJob({ document: doc, output: { codec: 'h264' }, durationSeconds: 2 }, '/w/project.motion', '/w');
    expect(job).toMatchObject({ projectPath: '/w/project.motion', workDir: '/w', comp: 'comp_a', audio: false, transparent: false, startFrame: 0, endFrame: 59 });
    // A transparent request in a container with alpha keeps the comp transparent.
    expect(engineJob({ document: doc, output: { codec: 'prores4444', transparent: true } }, 'p', 'w').transparent).toBe(true);
  });

  it('encodes raw RGBA with the worker\'s h264 matrix', () => {
    const args = engineEncode({ codec: 'h264', quality: 'standard' }, { width: 1080, height: 1920, fps: 30, alpha: false, depth: 8 }, '/w/out.mp4');
    expect(args.slice(0, 10)).toEqual(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1080x1920', '-framerate', '30', '-i']);
    expect(args).toContain('libx264');
    expect(args).toContain('+faststart');
    expect(args[args.length - 1]).toBe('/w/out.mp4');
  });

  it('hands the encoder over after the preflight and delivers the file', async () => {
    const { spawn, lines } = fakeEngine((p, stdin) => {
      p.stdout.write('{"ev":"preflight","ok":true,"frames":60,"width":1080,"height":1920,"fps":30,"alpha":false,"depth":8}\n');
      setTimeout(() => {
        expect(stdin).toHaveLength(1);
        p.stdout.write('{"ev":"progress","frame":60,"total":60}\n{"ev":"done","frames":60}\n');
        p.emit('close', 0, null);
      }, 0);
    });
    const out = await renderViaEngine({ document: doc, output: { codec: 'h264' } }, '/w', { enginePath: '/bin/premation-engine', spawn, fs, ffmpegPath: '/bin/ffmpeg' });
    expect(out).toMatchObject({ kind: 'done', frames: 60, fps: 30 });
    expect(String(out.file)).toMatch(/out\.mp4$/);
    expect(spawn.mock.calls[0]![1][0]).toBe('--export');
    const encode = JSON.parse(lines[0]!).encode as { bin: string; args: string[] };
    expect(encode.bin).toBe('/bin/ffmpeg');
    expect(encode.args).toContain('pipe:0');
  });

  it('reports an unported frame, a missing engine or a crash as `fallback` (the worker fails the job)', async () => {
    const unported = fakeEngine((p) => {
      p.stdout.write('{"ev":"preflight","ok":false,"reason":"frame 3: remote footage"}\n');
      p.emit('close', 3, null);
    });
    expect(await renderViaEngine({ document: doc, output: {} }, '/w', { enginePath: 'e', spawn: unported.spawn, fs }))
      .toMatchObject({ kind: 'fallback', reason: 'preflight: frame 3: remote footage' });
    expect(await renderViaEngine({ document: doc, output: {} }, '/w', { enginePath: null, fs })).toMatchObject({ kind: 'fallback' });
    const crash = fakeEngine((p) => p.emit('close', null, 'SIGSEGV'));
    expect(await renderViaEngine({ document: doc, output: {} }, '/w', { enginePath: 'e', spawn: crash.spawn, fs }))
      .toMatchObject({ kind: 'fallback' });
    const encodeFailed = fakeEngine((p) => {
      p.stdout.write('{"ev":"error","fallback":false,"message":"ffmpeg exited 1"}\n');
      p.emit('close', 1, null);
    });
    expect(await renderViaEngine({ document: doc, output: {} }, '/w', { enginePath: 'e', spawn: encodeFailed.spawn, fs }))
      .toMatchObject({ kind: 'failed', message: 'ffmpeg exited 1' });
  });
});
