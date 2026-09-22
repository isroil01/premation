/**
 * The encoder probe against a FAKE ffmpeg: which encoders it lists, which of
 * them "work", how often it is asked, and what the export gets told.
 */

import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { EncoderProbe } from './encoderProbe';

const LIST = [
  'Encoders:',
  ' V..... = Video',
  ' ------',
  ' V....D libx264              libx264 H.264',
  ' V....D libx265              libx265 H.265',
  ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder',
  ' V..... h264_qsv             Intel Quick Sync',
].join('\n');

/** A spawn that answers `-encoders` with LIST and smoke encodes from a table. */
function fakeSpawn(works: Record<string, boolean>, log: string[][] = []) {
  const impl = ((_bin: string, args: string[]) => {
    log.push(args);
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => undefined;
    // setTimeout, not setImmediate: jest's jsdom environment has no setImmediate.
    setTimeout(() => {
      if (args.includes('-encoders')) {
        proc.stdout.emit('data', Buffer.from(LIST));
        proc.emit('close', 0);
        return;
      }
      const name = args[args.indexOf('-c:v') + 1]!;
      if (works[name]) proc.emit('close', 0);
      else {
        proc.stderr.emit('data', Buffer.from('Cannot load nvcuda.dll'));
        proc.emit('close', 1);
      }
    }, 0);
    return proc;
  }) as unknown as typeof spawn;
  return { impl, log };
}

describe('EncoderProbe', () => {
  it('lists once, smoke-encodes each hardware encoder once, and caches both', async () => {
    const { impl, log } = fakeSpawn({ h264_nvenc: true, h264_qsv: false });
    const probe = new EncoderProbe({ bin: () => 'ffmpeg', spawnImpl: impl });
    expect(await probe.has('libx265')).toBe(true);
    expect(await probe.has('libx265')).toBe(true);
    expect(await probe.availableHw()).toEqual(['h264_nvenc']);
    expect(await probe.availableHw()).toEqual(['h264_nvenc']);
    // One listing, one smoke encode per listed hardware encoder — never more.
    expect(log.filter((a) => a.includes('-encoders'))).toHaveLength(1);
    expect(log.filter((a) => a.includes('-f') && a.includes('null'))).toHaveLength(2);
  });

  it('the smoke encode is two frames of a synthetic source into a null muxer', async () => {
    const { impl, log } = fakeSpawn({ h264_nvenc: true });
    const probe = new EncoderProbe({ bin: () => 'ffmpeg', spawnImpl: impl });
    expect(await probe.works('h264_nvenc')).toBe(true);
    const smoke = log.find((a) => a.includes('-c:v'))!;
    expect(smoke).toEqual(expect.arrayContaining(['-nostdin', '-f', 'lavfi', '-frames:v', '2', '-c:v', 'h264_nvenc', 'null', '-']));
  });

  it('resolves the requested encoder when it works, libx264 with a reason otherwise', async () => {
    const { impl } = fakeSpawn({ h264_nvenc: true, h264_qsv: false });
    const probe = new EncoderProbe({ bin: () => 'ffmpeg', spawnImpl: impl });
    expect(await probe.resolveVideoEncoder(undefined)).toEqual({ encoder: 'libx264' });
    expect(await probe.resolveVideoEncoder('libx264')).toEqual({ encoder: 'libx264' });
    expect(await probe.resolveVideoEncoder('h264_nvenc')).toEqual({ encoder: 'h264_nvenc' });
    const qsv = await probe.resolveVideoEncoder('h264_qsv');
    expect(qsv.encoder).toBe('libx264');
    expect(qsv.fallbackReason).toMatch(/failed to initialise/);
    const vt = await probe.resolveVideoEncoder('h264_videotoolbox');
    expect(vt.encoder).toBe('libx264');
    expect(vt.fallbackReason).toMatch(/no h264_videotoolbox encoder/);
    const junk = await probe.resolveVideoEncoder('h264_amf' as never);
    expect(junk.encoder).toBe('libx264');
    expect(junk.fallbackReason).toMatch(/not a supported/);
  });

  it('a missing ffmpeg lists nothing and every hardware request falls back', async () => {
    const impl = (() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => undefined;
      setTimeout(() => proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), 0);
      return proc;
    }) as unknown as typeof spawn;
    const probe = new EncoderProbe({ bin: () => 'nope', spawnImpl: impl });
    expect(await probe.availableHw()).toEqual([]);
    expect((await probe.resolveVideoEncoder('h264_nvenc')).encoder).toBe('libx264');
  });

  it('a probe that never exits is abandoned as not working', async () => {
    const impl = (() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      return proc;
    }) as unknown as typeof spawn;
    const probe = new EncoderProbe({ bin: () => 'ffmpeg', spawnImpl: impl, timeoutMs: 20 });
    expect(await probe.has('libx264')).toBe(false);
  });
});
