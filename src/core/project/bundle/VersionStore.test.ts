/**
 * VersionStore — snapshot / restore / structural sharing / prune.
 *
 * Verifies the git-tree model: an autosave that only changed animation stores
 * exactly one new object (unchanged chunks are shared), restore reconstructs the
 * exact document, and pruning deletes only the objects a dropped version alone
 * held.
 */

import { VersionStore } from './VersionStore';
import { MemoryBundleFs } from './BundleFs';
import type { EditorDocument } from '@core/api/cloudDocument';

const ROOT = '/p/My.motion';

function doc(anim: unknown): EditorDocument {
  return {
    version: '1.1.0',
    scene: { version: '1.0.0', nodes: [{ id: 'box' }] } as never,
    animation: { tracks: anim, expressions: {} } as never,
    comps: { main: { id: 'main', name: 'Main', width: 1280, height: 720, fps: 48, durationSeconds: 7, background: '#000', transparent: false, startFrame: 0 } } as never,
  };
}

async function countObjects(fs: MemoryBundleFs): Promise<number> {
  return (await fs.list(ROOT)).filter((n) => n.startsWith('versions/objects/')).length;
}

describe('snapshot + restore', () => {
  it('restores the exact document at a revision', async () => {
    const fs = new MemoryBundleFs();
    const vs = new VersionStore(fs, ROOT);
    const d = doc({ 'box:x': [{ t: 0, value: 1 }] });
    const entry = await vs.snapshot(d, { kind: 'manual', createdAt: 1000, label: 'first' });
    expect(entry.rev).toBe(1);
    expect(await vs.restore(1)).toEqual(d);
  });

  it('assigns increasing revisions and lists newest-first', async () => {
    const fs = new MemoryBundleFs();
    const vs = new VersionStore(fs, ROOT);
    await vs.snapshot(doc({ a: 1 }), { kind: 'autosave', createdAt: 1 });
    await vs.snapshot(doc({ a: 2 }), { kind: 'autosave', createdAt: 2 });
    const list = await vs.list();
    expect(list.map((e) => e.rev)).toEqual([2, 1]);
  });
});

describe('structural sharing', () => {
  it('an animation-only change stores just one new object', async () => {
    const fs = new MemoryBundleFs();
    const vs = new VersionStore(fs, ROOT);
    await vs.snapshot(doc({ a: 1 }), { kind: 'autosave', createdAt: 1 });
    const afterFirst = await countObjects(fs); // scene + animation + meta = 3
    await vs.snapshot(doc({ a: 2 }), { kind: 'autosave', createdAt: 2 }); // only animation differs
    const afterSecond = await countObjects(fs);
    expect(afterSecond - afterFirst).toBe(1);
  });
});

describe('prune', () => {
  it('keeps the newest N autosaves and deletes only orphaned objects', async () => {
    const fs = new MemoryBundleFs();
    const vs = new VersionStore(fs, ROOT);
    await vs.snapshot(doc({ a: 1 }), { kind: 'autosave', createdAt: 1 });
    await vs.snapshot(doc({ a: 2 }), { kind: 'autosave', createdAt: 2 });
    await vs.snapshot(doc({ a: 3 }), { kind: 'autosave', createdAt: 3 });

    const removed = await vs.prune('autosave', 2);

    expect((await vs.list()).map((e) => e.rev)).toEqual([3, 2]);
    // rev1's animation object was unique to it → deleted; shared scene/meta stay.
    expect(removed).toHaveLength(1);
    expect(await vs.restore(1)).toBeNull();
    expect(await vs.restore(2)).not.toBeNull();
  });

  it('does not drop objects still shared by a surviving version', async () => {
    const fs = new MemoryBundleFs();
    const vs = new VersionStore(fs, ROOT);
    await vs.snapshot(doc({ a: 1 }), { kind: 'autosave', createdAt: 1 });
    await vs.snapshot(doc({ a: 1 }), { kind: 'autosave', createdAt: 2 }); // identical content
    const removed = await vs.prune('autosave', 1);
    expect(removed).toEqual([]); // everything rev1 held is still referenced by rev2
    expect(await vs.restore(2)).not.toBeNull();
  });
});
