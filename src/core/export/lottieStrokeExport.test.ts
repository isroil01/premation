/**
 * Lottie export of the strokes Fill & Stroke edits.
 *
 * The exporter read the legacy `Style.stroke/strokeWidth` pair, which nothing
 * renders — so strokes set in the inspector exported as no stroke — and when it
 * did export one it hard-coded round caps/joins, 100% opacity and no dashes.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { createLegacyDocumentContext } from '@core/ai/toolContext';
import { readNodeStroke, setNodeStroke, setNodeStrokes, defaultStroke } from '@core/paint/stroke';
import { getNodeFill, setNodeFill } from '@core/paint/fill';
import { planLottieImport, type LottieJson } from '@core/lottie/lottieImport';
import { applyImportPlan } from '@core/lottie/lottieImportApply';
import { lottieShapesFor } from './exportManager';
import type { SceneNode } from '@core/types';

function reset(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
}

function findByName(name: string): SceneNode {
  let hit: SceneNode | null = null;
  defaultSceneGraph.traverse((n) => { if (!hit && n.name === name) hit = n; });
  if (!hit) throw new Error(`node "${name}" not found`);
  return hit;
}

type Layer = NonNullable<LottieJson['layers']>[number];

/** Import a rect layer with the given paint items, returning the created node. */
function importRect(name: string, paints: unknown[]): SceneNode {
  const layer = {
    ty: 4, ind: 1, nm: name, ip: 0, op: 60,
    ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [200, 200, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 } },
    shapes: [{ ty: 'gr', it: [
      { ty: 'rc', s: { a: 0, k: [100, 50] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      ...paints,
      { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ] }],
  } as unknown as Layer;
  applyImportPlan(planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layer] }), createLegacyDocumentContext(), { updateComp: false });
  return findByName(name);
}

type Item = Record<string, unknown> & { ty: string };
const groupItems = (node: SceneNode, fr = 30): Item[] =>
  ((lottieShapesFor(defaultSceneGraph.getNode(node.id)!, fr)[0] as { it: Item[] }).it);

describe('Lottie export — fx strokes', () => {
  beforeEach(reset);

  it('exports an inspector stroke with dashes, round cap and 50% opacity as st', () => {
    const node = importRect('box', [{ ty: 'fl', c: { a: 0, k: [0, 1, 0, 1] }, o: { a: 0, k: 100 } }]);
    setNodeStroke(node.id, {
      ...defaultStroke('#ff0000'), width: 6, opacity: 0.5, cap: 'round', join: 'bevel', miterLimit: 9, dash: [8, 4], dashOffset: 3,
    });
    const items = groupItems(node);
    const st = items.find((i) => i.ty === 'st')!;
    expect(st).toMatchObject({
      c: { a: 0, k: [1, 0, 0, 1] },
      o: { a: 0, k: 50 },
      w: { a: 0, k: 6 },
      lc: 2,
      lj: 3,
      ml: 9,
      d: [
        { n: 'd', nm: 'dash', v: { a: 0, k: 8 } },
        { n: 'g', nm: 'gap', v: { a: 0, k: 4 } },
        { n: 'o', nm: 'offset', v: { a: 0, k: 3 } },
      ],
    });
    // Stroke listed before the fill: Lottie draws the first paint item on top.
    expect(items.findIndex((i) => i.ty === 'st')).toBeLessThan(items.findIndex((i) => i.ty === 'fl'));
  });

  it('exports keyframed width and dash offset as animated props', () => {
    const node = importRect('anim', []);
    setNodeStroke(node.id, { ...defaultStroke('#ffffff'), width: 4, dash: [5, 5] });
    defaultAnimation.setKeyframes(node.id, 'strokeWidth', [
      { t: 0, value: 2, easing: 'linear' }, { t: 1, value: 12, easing: 'linear' },
    ]);
    defaultAnimation.setKeyframes(node.id, 'strokeDashOffset', [
      { t: 0, value: 0, easing: 'linear' }, { t: 2, value: 10, easing: 'linear' },
    ]);
    const st = groupItems(node).find((i) => i.ty === 'st')!;
    const w = st.w as { a: number; k: Array<{ t: number; s: number[] }> };
    expect(w.a).toBe(1);
    expect(w.k.map((k) => [k.t, k.s[0]])).toEqual([[0, 2], [30, 12]]);
    const off = (st.d as Array<{ n: string; v: { a: number; k: Array<{ t: number; s: number[] }> } }>).find((x) => x.n === 'o')!;
    expect(off.v.a).toBe(1);
    expect(off.v.k.map((k) => [k.t, k.s[0]])).toEqual([[0, 0], [60, 10]]);
  });

  it('exports every stroke of a stack, top first, and a gradient stroke as gs', () => {
    const node = importRect('stack', []);
    setNodeStrokes(node.id, [
      { ...defaultStroke('#000000'), width: 10 },
      { ...defaultStroke('#ffffff'), width: 2, paint: { type: 'linear', angle: 0, stops: [{ id: 'a', offset: 0, color: '#ff0000' }, { id: 'b', offset: 1, color: '#0000ff' }] } },
    ]);
    const strokes = groupItems(node).filter((i) => i.ty === 'st' || i.ty === 'gs');
    expect(strokes.map((s) => s.ty)).toEqual(['gs', 'st']);
    expect(strokes[1]!.w).toEqual({ a: 0, k: 10 });
    expect((strokes[0]!.g as { p: number }).p).toBe(2);
  });

  it('a node with no fx stroke exports no stroke item', () => {
    const node = importRect('bare', [{ ty: 'fl', c: { a: 0, k: [0, 1, 0, 1] }, o: { a: 0, k: 100 } }]);
    expect(groupItems(node).some((i) => i.ty === 'st' || i.ty === 'gs')).toBe(false);
  });
});

