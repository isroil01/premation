/**
 * Lottie import planner — pins transform inversion (scale ÷100, split position,
 * bezier easing), animated-outline mapping, parenting, and drop warnings.
 * Pure: no scene/DOM — the apply layer is exercised separately.
 */

import { planLottieImport, type LottieJson } from '../lottieImport';
import type { DataPoint, LottieBezier } from '@motion/animation';

const bez = (x: number): LottieBezier => ({
  v: [[x, 0], [x + 10, 0], [x + 10, 10]] as [number, number][],
  i: [[0, 0], [0, 0], [0, 0]] as [number, number][],
  o: [[0, 0], [0, 0], [0, 0]] as [number, number][],
  c: true,
});

describe('planLottieImport — transforms', () => {
  it('static opacity, animated split position, scale ÷100', () => {
    const json: LottieJson = {
      fr: 30, w: 800, h: 600, op: 60,
      layers: [{
        ty: 4, ind: 1, nm: 'S',
        ks: {
          o: { a: 0, k: 80 },
          s: { a: 0, k: [50, 200, 100] },
          p: { a: 1, k: [
            { t: 0, s: [100, 200], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } },
            { t: 30, s: [300, 400] },
          ] },
        },
      }],
    };
    const plan = planLottieImport(json);
    expect(plan.comp).toEqual({ width: 800, height: 600, fps: 30, durationSeconds: 2 });
    const L = plan.layers[0]!;
    expect(L.staticProps.opacity).toBe(80);
    expect(L.staticProps.scaleX).toBeCloseTo(0.5);
    expect(L.staticProps.scaleY).toBeCloseTo(2);
    const xt = L.scalarTracks.find((t) => t.prop === 'x')!;
    const yt = L.scalarTracks.find((t) => t.prop === 'y')!;
    expect(xt.keyframes.map((k) => [k.t, k.value])).toEqual([[0, 100], [1, 300]]);
    expect(yt.keyframes.map((k) => [k.t, k.value])).toEqual([[0, 200], [1, 400]]);
    expect(xt.keyframes[0]!.easing).toBe('bezier');
    expect(xt.keyframes[0]!.bezier).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('split-position form (s:true, x/y sub-props)', () => {
    const json: LottieJson = {
      fr: 30,
      layers: [{
        ty: 4, ind: 1, nm: 'Split',
        ks: { p: { s: true, x: { a: 0, k: 42 }, y: { a: 0, k: 99 } } },
      }],
    };
    const L = planLottieImport(json).layers[0]!;
    expect(L.x).toBe(42);
    expect(L.y).toBe(99);
  });

  it('hold keyframe → easing hold', () => {
    const json: LottieJson = {
      fr: 10,
      layers: [{ ty: 4, ind: 1, ks: { r: { a: 1, k: [{ t: 0, s: [0], h: 1 }, { t: 10, s: [90] }] } } }],
    };
    const rt = planLottieImport(json).layers[0]!.scalarTracks.find((t) => t.prop === 'rotation')!;
    expect(rt.keyframes[0]!.easing).toBe('hold');
    expect(rt.keyframes.map((k) => k.t)).toEqual([0, 1]);
  });
});

describe('planLottieImport — shapes & outlines', () => {
  it('animated sh path → pointsTrack (absolute handles, closed) + fill', () => {
    const json: LottieJson = {
      fr: 30,
      layers: [{
        ty: 4, ind: 1, nm: 'Path',
        shapes: [{ ty: 'gr', it: [
          { ty: 'sh', ks: { a: 1, k: [{ t: 0, s: [bez(0)] }, { t: 15, s: [bez(50)] }] } },
          { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] } },
        ] }],
      }],
    };
    const L = planLottieImport(json).layers[0]!;
    expect(L.pointsTrack).toBeDefined();
    expect(L.pointsTrack!.closed).toBe(true);
    expect(L.pointsTrack!.keyframes.map((k) => k.t)).toEqual([0, 0.5]);
    expect((L.pointsTrack!.keyframes[1]!.value as DataPoint[])[0]!.x).toBe(50);
    expect(L.staticProps.fill).toBe('#ff0000');
  });

  it('rect item sets shapeType + size', () => {
    const json: LottieJson = {
      fr: 30,
      layers: [{ ty: 4, ind: 1, shapes: [{ ty: 'rc', s: { a: 0, k: [120, 80] }, r: { a: 0, k: 8 } }] }],
    };
    const L = planLottieImport(json).layers[0]!;
    expect(L.staticProps).toMatchObject({ shapeType: 'rect', width: 120, height: 80, cornerRadius: 8 });
  });
});

