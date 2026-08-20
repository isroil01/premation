/**
 * Field separation — the pure pixel loop, plus the asset → snapshot threading
 * (mirroring alphaInterpretation.test.ts, because Fields is the same kind of
 * statement: about the FILE, user-set, default = the pre-existing behaviour).
 */

import { deinterlaceData } from './deinterlace';
import { buildSnapshot } from './buildSnapshot';
import { interpretationOf } from '@core/source/sourceInfo';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { useAssetStore } from '@stores/assetStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

// ── The pure loop ────────────────────────────────────────────────────

/** A w×h RGBA buffer where every pixel of row y is (v(y), v(y), v(y), 255). */
function rows(w: number, h: number, v: (y: number) => number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v(y);
      d[o + 3] = 255;
    }
  }
  return d;
}

const px = (d: Uint8ClampedArray, w: number, x: number, y: number): number => d[(y * w + x) * 4]!;

describe('deinterlaceData', () => {
  it('keeps the chosen field untouched and rebuilds the other from its neighbours', () => {
    // Even rows 100 ("field A"), odd rows 200 ("field B") — a maximal comb.
    const w = 4, h = 6;
    const d = rows(w, h, (y) => (y % 2 === 0 ? 100 : 200));
    deinterlaceData(d, w, h, 'upper');
    for (let y = 0; y < h; y++) {
      // Every row is now field A's value: kept rows verbatim, rebuilt rows the
      // average of two identical neighbours.
      const expected = y === h - 1 ? 100 : 100; // bottom edge copies the row above
      expect(px(d, w, 0, y)).toBe(expected);
    }
  });

  it('lower keeps the odd rows instead', () => {
    const w = 2, h = 6;
    const d = rows(w, h, (y) => (y % 2 === 0 ? 100 : 200));
    deinterlaceData(d, w, h, 'lower');
    for (let y = 0; y < h; y++) expect(px(d, w, 0, y)).toBe(200);
  });

  it('rebuilt rows are the AVERAGE of unequal neighbours, edges copy their single neighbour', () => {
    const w = 1, h = 5;
    // Kept (even) rows ramp 0, 100, 200; odd rows are garbage 7.
    const d = rows(w, h, (y) => (y % 2 === 0 ? y * 50 : 7));
    deinterlaceData(d, w, h, 'upper');
    expect(px(d, w, 0, 0)).toBe(0);
    expect(px(d, w, 0, 1)).toBe(50);   // avg(0, 100)
    expect(px(d, w, 0, 2)).toBe(100);
    expect(px(d, w, 0, 3)).toBe(150);  // avg(100, 200)
    expect(px(d, w, 0, 4)).toBe(200);
  });

  it('top edge copies downward when the upper field is discarded', () => {
    const w = 1, h = 4;
    const d = rows(w, h, (y) => (y % 2 === 0 ? 7 : (y + 1) * 10));
    deinterlaceData(d, w, h, 'lower');
    expect(px(d, w, 0, 0)).toBe(20); // row 0 had no row above — copies row 1
  });

  it('alpha is processed like colour — a combed matte is the same artifact', () => {
    const w = 1, h = 4;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) d[y * 4 + 3] = y % 2 === 0 ? 0 : 255;
    deinterlaceData(d, w, h, 'lower');
    for (let y = 0; y < h; y++) expect(d[y * 4 + 3]).toBe(255);
  });

  it('a degenerate height is left alone', () => {
    const d = rows(3, 1, () => 42);
    deinterlaceData(d, 3, 1, 'upper');
    expect(px(d, 3, 0, 0)).toBe(42);
  });
});

// ── Asset → snapshot threading ───────────────────────────────────────

const ASSET = 'fields-asset';

function node(id: string, parent: string | null, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'image', x: 400, y: 300, width: 200, height: 200, ...props } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
    ],
  } as unknown as SceneNode;
}

const comp = (id: string): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
} as unknown as SceneNode);

function setFields(fields?: 'upper' | 'lower'): void {
  useAssetStore.setState({
    assets: [{
      id: ASSET, type: 'video', src: 'fields://clip.mp4',
      metadata: { width: 720, height: 576 },
      interpret: fields ? { fields } : {},
    } as never],
  });
}

function fieldsOf(g: SceneGraph, rootId: string): Array<string | undefined> {
  const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    width: 800, height: 600, background: '#000', rootId,
  } as never);
  return s.layers.map((l) => l.fieldsSource);
}

afterEach(() => useAssetStore.setState({ assets: [] }));

describe('Interpret Footage ▸ Fields threading', () => {
  function graph(): SceneGraph {
    const g = new SceneGraph();
    g.addNode(comp('root'));
    g.addChild('root', node('v', 'root', { assetId: ASSET, src: 'fields://clip.mp4' }));
    return g;
  }

  it('an unmarked asset stays progressive — no flag on the layer at all', () => {
    const g = graph();
    setFields(undefined);
    expect(fieldsOf(g, 'root')).toEqual([undefined]);
  });

  it('marking the asset threads the field order onto its layers', () => {
    const g = graph();
    setFields('lower');
    expect(fieldsOf(g, 'root')).toEqual(['lower']);
  });

  it('interpretationOf validates: junk stored under fields reads as progressive', () => {
    useAssetStore.setState({
      assets: [{
        id: ASSET, type: 'video', src: 'fields://clip.mp4',
        metadata: {}, interpret: { fields: 'sideways' },
      } as never],
    });
    expect(interpretationOf(ASSET).fields).toBeUndefined();
  });
});
