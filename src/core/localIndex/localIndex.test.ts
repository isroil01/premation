/**
 * The local index: the pure facts projector + the in-memory query backend.
 * Covers card facts (from the primary comp + scene), recents ordering, the
 * missing-bundle filter, and recovery bookkeeping.
 */

import { deriveProjectFacts } from './projectFacts';
import { MemoryLocalIndex } from './LocalIndex';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { ProjectIndexRow } from './types';

describe('deriveProjectFacts', () => {
  it('reads size/fps/duration from the primary comp and counts scene nodes', () => {
    const doc = {
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      animation: { tracks: {}, expressions: {} },
      comps: {
        main: { id: 'main', name: 'Main', width: 1920, height: 1080, fps: 30, durationSeconds: 12, background: '#000', transparent: false, startFrame: 0 },
      },
    } as unknown as EditorDocument;
    expect(deriveProjectFacts(doc)).toEqual({ width: 1920, height: 1080, fps: 30, durationSeconds: 12, layerCount: 3 });
  });

  it('falls back to the legacy single comp', () => {
    const doc = {
      version: '1.0.0',
      scene: { version: '1.0.0', nodes: [] },
      animation: { tracks: {}, expressions: {} },
      comp: { id: 'c', name: 'C', width: 800, height: 600, fps: 24, durationSeconds: 5, background: '#000', transparent: false, startFrame: 0 },
    } as unknown as EditorDocument;
    expect(deriveProjectFacts(doc)).toMatchObject({ width: 800, height: 600, fps: 24, durationSeconds: 5, layerCount: 0 });
  });

  it('yields zeros for a sparse/legacy document rather than throwing', () => {
    expect(deriveProjectFacts({ version: '1.0.0' } as EditorDocument)).toEqual({
      width: 0, height: 0, fps: 0, durationSeconds: 0, layerCount: 0,
    });
  });
});

function row(id: string, over: Partial<ProjectIndexRow> = {}): ProjectIndexRow {
  return {
    id, bundlePath: `/p/${id}.motion`, name: id,
    width: 1920, height: 1080, fps: 30, durationSeconds: 10, layerCount: 1,
    rev: 1, updatedAt: 1000, ...over,
  };
}

describe('MemoryLocalIndex projects', () => {
  it('upsert then get returns a copy of the row', async () => {
    const idx = new MemoryLocalIndex();
    await idx.upsertProject(row('a'));
    expect(await idx.getProject('a')).toMatchObject({ id: 'a', width: 1920 });
    expect(await idx.getProject('missing')).toBeNull();
  });

  it('lists most-recently-opened first', async () => {
    const idx = new MemoryLocalIndex();
    await idx.upsertProject(row('old', { openedAt: 100 }));
    await idx.upsertProject(row('new', { openedAt: 300 }));
    await idx.upsertProject(row('mid', { openedAt: 200 }));
    expect((await idx.listProjects()).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('hides missing bundles unless asked, and honors limit', async () => {
    const idx = new MemoryLocalIndex();
    await idx.upsertProject(row('here', { openedAt: 2 }));
    await idx.upsertProject(row('gone', { openedAt: 1, missing: true }));
    expect((await idx.listProjects()).map((r) => r.id)).toEqual(['here']);
    expect((await idx.listProjects({ includeMissing: true })).map((r) => r.id)).toEqual(['here', 'gone']);
    expect((await idx.listProjects({ includeMissing: true, limit: 1 })).map((r) => r.id)).toEqual(['here']);
  });

  it('markMissing flips the flag; removeProject deletes', async () => {
    const idx = new MemoryLocalIndex();
    await idx.upsertProject(row('a'));
    await idx.markMissing('a', true);
    expect((await idx.getProject('a'))!.missing).toBe(true);
    await idx.removeProject('a');
    expect(await idx.getProject('a')).toBeNull();
  });
});

describe('MemoryLocalIndex recovery', () => {
  it('adds, lists, and clears recovery snapshots per project', async () => {
    const idx = new MemoryLocalIndex();
    await idx.addRecovery({ projectId: 'a', snapshotPath: '/r/a/1', createdAt: 10, rev: 1 });
    await idx.addRecovery({ projectId: 'a', snapshotPath: '/r/a/2', createdAt: 20, rev: 2 });
    expect(await idx.listRecovery('a')).toHaveLength(2);
    await idx.clearRecovery('a');
    expect(await idx.listRecovery('a')).toEqual([]);
  });
});
