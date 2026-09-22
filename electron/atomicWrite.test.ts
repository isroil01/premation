/**
 * `writeFileAtomic` against a real temp directory: the target is only ever the
 * old bytes or the complete new bytes, the temp file never survives, and the
 * Windows "target briefly locked" case retries instead of failing the save.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomicWrite';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'atomic-write-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('writeFileAtomic', () => {
  test('writes text and bytes, leaving no temp file behind', async () => {
    const t = path.join(dir, 'p.motion');
    await writeFileAtomic(t, '{"v":1}');
    expect(await readFile(t, 'utf8')).toBe('{"v":1}');
    await writeFileAtomic(t, new Uint8Array([1, 2, 3]));
    expect([...(await readFile(t))]).toEqual([1, 2, 3]);
    expect(await readdir(dir)).toEqual(['p.motion']);
  });

  test('creates parent directories only when asked', async () => {
    const t = path.join(dir, 'a', 'b', 'p.motion');
    await expect(writeFileAtomic(t, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFileAtomic(t, 'x', { mkdirp: true });
    expect(await readFile(t, 'utf8')).toBe('x');
  });

  test('a failed replace keeps the old file intact and removes the temp file', async () => {
    const t = path.join(dir, 'p.motion');
    await writeFile(t, 'OLD');
    const boom = Object.assign(new Error('disk yanked'), { code: 'EIO' });
    await expect(
      writeFileAtomic(t, 'NEW', { rename: async () => { throw boom; } }),
    ).rejects.toBe(boom);
    expect(await readFile(t, 'utf8')).toBe('OLD');
    expect(await readdir(dir)).toEqual(['p.motion']);
  });

  test('retries a transiently locked target (Windows EPERM/EBUSY) and then succeeds', async () => {
    const t = path.join(dir, 'p.motion');
    await writeFile(t, 'OLD');
    const { rename: realRename } = await import('node:fs/promises');
    let failures = 2;
    const slept: number[] = [];
    await writeFileAtomic(t, 'NEW', {
      sleep: async (ms) => { slept.push(ms); },
      rename: async (from, to) => {
        if (failures-- > 0) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        await realRename(from, to);
      },
    });
    expect(await readFile(t, 'utf8')).toBe('NEW');
    expect(slept).toHaveLength(2);
    expect(await readdir(dir)).toEqual(['p.motion']);
  });

  test('gives up on a persistently locked target and keeps the old file', async () => {
    const t = path.join(dir, 'p.motion');
    await writeFile(t, 'OLD');
    await expect(
      writeFileAtomic(t, 'NEW', {
        sleep: async () => {},
        rename: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(await readFile(t, 'utf8')).toBe('OLD');
    expect(await readdir(dir)).toEqual(['p.motion']);
  });
});
