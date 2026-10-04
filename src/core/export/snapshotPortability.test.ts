/**
 * Whether a project snapshot can be rendered by the export supervisor's hidden
 * window — the gate that keeps editor-only `blob:` footage off the out-of-process
 * path (see snapshotPortability.ts).
 */

import { setLocalFirst } from '@core/config/flags';
import {
  currentProjectSnapshotIsPortable,
  snapshotIsPortable,
  uncarriableMedia,
} from './snapshotPortability';

beforeEach(() => {
  setLocalFirst(false);
});
afterAll(() => setLocalFirst(false));

describe('uncarriableMedia', () => {
  const library = [{ id: 'a1', src: 'blob:app/1' }, { id: 'a2', src: 'motion-blob:abc' }];

  it('durable srcs always travel', () => {
    expect(uncarriableMedia([
      { src: 'https://cdn.example/x.mp4' },
      { src: 'data:image/png;base64,AAA' },
      { src: 'C:\\footage\\a.mov' },
      { src: '' },
    ], library)).toEqual([]);
  });

  it('a blob: backed by a library blob: is collected by the bundle save', () => {
    expect(uncarriableMedia([{ assetId: 'a1', src: 'blob:app/1' }], library)).toEqual([]);
  });

  it('already-collected footage stays behind in the source bundle', () => {
    // The snapshot is a fresh bundle; the hidden window resolves motion-blob:
    // against it, and the collector skips these as already local.
    const collected = { assetId: 'a2', src: 'motion-blob:abc' };
    const staleOverCollected = { assetId: 'a2', src: 'blob:app/stale' };
    expect(uncarriableMedia([collected, staleOverCollected], library)).toEqual([collected, staleOverCollected]);
  });

  it('a blob: with no library entry behind it cannot travel', () => {
    const orphan = { src: 'blob:app/9' };
    const unknownId = { assetId: 'gone', src: ' blob:app/8' };
    expect(uncarriableMedia([orphan, unknownId, { assetId: 'a1', src: 'blob:app/1' }], library)).toEqual([orphan, unknownId]);
  });
});

describe('snapshotIsPortable', () => {
  it('is false off local-first whatever the footage — the snapshot is a single JSON', () => {
    expect(snapshotIsPortable({ localFirst: false, refs: [], library: [] })).toBe(false);
    expect(snapshotIsPortable({ localFirst: false, refs: [{ src: 'https://x/y.png' }], library: [] })).toBe(false);
  });

  it('on local-first, true unless a layer holds an uncollectable blob:', () => {
    expect(snapshotIsPortable({ localFirst: true, refs: [], library: [] })).toBe(true);
    expect(snapshotIsPortable({ localFirst: true, refs: [{ assetId: 'a', src: 'blob:1' }], library: [{ id: 'a', src: 'blob:1' }] })).toBe(true);
    expect(snapshotIsPortable({ localFirst: true, refs: [{ src: 'blob:1' }], library: [] })).toBe(false);
  });
});

describe('the live project', () => {
  it('currentProjectSnapshotIsPortable: the flag, then the footage items', () => {
    const footage = [{ id: 'a1', src: 'blob:1' }];
    expect(currentProjectSnapshotIsPortable(footage)).toBe(false);
    setLocalFirst(true);
    expect(currentProjectSnapshotIsPortable(footage)).toBe(true);
    expect(currentProjectSnapshotIsPortable([{ id: 'a2', src: 'motion-blob:abc' }])).toBe(false);
    expect(currentProjectSnapshotIsPortable([])).toBe(true);
  });
});
