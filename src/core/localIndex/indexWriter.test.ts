/**
 * indexWriter — the behaviours that make the index a truthful cache: saves
 * bump the revision, opens don't, thumbs attach without clobbering facts,
 * and an index failure never escapes into the save path.
 */

import { MemoryLocalIndex, setLocalIndex, getLocalIndex } from './LocalIndex';
import {
  recordProjectSaved,
  recordProjectOpened,
  recordProjectThumb,
  projectNameFromPath,
} from './indexWriter';
import type { EditorDocument } from '@core/api/cloudDocument';

const doc = (layers: number): EditorDocument =>
  ({
    version: '1',
    scene: { nodes: Array.from({ length: layers }, (_, i) => ({ id: `n${i}` })) },
    animation: {},
    comps: { c1: { id: 'c1', width: 1920, height: 1080, fps: 30, durationSeconds: 10 } },
  }) as unknown as EditorDocument;

const PATH = 'C:\\work\\Title Sequence.motion';

beforeEach(() => {
  setLocalIndex(new MemoryLocalIndex());
});

afterEach(() => {
  setLocalIndex(null);
});

describe('projectNameFromPath', () => {
  it('is the basename with .motion stripped, on either slash style', () => {
    expect(projectNameFromPath('C:\\work\\Title Sequence.motion')).toBe('Title Sequence');
    expect(projectNameFromPath('/home/u/projects/Logo.motion')).toBe('Logo');
    expect(projectNameFromPath('/home/u/projects/Logo.motion/')).toBe('Logo');
  });
});

describe('indexWriter', () => {
  it('a save writes facts and bumps the revision; a second save bumps again', async () => {
    await recordProjectSaved(PATH, doc(3));
    let row = await getLocalIndex().getProject(PATH);
    expect(row).toMatchObject({ name: 'Title Sequence', width: 1920, layerCount: 3, rev: 1 });

    await recordProjectSaved(PATH, doc(5));
    row = await getLocalIndex().getProject(PATH);
    expect(row).toMatchObject({ layerCount: 5, rev: 2 });
  });

  it('an open sets openedAt but does NOT bump the revision or updatedAt', async () => {
    await recordProjectSaved(PATH, doc(3));
    const saved = await getLocalIndex().getProject(PATH);
    await recordProjectOpened(PATH, doc(3));
    const opened = await getLocalIndex().getProject(PATH);
    expect(opened!.rev).toBe(saved!.rev);
    expect(opened!.updatedAt).toBe(saved!.updatedAt);
    expect(opened!.openedAt).toBeGreaterThan(0);
  });

  it('a save preserves openedAt and the thumb hash from the previous row', async () => {
    await recordProjectSaved(PATH, doc(3));
    await recordProjectOpened(PATH, doc(3));
    await recordProjectThumb(PATH, 'abc123');
    await recordProjectSaved(PATH, doc(4));
    const row = await getLocalIndex().getProject(PATH);
    expect(row!.openedAt).toBeGreaterThan(0);
    expect(row!.thumbHash).toBe('abc123');
    expect(row!.rev).toBe(2);
  });

  it('a save clears a stale missing flag — the bundle evidently exists again', async () => {
    await recordProjectSaved(PATH, doc(3));
    await getLocalIndex().markMissing(PATH, true);
    await recordProjectSaved(PATH, doc(3));
    const row = await getLocalIndex().getProject(PATH);
    expect(row!.missing).toBe(false);
  });

  it('recordProjectThumb on an unknown path is a silent no-op, not a facts-less row', async () => {
    await recordProjectThumb(PATH, 'abc123');
    expect(await getLocalIndex().getProject(PATH)).toBeNull();
  });

  it('an index failure is swallowed — a save must never break on the cache', async () => {
    setLocalIndex({
      upsertProject: () => Promise.reject(new Error('disk full')),
      getProject: () => Promise.reject(new Error('disk full')),
    } as never);
    await expect(recordProjectSaved(PATH, doc(1))).resolves.toBeUndefined();
  });
});