describe('Lottie export — AE stroke options', () => {
  beforeEach(reset);
  type Anim = { a: number; k: Array<{ t: number; s: number[] }> };
  const keys = (p: unknown): number[][] => (p as Anim).k.map((k) => [k.t, k.s[0]!]);

  it('a strokeOpacity track exports as animated opacity', () => {
    const node = importRect('op', []);
    setNodeStroke(node.id, { ...defaultStroke('#ffffff'), width: 4 });
    defaultAnimation.setKeyframes(node.id, 'strokeOpacity', [
      { t: 0, value: 1, easing: 'linear' }, { t: 1, value: 0.25, easing: 'linear' },
    ]);
    const st = groupItems(node).find((i) => i.ty === 'st')!;
    expect((st.o as Anim).a).toBe(1);
    expect(keys(st.o)).toEqual([[0, 100], [30, 25]]);
  });

  it('stroke 2 exports ITS OWN width track; stroke 1 stays static', () => {
    const node = importRect('two', []);
    setNodeStrokes(node.id, [{ ...defaultStroke('#000000'), width: 10 }, { ...defaultStroke('#ffffff'), width: 2 }]);
    defaultAnimation.setKeyframes(node.id, 'stroke.1.width', [
      { t: 0, value: 2, easing: 'linear' }, { t: 1, value: 8, easing: 'linear' },
    ]);
    const strokes = groupItems(node).filter((i) => i.ty === 'st');
    // Top first: stroke 2, then stroke 1.
    expect(keys(strokes[0]!.w)).toEqual([[0, 2], [30, 8]]);
    expect(strokes[1]!.w).toEqual({ a: 0, k: 10 });
  });

  it('miter limit (ml2) and a dash slot animate; the blend mode exports as bm', () => {
    const node = importRect('opts', []);
    setNodeStroke(node.id, { ...defaultStroke('#ffffff'), width: 4, dash: [6, 3], blendMode: 'screen' });
    defaultAnimation.setKeyframes(node.id, 'strokeMiterLimit', [
      { t: 0, value: 2, easing: 'linear' }, { t: 1, value: 9, easing: 'linear' },
    ]);
    defaultAnimation.setKeyframes(node.id, 'strokeGap1', [
      { t: 0, value: 3, easing: 'linear' }, { t: 1, value: 12, easing: 'linear' },
    ]);
    const st = groupItems(node).find((i) => i.ty === 'st')!;
    expect(keys(st.ml2)).toEqual([[0, 2], [30, 9]]);
    const d = st.d as Array<{ n: string; v: unknown }>;
    expect(d[0]!.v).toEqual({ a: 0, k: 6 });
    expect(keys(d[1]!.v)).toEqual([[0, 3], [30, 12]]);
    expect(st.bm).toBe(2);
  });

  it('a fill set Composite Above is written AHEAD of the stroke it covers', () => {
    const node = importRect('above', [{ ty: 'fl', c: { a: 0, k: [0, 1, 0, 1] }, o: { a: 0, k: 100 } }]);
    setNodeStroke(node.id, { ...defaultStroke('#ff0000'), width: 6 });
    setNodeFill(node.id, { ...getNodeFill(node.id)!, composite: 'above' } as never);
    const items = groupItems(node);
    expect(items.findIndex((i) => i.ty === 'fl')).toBeLessThan(items.findIndex((i) => i.ty === 'st'));
  });

  it('gradient Start/End points export as s/e in the drawable box, highlight as h/a', () => {
    const node = importRect('grad', []);
    setNodeStroke(node.id, {
      ...defaultStroke('#ffffff'), width: 4,
      paint: { type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: [{ id: 'a', offset: 0, color: '#ff0000' }, { id: 'b', offset: 1, color: '#0000ff' }] },
      gradient: { startX: 0, startY: 0, endX: 1, endY: 1, highlightLength: 0.5, highlightAngle: 30 },
    });
    const gs = groupItems(node).find((i) => i.ty === 'gs')!;
    // The rect is 100 × 50 about the origin.
    expect(gs.s).toEqual({ a: 0, k: [-50, -25] });
    expect(gs.e).toEqual({ a: 0, k: [50, 25] });
    expect(gs.h).toEqual({ a: 0, k: 50 });
    expect(gs.a).toEqual({ a: 0, k: 30 });
  });
});

