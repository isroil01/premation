/**
 * ProjectBundleService — the compose logic: save writes the doc AND (optionally)
 * snapshots a version; autosave versions are pruned to the cap; versions restore.
 */

import { ProjectBundleService } from './ProjectBundleService';
import { MemoryBundleFs } from './BundleFs';
import type { EditorDocument } from '@core/api/cloudDocument';

const ROOT = '/p/My.motion';

function doc(anim: unknown): EditorDocument {
  return {
    version: '1.1.0',
    scene: { version: '1.0.0', nodes: [{ id: 'box' }] } as never,
    animation: { tracks: anim, expressions: {} } as never,
  };
}

/** Deterministic clock so createdAt is stable in tests. */
function clockFrom(start: number): () => number {
  let t = start;
  return () => ++t;
}

describe('save', () => {
  it('writes the document and round-trips via load', async () => {
    const svc = new ProjectBundleService(new MemoryBundleFs());
    const d = doc({ 'box:x': [{ t: 0, value: 1 }] });
    await svc.save(ROOT, d);
    expect(await svc.load(ROOT)).toEqual(d);
  });

  it('records a version only when asked', async () => {
    const svc = new ProjectBundleService(new MemoryBundleFs(), undefined, clockFrom(0));
    await svc.save(ROOT, doc({ a: 1 })); // no version
    expect(await svc.listVersions(ROOT)).toEqual([]);
    await svc.save(ROOT, doc({ a: 2 }), { version: { kind: 'manual', label: 'v1' } });
    const vs = await svc.listVersions(ROOT);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ kind: 'manual', label: 'v1', rev: 1 });
  });

  it('prunes autosave versions to the cap and can restore a survivor', async () => {
    const svc = new ProjectBundleService(new MemoryBundleFs(), undefined, clockFrom(0));
    for (let i = 1; i <= 4; i++) {
      await svc.save(ROOT, doc({ a: i }), { version: { kind: 'autosave' }, keepAutosaves: 2 });
    }
    const vs = await svc.listVersions(ROOT);
    expect(vs.map((v) => v.rev)).toEqual([4, 3]); // newest two kept
    const restored = await svc.restoreVersion(ROOT, 3);
    expect((restored!.animation as unknown as { tracks: { a: number } }).tracks.a).toBe(3);
    expect(await svc.restoreVersion(ROOT, 1)).toBeNull(); // pruned
  });
});
