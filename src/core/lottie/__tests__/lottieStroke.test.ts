/**
 * Lottie `st` / `gs` import: cap, join, miter limit, dashes, gradient paint, and
 * ANIMATED width / colour / opacity / dash offset as keyframe tracks.
 *
 * The importer used to read width, colour and opacity as their first keyframe
 * and nothing else, so a stroke that grew imported frozen, every rounded line
 * came in butt-capped, dashes came in solid and a gradient stroke flattened.
 */



import { planLottieImport, type LottieJson } from '../lottieImport';

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

  it('a plain static stroke plans exactly as before (no extra keys)', () => {
    const plan = planLottieImport({ fr: 30, op: 60, w: 400, h: 400, layers: [layerWith({
      ty: 'st', c: { a: 0, k: [0, 0, 1, 1] }, w: { a: 0, k: 6 }, o: { a: 0, k: 50 },
    })] });
    expect(plan.layers[0]!.stroke).toEqual({ color: '#0000ff', width: 6, opacity: 0.5 });
  });
});

describe('Lottie paint order → fill Composite', () => {

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