describe('Lottie stroke import → export → import is stable', () => {
  beforeEach(reset);

  it('keeps colour, opacity, width track, cap, join, miter limit and dashes', () => {
    const source = {
      ty: 'st',
      c: { a: 0, k: [0, 0.5, 1, 1] },
      o: { a: 0, k: 50 },
      w: { a: 1, k: [{ t: 0, s: [3], o: { x: [0.4], y: [0] }, i: { x: [0.6], y: [1] } }, { t: 30, s: [9] }] },
      lc: 2, lj: 2, ml: 6,
      d: [{ n: 'd', v: { a: 0, k: 12 } }, { n: 'g', v: { a: 0, k: 6 } }, { n: 'o', v: { a: 0, k: 4 } }],
    };
    const first = importRect('first', [source]);
    const exported = groupItems(first).find((i) => i.ty === 'st')!;
    const second = importRect('second', [exported]);

    const a = readNodeStroke(first)!;
    const b = readNodeStroke(second)!;
    for (const key of ['cap', 'join', 'miterLimit', 'dash', 'dashOffset', 'width'] as const) {
      expect(b[key]).toEqual(a[key]);
    }
    expect(b.opacity).toBeCloseTo(a.opacity);
    expect(b.color).toBe(a.color);
    expect(a).toMatchObject({ cap: 'round', join: 'round', miterLimit: 6, dash: [12, 6], dashOffset: 4, opacity: 0.5 });
    for (const t of [0, 0.5, 1]) {
      expect(defaultAnimation.sample(second.id, 'strokeWidth', t)).toBeCloseTo(defaultAnimation.sample(first.id, 'strokeWidth', t)!);
    }
  });
});
