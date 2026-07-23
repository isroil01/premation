/**
 * VirtualBundleFs over the jsdom localStorage — the browser build's bundle FS.
 * Confirms chunk keys are namespaced under the bundle root, writes are readable,
 * removes delete, and list/exists only see the given root (not other bundles).
 */

import { VirtualBundleFs } from './bundleFsEnv';

const A = '/proj/A.motion';
const B = '/proj/B.motion';

beforeEach(() => localStorage.clear());

describe('VirtualBundleFs', () => {
  it('writes and reads a chunk', async () => {
    const fs = new VirtualBundleFs();
    await fs.writeAtomic(A, 'scene.json', '{"n":1}');
    expect(await fs.read(A, 'scene.json')).toBe('{"n":1}');
  });

  it('read returns null for a missing chunk', async () => {
    expect(await new VirtualBundleFs().read(A, 'nope.json')).toBeNull();
  });

  it('remove deletes a chunk', async () => {
    const fs = new VirtualBundleFs();
    await fs.writeAtomic(A, 'meta.json', '{}');
    await fs.remove(A, 'meta.json');
    expect(await fs.read(A, 'meta.json')).toBeNull();
  });

  it('list/exists are scoped to one bundle root', async () => {
    const fs = new VirtualBundleFs();
    await fs.writeAtomic(A, 'scene.json', '1');
    await fs.writeAtomic(A, 'animation.json', '2');
    await fs.writeAtomic(B, 'scene.json', '3');
    expect((await fs.list(A)).sort()).toEqual(['animation.json', 'scene.json']);
    expect(await fs.exists(A)).toBe(true);
    expect(await fs.exists('/proj/empty.motion')).toBe(false);
  });
});