describe('planLottieImport — structure & warnings', () => {
  it('preserves parent links', () => {
    const json: LottieJson = {
      fr: 30,
      layers: [
        { ty: 3, ind: 1, nm: 'Hip' },
        { ty: 4, ind: 2, nm: 'Arm', parent: 1 },
      ],
    };
    const plan = planLottieImport(json);
    expect(plan.layers.find((l) => l.ind === 2)!.parentInd).toBe(1);
    expect(plan.layers.find((l) => l.ind === 1)!.kind).toBe('null');
  });

  it('skips an unresolved precomp (no asset) with a warning; warns on text glyphs', () => {
    const json: LottieJson = {
      fr: 30,
      layers: [
        { ty: 0, ind: 1, nm: 'Pre' }, // no refId → cannot resolve
        { ty: 5, ind: 2, nm: 'Title' },
      ],
    };
    const plan = planLottieImport(json);
    expect(plan.layers.map((l) => l.ind)).toEqual([2]); // unresolved precomp dropped
    expect(plan.warnings.some((w) => w.includes('precomp'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('text'))).toBe(true);
  });

  it('expands a precomp (ty:0 + refId) into a group whose children bake in the anchor', () => {
    const json: LottieJson = {
      fr: 30, w: 512, h: 512, op: 60,
      assets: [
        {
          id: 'pc1',
          layers: [
            // One shape child of the precomp, positioned in precomp space.
            { ty: 4, ind: 1, nm: 'Inner', ks: { p: { a: 0, k: [300, 200] } } },
          ],
        },
      ],
      layers: [
        {
          ty: 0, ind: 1, nm: 'Pre', refId: 'pc1',
          ks: { p: { a: 0, k: [100, 50] }, a: { a: 0, k: [256, 128] } },
        },
      ],
    };
    const plan = planLottieImport(json);

    const group = plan.layers.find((l) => l.kind === 'group');
    expect(group).toBeDefined();
    expect(group!.parentUid).toBeUndefined(); // top-level
    expect(group!.x).toBe(100); // precomp layer position
    expect(group!.y).toBe(50);
    // The group must NOT carry an anchor — it bakes into the children instead.
    expect(group!.staticProps.anchorX).toBeUndefined();

    const inner = plan.layers.find((l) => l.name === 'Inner');
    expect(inner).toBeDefined();
    expect(inner!.parentUid).toBe(group!.uid); // parented under the group
    // child local = precomp-space pos − precomp anchor: 300−256, 200−128
    expect(inner!.x).toBe(44);
    expect(inner!.y).toBe(72);
  });

  it('skips a self-referential precomp instead of looping forever', () => {
    const json: LottieJson = {
      fr: 30,
      assets: [{ id: 'loop', layers: [{ ty: 0, ind: 1, nm: 'Self', refId: 'loop' }] }],
      layers: [{ ty: 0, ind: 1, nm: 'Root', refId: 'loop' }],
    };
    const plan = planLottieImport(json);
    // Outer expands once (a group), inner self-reference is refused.
    expect(plan.layers.filter((l) => l.kind === 'group').length).toBe(1);
    expect(plan.warnings.some((w) => w.includes('references itself') || w.includes('nests too deeply'))).toBe(true);
  });
});
