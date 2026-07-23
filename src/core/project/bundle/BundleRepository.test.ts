/**
 * BundleRepository — incremental save + load over an in-memory BundleFs.
 *
 * Locks down the two properties the directory-bundle format exists for:
 *  1. A save rewrites ONLY changed chunks (cheap saves, cheap sync).
 *  2. `manifest.json` is written LAST (crash-safety: the index never points at
 *     a chunk that was not written).
 * Plus the round-trip (load returns what save wrote) and pruning of chunks whose
 * content went away.
 */

import { BundleRepository } from './BundleRepository';
import { MemoryBundleFs } from './BundleFs';
import { CHUNK } from './types';
import type { EditorDocument } from '@core/api/cloudDocument';

const ROOT = '/projects/My.motion';

function fullDoc(): EditorDocument {
  return {
    version: '1.1.0',
    scene: { version: '1.0.0', nodes: [{ id: 'box' }] } as never,
    animation: { tracks: { 'box:x': [{ t: 0, value: 10 }] }, expressions: {} } as never,
    comps: { main: { id: 'main', name: 'Main', width: 1280, height: 720, fps: 48, durationSeconds: 7, background: '#123', transparent: false, startFrame: 0 } } as never,
    timelines: { main: { version: 1, duration: 336 } } as never,
  };
}

describe('save → load round-trip', () => {
  it('loads back exactly what was saved', async () => {
    const fs = new MemoryBundleFs();
    const repo = new BundleRepository(fs);
    const doc = fullDoc();
    await repo.save(ROOT, doc);
    expect(await repo.load(ROOT)).toEqual(doc);
  });

  it('load returns null when no bundle exists', async () => {
    const repo = new BundleRepository(new MemoryBundleFs());
    expect(await repo.load('/nothing')).toBeNull();
  });

  it('has() reflects whether a bundle was written', async () => {
    const repo = new BundleRepository(new MemoryBundleFs());
    expect(await repo.has(ROOT)).toBe(false);
    await repo.save(ROOT, fullDoc());
    expect(await repo.has(ROOT)).toBe(true);
  });
});

describe('incremental save', () => {
  it('first save writes every content chunk plus the manifest', async () => {
    const fs = new MemoryBundleFs();
    await new BundleRepository(fs).save(ROOT, fullDoc());
    expect(fs.log).toEqual([
      `write:${CHUNK.scene}`,
      `write:${CHUNK.animation}`,
      `write:${CHUNK.timeline}`,
      `write:${CHUNK.meta}`,
      `write:${CHUNK.manifest}`,
    ]);
  });

  it('second save rewrites only the chunk that changed (+ manifest)', async () => {
    const fs = new MemoryBundleFs();
    const repo = new BundleRepository(fs);
    await repo.save(ROOT, fullDoc());
    fs.log.length = 0; // clear the trace from the first save

    const edited = fullDoc();
    (edited.animation as never as { tracks: Record<string, unknown> }).tracks = {
      'box:x': [{ t: 0, value: 10 }, { t: 2, value: 500 }],
    };
    await repo.save(ROOT, edited);

    expect(fs.log).toEqual([`write:${CHUNK.animation}`, `write:${CHUNK.manifest}`]);
  });

  it('a no-op save still writes nothing but the manifest', async () => {
    const fs = new MemoryBundleFs();
    const repo = new BundleRepository(fs);
    await repo.save(ROOT, fullDoc());
    fs.log.length = 0;
    await repo.save(ROOT, fullDoc()); // identical document
    expect(fs.log).toEqual([`write:${CHUNK.manifest}`]);
  });

  it('deletes a chunk whose content went away', async () => {
    const fs = new MemoryBundleFs();
    const repo = new BundleRepository(fs);
    await repo.save(ROOT, fullDoc());
    fs.log.length = 0;

    const stripped = fullDoc();
    delete stripped.timelines;
    await repo.save(ROOT, stripped);

    expect(fs.log).toContain(`remove:${CHUNK.timeline}`);
    expect(await fs.read(ROOT, CHUNK.timeline)).toBeNull();
    // and the stripped doc still round-trips
    expect((await repo.load(ROOT))!.timelines).toBeUndefined();
  });
});

describe('crash-safety: manifest is written last', () => {
  it('never writes the manifest before a content chunk it references', async () => {
    const fs = new MemoryBundleFs();
    await new BundleRepository(fs).save(ROOT, fullDoc());
    const manifestIdx = fs.log.indexOf(`write:${CHUNK.manifest}`);
    const contentWrites = fs.log.filter((e) => e.startsWith('write:') && e !== `write:${CHUNK.manifest}`);
    // every content write happens before the manifest write
    for (const w of contentWrites) {
      expect(fs.log.indexOf(w)).toBeLessThan(manifestIdx);
    }
    expect(manifestIdx).toBe(fs.log.length - 1);
  });
});
