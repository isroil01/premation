/**
 * Component thumbnails: the cache and its ready-notification, and the preview
 * document a component is drawn from. The picture itself is the engine's
 * (`renderDocumentStill`), pinned on the real binary in
 * core/engine/__tests__/previewDocumentNative.test.ts; here the still is a stub.
 */

import type { ComponentDef } from '@stores/componentStore';

let answer: Blob | null = new Blob(['png'], { type: 'image/png' });
const asked: Array<{ compId: string; seconds: number; maxSize: number }> = [];
jest.mock('@core/engine/previewDocument', () => {
  const actual = jest.requireActual('@core/engine/previewDocument') as Record<string, unknown>;
  return {
    ...actual,
    previewStill: (doc: { compId: string }, seconds: number, maxSize: number) => {
      asked.push({ compId: doc.compId, seconds, maxSize });
      return Promise.resolve(answer);
    },
  };
});

import {
  componentThumb,
  componentThumbDocument,
  onComponentThumbReady,
  primeComponentThumb,
  componentThumbCacheSize,
  invalidateComponentThumb,
} from './componentThumbs';

const def = (i: number) => ({ id: `comp${i}`, createdAt: 1000 + i }) as unknown as ComponentDef;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const row = (id: string, parent: string | null, children: string[], x: number, y: number, w?: number, h?: number, kind = 'shape') => ({
  row: {
    id, name: id, parent, children,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind, x, y, rotation: 0, ...(w !== undefined ? { width: w, height: h } : {}) } }],
  },
});
const fragmentDef = (id: string, layers: unknown[]): ComponentDef =>
  ({ id, name: id, createdAt: 1, fragment: { version: 1, data: JSON.stringify({ layers }) } }) as unknown as ComponentDef;

interface Doc {
  scene: { nodes: Array<{ id: string; parent: string | null; children: string[]; transform: { position: { x: number; y: number } }; components: Array<{ type: string; props: Record<string, unknown> }> }> };
  animation: { tracks: Record<string, unknown> };
  comps: Record<string, { width: number; height: number; transparent: boolean }>;
}

beforeEach(() => {
  for (let i = 0; i < 200; i++) invalidateComponentThumb(`comp${i}`);
  for (const id of ['one', 'two', 'nested', 'group', 'legacy', 'none', 'broken']) invalidateComponentThumb(id);
  asked.length = 0;
  answer = new Blob(['png'], { type: 'image/png' });
});

describe('component thumbnail cache', () => {
  it('holds at most 128 thumbnails, evicting the least recently used', () => {
    for (let i = 0; i < 128; i++) primeComponentThumb(def(i), `data:image/png;base64,${i}`);
    expect(componentThumbCacheSize()).toBe(128);
    // A hit refreshes recency, so comp0 outlives comp1.
    expect(componentThumb(def(0))).toBe('data:image/png;base64,0');
    primeComponentThumb(def(128), 'data:image/png;base64,128');
    expect(componentThumbCacheSize()).toBe(128);
    expect(componentThumb(def(0))).toBe('data:image/png;base64,0');
    expect(componentThumb(def(1))).toBeNull(); // evicted → miss (asks the engine again)
  });

  it('invalidates every saved version of a component', () => {
    primeComponentThumb(def(5), 'data:x');
    invalidateComponentThumb('comp5');
    expect(componentThumb(def(5))).toBeNull();
  });
});

describe('componentThumb asks the engine once and tells the grid when the picture lands', () => {
  it('a miss returns null, asks ONE still at rest, then caches a data URL and notifies', async () => {
    const d = fragmentDef('one', [row('a', 'comp_root', [], 100, 100, 50, 50)]);
    let ready = 0;
    const off = onComponentThumbReady(() => { ready++; });
    expect(componentThumb(d)).toBeNull();
    expect(componentThumb(d)).toBeNull(); // still in flight: not asked twice
    await wait(50);
    expect(asked).toEqual([{ compId: 'thumb_root', seconds: 0, maxSize: 192 }]);
    expect(ready).toBe(1);
    expect(componentThumb(d)).toMatch(/^data:image\/png;base64,/);
    off();
  });

  it('a component the engine cannot draw stays uncached (the caller keeps its icon) and is asked again later', async () => {
    answer = null;
    const d = fragmentDef('two', [row('a', 'comp_root', [], 100, 100, 50, 50)]);
    let ready = 0;
    const off = onComponentThumbReady(() => { ready++; });
    expect(componentThumb(d)).toBeNull();
    await wait(30);
    expect(ready).toBe(0);
    expect(componentThumb(d)).toBeNull();
    await wait(30);
    expect(asked).toHaveLength(2);
    off();
  });

  it('a component with nothing to draw asks for nothing', async () => {
    expect(componentThumb({ id: 'none', name: 'none', createdAt: 1 } as unknown as ComponentDef)).toBeNull();
    expect(componentThumb({ id: 'broken', name: 'broken', createdAt: 1, fragment: { version: 1, data: 'not json' } } as unknown as ComponentDef)).toBeNull();
    await wait(20);
    expect(asked).toEqual([]);
  });
});

