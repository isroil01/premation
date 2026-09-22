/**
 * Whether a project snapshot can be rendered by the export supervisor's hidden
 * window — the gate that keeps editor-only `blob:` footage off the out-of-process
 * path (see snapshotPortability.ts).
 */

interface FakeNode { id: string; components: Array<{ props: Record<string, unknown> }>; children: string[] }
const nodes = new Map<string, FakeNode>();
let roots: string[] = [];

jest.mock('@core/scene/DefaultSceneGraph', () => ({
  __esModule: true,
  default: {
    getRoots: () => roots.map((id) => ({ id })),
    getNode: (id: string) => nodes.get(id),
    getChildren: (id: string) => (nodes.get(id)?.children ?? []).map((c) => ({ id: c })),
  },
}));

import { setLocalFirst } from '@core/config/flags';
import {
  currentProjectSnapshotIsPortable,
  sceneMediaRefs,
  snapshotIsPortable,
  uncarriableMedia,
} from './snapshotPortability';

function node(id: string, props: Record<string, unknown>, children: string[] = []): void {
  nodes.set(id, { id, components: [{ props }], children });
}

beforeEach(() => {
  nodes.clear();
  roots = [];
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

describe('the live scene', () => {
  it('walks every root subtree and both src pairs', () => {
    node('root', { name: 'group' }, ['img', 'aud']);
    node('img', { assetId: 'a1', src: 'blob:1' });
    node('aud', { __assetId: 'a2', __src: 'blob:2' }, ['deep']);
    node('deep', { src: 'blob:3' });
    roots = ['root'];
    const refs = [...sceneMediaRefs()];
    expect(refs).toEqual(expect.arrayContaining([
      { assetId: 'a1', src: 'blob:1' },
      { assetId: 'a2', src: 'blob:2' },
      { src: 'blob:3' },
    ]));
    expect(refs).toHaveLength(3);
  });

  it('currentProjectSnapshotIsPortable: the flag, then the footage', () => {
    node('img', { assetId: 'a1', src: 'blob:1' });
    roots = ['img'];
    const library = [{ id: 'a1', src: 'blob:1' }];
    expect(currentProjectSnapshotIsPortable(library)).toBe(false);
    setLocalFirst(true);
    expect(currentProjectSnapshotIsPortable(library)).toBe(true);
    expect(currentProjectSnapshotIsPortable([])).toBe(false);
  });
});
