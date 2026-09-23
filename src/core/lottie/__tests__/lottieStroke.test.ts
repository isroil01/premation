/**
 * Lottie `st` / `gs` import: cap, join, miter limit, dashes, gradient paint, and
 * ANIMATED width / colour / opacity / dash offset as keyframe tracks.
 *
 * The importer used to read width, colour and opacity as their first keyframe
 * and nothing else, so a stroke that grew imported frozen, every rounded line
 * came in butt-capped, dashes came in solid and a gradient stroke flattened.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { createLegacyDocumentContext } from '@core/ai/toolContext';
import { readNodeStroke } from '@core/paint/stroke';
import { planLottieImport, type LottieJson } from '../lottieImport';
import { applyImportPlan } from '../lottieImportApply';
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

const layerWith = (paint: Record<string, unknown>): Layer => ({
  ty: 4, ind: 1, nm: 'line', ip: 0, op: 60,
  ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [200, 200, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 } },
  shapes: [{ ty: 'gr', it: [
    { ty: 'rc', s: { a: 0, k: [100, 50] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
    paint,
    { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
  ] }],
} as unknown as Layer);

const STROKE = {
  ty: 'st',
  c: { a: 0, k: [1, 0, 0, 1] },
  o: { a: 0, k: 50 },
  w: { a: 1, k: [{ t: 0, s: [2], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } }, { t: 30, s: [20] }] },
  lc: 2, lj: 3, ml: 7,
  d: [
    { n: 'd', nm: 'dash', v: { a: 0, k: 10 } },
    { n: 'g', nm: 'gap', v: { a: 0, k: 5 } },
    { n: 'o', nm: 'offset', v: { a: 1, k: [{ t: 0, s: [0] }, { t: 60, s: [15] }] } },
  ],
};

describe('Lottie st → stroke + tracks', () => {
  beforeEach(reset);

  it('plans cap/join/miter/dashes and the animated width + dash offset as tracks', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWith(STROKE)] });
    const st = plan.layers[0]!.stroke!;
    expect(st).toMatchObject({ color: '#ff0000', opacity: 0.5, cap: 'round', join: 'bevel', miterLimit: 7, dash: [10, 5], dashOffset: 0 });
    // The stored base is the widest key, so the reader never drops the stroke.
    expect(st.width).toBe(20);
    const width = st.tracks!.find((t) => t.prop === 'strokeWidth')!;
    expect(width.keyframes.map((k) => [k.t, k.value])).toEqual([[0, 2], [1, 20]]);
    expect(width.keyframes[0]!.easing).toBe('bezier');
    expect(st.tracks!.find((t) => t.prop === 'strokeDashOffset')!.keyframes.map((k) => k.value)).toEqual([0, 15]);
  });

  it('applies the fields onto the node stroke and the tracks onto the animation', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWith(STROKE)] });
    applyImportPlan(plan, createLegacyDocumentContext(), { updateComp: false });
    const node = findByName('line');
    const s = readNodeStroke(node)!;
    expect(s).toMatchObject({ color: '#ff0000', opacity: 0.5, cap: 'round', join: 'bevel', miterLimit: 7, dash: [10, 5], dashOffset: 0 });
    expect(defaultAnimation.sample(node.id, 'strokeWidth', 0)).toBeCloseTo(2);
    expect(defaultAnimation.sample(node.id, 'strokeWidth', 1)).toBeCloseTo(20);
    expect(defaultAnimation.sample(node.id, 'strokeDashOffset', 2)).toBeCloseTo(15);
  });

  it('animated colour → stroke_r/g/b, animated opacity → a REAL strokeOpacity track', () => {
    const plan = planLottieImport({ fr: 10, op: 60, w: 400, h: 400, layers: [layerWith({
      ty: 'st',
      c: { a: 1, k: [{ t: 0, s: [1, 0, 0, 1] }, { t: 10, s: [0, 0, 1, 1] }] },
      o: { a: 1, k: [{ t: 0, s: [100] }, { t: 10, s: [25] }] },
      w: { a: 0, k: 4 },
    })] });
    const st = plan.layers[0]!.stroke!;
    // The static opacity is the first key — what the stroke falls back to.
    expect(st.opacity).toBe(1);
    const props = st.tracks!.map((t) => t.prop).sort();
    expect(props).toEqual(['strokeOpacity', 'stroke_b', 'stroke_g', 'stroke_r']);
    expect(st.tracks!.find((t) => t.prop === 'stroke_b')!.keyframes.map((k) => k.value)).toEqual([0, 1]);
    expect(st.tracks!.find((t) => t.prop === 'strokeOpacity')!.keyframes.map((k) => k.value)).toEqual([1, 0.25]);
  });

  it('a fade on a fixed colour is an opacity track ALONE — no held colour tracks', () => {
    const plan = planLottieImport({ fr: 10, op: 60, w: 400, h: 400, layers: [layerWith({
      ty: 'st', c: { a: 0, k: [0, 1, 0, 1] }, o: { a: 1, k: [{ t: 0, s: [0] }, { t: 10, s: [100] }] }, w: { a: 0, k: 4 },
    })] });
    const tracks = plan.layers[0]!.stroke!.tracks!;
    expect(tracks.map((t) => t.prop)).toEqual(['strokeOpacity']);
    expect(tracks[0]!.keyframes.map((k) => k.value)).toEqual([0, 1]);
  });

  it('animated ml2 and animated dash / gap values become their own tracks', () => {
    const plan = planLottieImport({ fr: 10, op: 60, w: 400, h: 400, layers: [layerWith({
      ty: 'st', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 4 },
      ml: 4, ml2: { a: 1, k: [{ t: 0, s: [0.5] }, { t: 10, s: [12] }] },
      d: [
        { n: 'd', v: { a: 1, k: [{ t: 0, s: [4] }, { t: 10, s: [20] }] } },
        { n: 'g', v: { a: 0, k: 6 } },
        { n: 'd', v: { a: 0, k: 2 } },
        { n: 'g', v: { a: 1, k: [{ t: 0, s: [1] }, { t: 10, s: [-3] }] } },
      ],
    })] });
    const st = plan.layers[0]!.stroke!;
    expect(plan.warnings.some((w) => /dash/i.test(w))).toBe(false);
    expect(st.dash).toEqual([4, 6, 2, 1]);
    const track = (p: string) => st.tracks!.find((t) => t.prop === p)?.keyframes.map((k) => k.value);
    expect(track('strokeMiterLimit')).toEqual([1, 12]);
    expect(track('strokeDash1')).toEqual([4, 20]);
    expect(track('strokeGap2')).toEqual([1, 0]);
    expect(track('strokeGap1')).toBeUndefined();
  });

  it('bm on a stroke becomes its blend mode', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWith({ ...STROKE, bm: 1 })] });
    expect(plan.layers[0]!.stroke!.blendMode).toBe('multiply');
    applyImportPlan(plan, createLegacyDocumentContext(), { updateComp: false });
    expect(readNodeStroke(findByName('line'))!.blendMode).toBe('multiply');
  });

  it('a plain static stroke plans exactly as before (no extra keys)', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWith({
      ty: 'st', c: { a: 0, k: [0, 0, 1, 1] }, w: { a: 0, k: 6 }, o: { a: 0, k: 50 },
    })] });
    expect(plan.layers[0]!.stroke).toEqual({ color: '#0000ff', width: 6, opacity: 0.5 });
  });
});

describe('Lottie gs → gradient stroke paint', () => {
  beforeEach(reset);

  it('imports a linear gradient stroke as stroke paint rather than flattening it', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWith({
      ty: 'gs', o: { a: 0, k: 80 }, w: { a: 0, k: 5 }, lc: 1, lj: 1, ml: 4, t: 1,
      s: { a: 0, k: [0, -25] }, e: { a: 0, k: [0, 25] },
      g: { p: 2, k: { a: 0, k: [0, 1, 0, 0, 1, 0, 0, 1] } },
    })] });
    expect(plan.warnings.some((w) => /gradient/i.test(w))).toBe(false);
    applyImportPlan(plan, createLegacyDocumentContext(), { updateComp: false });
    const s = readNodeStroke(findByName('line'))!;
    expect(s.opacity).toBeCloseTo(0.8);
    expect(s.cap).toBe('butt');
    expect(s.paint?.type).toBe('linear');
    if (s.paint?.type !== 'linear') throw new Error('not linear');
    expect(s.paint.angle).toBeCloseTo(90);
    expect(s.paint.stops.map((x) => x.color)).toEqual(['#ff0000', '#0000ff']);
    // The paint opacity is on the stroke, not baked into the ramp as well.
    expect(s.paint.opacityStops).toBeUndefined();
  });

  it('keeps AE’s free Start/End points and the radial highlight (h %, a °)', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWith({
      ty: 'gs', o: { a: 0, k: 100 }, w: { a: 0, k: 5 }, t: 2,
      // The rect is 100 × 50 about the origin: s is its top-left, e its right-middle.
      s: { a: 0, k: [-50, -25] }, e: { a: 0, k: [50, 0] },
      h: { a: 0, k: 40 }, a: { a: 0, k: 30 },
      g: { p: 2, k: { a: 0, k: [0, 1, 1, 1, 1, 0, 0, 0] } },
    })] });
    applyImportPlan(plan, createLegacyDocumentContext(), { updateComp: false });
    const s = readNodeStroke(findByName('line'))!;
    expect(s.paint?.type).toBe('radial');
    expect(s.gradient).toEqual({ startX: 0, startY: 0, endX: 1, endY: 0.5, highlightLength: 0.4, highlightAngle: 30 });
  });
});

describe('Lottie paint order → fill Composite', () => {
  beforeEach(reset);

  const layerWithItems = (items: unknown[]): Layer => ({
    ...layerWith({}),
    shapes: [{ ty: 'gr', it: [
      { ty: 'rc', s: { a: 0, k: [100, 50] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      ...items,
      { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ] }],
  } as unknown as Layer);
  const FILL = { ty: 'fl', c: { a: 0, k: [0, 0, 1, 1] }, o: { a: 0, k: 100 } };
  const ST = { ty: 'st', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 6 } };

  it('a fill listed BEFORE the stroke is drawn over it: Composite Above', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWithItems([FILL, ST])] });
    expect(plan.layers[0]!.fill?.composite).toBe('above');
  });

  it('the usual order (stroke first) leaves the fill at its default', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWithItems([ST, FILL])] });
    expect(plan.layers[0]!.fill).not.toHaveProperty('composite');
  });

  it('bm on a fill becomes its blend mode', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWithItems([ST, { ...FILL, bm: 3 }])] });
    expect(plan.layers[0]!.fill?.blendMode).toBe('overlay');
  });
});