describe('componentThumbDocument', () => {
  const parse = (d: ComponentDef): Doc => JSON.parse(componentThumbDocument(d)!.json) as Doc;

  it('puts the layers under a transparent composition the size of their bounds plus a margin, moved into it', () => {
    const d = fragmentDef('one', [row('a', 'comp_root', [], 1000, 800, 200, 100)]);
    const pd = componentThumbDocument(d)!;
    expect([pd.width, pd.height, pd.compId]).toEqual([224, 124, 'thumb_root']);
    const doc = parse(d);
    expect(doc.comps.thumb_root).toMatchObject({ width: 224, height: 124, transparent: true });
    const [root, layer] = doc.scene.nodes;
    expect(root).toMatchObject({ id: 'thumb_root', parent: null, children: [layer!.id] });
    // Bounds (900..1100, 750..850) → the layer's centre lands at (12 + 100, 12 + 50).
    expect(layer!.parent).toBe('thumb_root');
    expect(layer!.transform.position).toEqual({ x: 112, y: 62 });
    expect(layer!.components[0]!.props).toMatchObject({ x: 112, y: 62, width: 200, height: 100 });
    // The component at rest: no animation rides in a thumbnail.
    expect(doc.animation.tracks).toEqual({});
  });

  it('several top-level layers sit side by side under the root (no wrapper layer)', () => {
    const d = fragmentDef('two', [row('a', 'comp_root', [], 100, 100, 100, 100), row('b', 'comp_root', [], 400, 100, 100, 100)]);
    const doc = parse(d);
    expect(doc.scene.nodes).toHaveLength(3);
    expect(doc.scene.nodes[0]!.children).toHaveLength(2);
    expect(doc.comps.thumb_root).toMatchObject({ width: 424, height: 124 });
    expect(doc.scene.nodes.slice(1).map((n) => n.transform.position.x)).toEqual([62, 362]);
  });

  it('a parented child keeps its LOCAL transform — only the top layer is moved — and its box counts through its parent', () => {
    // The child is 150 px right of its parent's origin in the parent's space.
    const d = fragmentDef('nested', [row('p', 'comp_root', ['c'], 500, 500, 100, 100), row('c', 'p', [], 150, 0, 100, 100)]);
    const doc = parse(d);
    const [, parent, child] = doc.scene.nodes;
    // Bounds: parent 450..550, child 600..700 → 250 wide.
    expect(doc.comps.thumb_root).toMatchObject({ width: 274, height: 124 });
    expect(parent!.transform.position).toEqual({ x: 62, y: 62 });
    expect(child!.parent).toBe(parent!.id);
    expect(parent!.children).toEqual([child!.id]);
    expect(child!.transform.position).toEqual({ x: 150, y: 0 });
    expect(child!.components[0]!.props).toMatchObject({ x: 150, y: 0 });
  });

  it('a group has no box of its own; a layer that states no size counts as 120 × 120', () => {
    const d = fragmentDef('group', [row('g', 'comp_root', ['t'], 300, 300, undefined, undefined, 'group'), row('t', 'g', [], 0, 0)]);
    expect(parse(d).comps.thumb_root).toMatchObject({ width: 144, height: 144 });
  });

  it('reads a legacy saved tree', () => {
    const legacy = {
      id: 'legacy', name: 'Legacy', createdAt: 1,
      root: {
        name: 'Card',
        transform: { position: { x: 50, y: 50 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [{ id: 't', type: 'Transform', props: { __kind: 'shape', x: 50, y: 50, width: 60, height: 40 } }],
        children: [],
      },
    } as unknown as ComponentDef;
    const doc = parse(legacy);
    expect(doc.comps.thumb_root).toMatchObject({ width: 84, height: 64 });
    expect(doc.scene.nodes[1]!.transform.position).toEqual({ x: 42, y: 32 });
  });

  it('answers null for a component that holds nothing', () => {
    expect(componentThumbDocument({ id: 'none', name: 'none', createdAt: 1 } as unknown as ComponentDef)).toBeNull();
    expect(componentThumbDocument(fragmentDef('none', []))).toBeNull();
  });
});
