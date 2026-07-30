/**
 * Shape-tree expansion, paints and visibility windows.
 *
 * Regression guards for what a real LottieFiles/AE export lost. Measured on the
 * user's "Book a call" file before the fix: 65 `sh` paths in, 18 out — the
 * lettering of a word arrived as one stray glyph, ten group `tr` transforms were
 * ignored so what survived was misplaced, gradient layers landed on the scene
 * facade's PLACEHOLDER blue, and three layers with real `ip`/`op` windows drew
 * from frame 0 instead of two seconds in.
 */

import { planLottieImport, type LottieJson } from '../lottieImport';
import type { LottieBezier } from '@motion/animation';

const bez = (x: number): LottieBezier => ({
  v: [[x, 0], [x + 10, 0], [x + 10, 10]] as [number, number][],
  i: [[0, 0], [0, 0], [0, 0]] as [number, number][],
  o: [[0, 0], [0, 0], [0, 0]] as [number, number][],
  c: true,
});
const path = (x: number) => ({ ty: 'sh', ks: { a: 0 as const, k: bez(x) } });
const fill = (r: number, g: number, b: number) => ({ ty: 'fl', c: { a: 0 as const, k: [r, g, b, 1] } });

/**
 * Where a drawable's ink actually sits, in its parent's space.
 *
 * Outlines are re-centred on their own bounding box and the offset is paid back
 * in the node's position (see `recentreOutlines` — a path node's texture box is
 * symmetric about its origin, so an off-centre outline needed a box big enough
 * to reach it). Local point coordinates and `x`/`y` are therefore both
 * bookkeeping; their SUM is the thing that has to stay put, so that is what
 * these tests assert.
 */
/** Linear sample of a planned scalar track (hold segments keep their value). */
function sampleAt(kfs: ReadonlyArray<{ t: number; value: number; easing: string }>, t: number): number {
  if (t <= kfs[0]!.t) return kfs[0]!.value;
  const last = kfs[kfs.length - 1]!;
  if (t >= last.t) return last.value;
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1]!;
    const b = kfs[i]!;
    if (t <= b.t) {
      if (a.easing === 'hold' || b.t === a.t) return a.value;
      return a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t);
    }
  }
  return last.value;
}

function inkCentre(layer: { x: number; y: number; pointsTrack?: { keyframes: Array<{ value: unknown }> } }): [number, number] {
  const pts = (layer.pointsTrack?.keyframes[0]?.value ?? []) as Array<{ x: number; y: number }>;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return [
    layer.x + (Math.min(...xs) + Math.max(...xs)) / 2,
    layer.y + (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
}

describe('shape trees expand — every drawable becomes a node', () => {
  it('a layer with many paths yields one node per path, not just the first', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{
        ty: 4, ind: 1, nm: 'Letters',
        shapes: [{ ty: 'gr', it: [path(0), path(20), path(40), fill(1, 0, 0)] }],
      }],
    };
    const plan = planLottieImport(json);
    const drawables = plan.layers.filter((l) => l.pointsTrack);
    expect(drawables).toHaveLength(3);
    // Each carries the group's fill, and they are distinct outlines.
    expect(drawables.every((d) => d.staticProps.fill === '#ff0000')).toBe(true);
    // Three distinct outlines, 20 apart — `bez(x)` spans x..x+10, so their ink
    // centres are 5, 25, 45.
    expect(drawables.map((d) => inkCentre(d)[0])).toEqual([5, 25, 45]);
  });

  it('the multi-drawable host becomes a container that draws nothing', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{ ty: 4, ind: 1, nm: 'Letters', shapes: [{ ty: 'gr', it: [path(0), path(20)] }] }],
    };
    const plan = planLottieImport(json);
    const host = plan.layers.find((l) => l.name === 'Letters')!;
    // A 'shape' host with no geometry would fall back to the facade's
    // placeholder rectangle — hence 'group'.
    expect(host.kind).toBe('group');
    expect(host.pointsTrack).toBeUndefined();
    expect(plan.layers.filter((l) => l.parentUid === host.uid)).toHaveLength(2);
  });

  it('a single drawable under identity transforms still collapses onto the host', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{ ty: 4, ind: 1, nm: 'One', shapes: [{ ty: 'gr', it: [path(0), fill(0, 1, 0)] }] }],
    };
    const plan = planLottieImport(json);
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]!.kind).toBe('shape');
    expect(plan.layers[0]!.pointsTrack).toBeDefined();
    expect(plan.layers[0]!.staticProps.fill).toBe('#00ff00');
  });
});

describe('group transforms', () => {
  const grouped = (tr: Record<string, unknown>): LottieJson => ({
    fr: 30, op: 30,
    layers: [{
      ty: 4, ind: 1, nm: 'Host',
      ks: { p: { a: 0, k: [100, 100] } },
      shapes: [{ ty: 'gr', nm: 'Inner', it: [path(0), fill(1, 1, 1), { ty: 'tr', ...tr }] }],
    }],
  });

  it('a non-identity group tr becomes a container carrying that transform', () => {
    const plan = planLottieImport(grouped({
      p: { a: 0, k: [30, 40] }, a: { a: 0, k: [0, 0] },
      s: { a: 0, k: [200, 200] }, r: { a: 0, k: 45 }, o: { a: 0, k: 50 },
    }));
    const wrap = plan.layers.find((l) => l.name === 'Inner')!;
    expect(wrap.kind).toBe('group');
    expect([wrap.x, wrap.y]).toEqual([30, 40]);
    expect(wrap.staticProps).toMatchObject({ scaleX: 2, scaleY: 2, rotation: 45 });
    // The drawable hangs off the container, not off the host.
    const drawable = plan.layers.find((l) => l.pointsTrack)!;
    expect(drawable.parentUid).toBe(wrap.uid);
    // The group's OPACITY moves down onto it: parenting propagates transform,
    // not opacity, so 50% left on the container would fade nothing at all.
    expect(wrap.staticProps.opacity).toBeUndefined();
    expect(drawable.staticProps.opacity).toBe(50);
  });

  it('a group anchor is baked into its children (the engine composes with anchor 0)', () => {
    const plan = planLottieImport(grouped({
      p: { a: 0, k: [0, 0] }, a: { a: 0, k: [10, 20] },
      s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
    }));
    const child = plan.layers.find((l) => l.pointsTrack)!;
    // `bez(0)` is centred at (5,5); the group anchor moves it by (−10,−20).
    expect(inkCentre(child)).toEqual([-5, -15]);
  });

  it('an identity tr adds no wrapper', () => {
    const plan = planLottieImport(grouped({
      p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] },
      s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
    }));
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]!.kind).toBe('shape');
  });
});

describe('paints', () => {
  it('a linear gradient maps to a real gradient fill, not a placeholder colour', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{
        ty: 4, ind: 1, nm: 'Grad',
        shapes: [{ ty: 'gr', it: [path(0), {
          ty: 'gf', t: 1,
          s: { a: 0, k: [0, 0] },
          e: { a: 0, k: [0, 100] }, // straight down → 90°
          o: { a: 0, k: 100 },
          g: { p: 2, k: { a: 0, k: [0, 1, 0, 0, 1, 0, 0, 1] } },
        }] }],
      }],
    };
    const f = planLottieImport(json).layers[0]!.fill!;
    expect(f.type).toBe('linear');
    expect(f.angle).toBeCloseTo(90, 4);
    expect(f.stops).toEqual([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }]);
    // The flat fallback is the gradient's own first stop — never an invented colour.
    expect(f.color).toBe('#ff0000');
  });

  it('a gradient opacity ramp is read as its own list', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{
        ty: 4, ind: 1, shapes: [{ ty: 'gr', it: [path(0), {
          ty: 'gf', t: 1, s: { a: 0, k: [0, 0] }, e: { a: 0, k: [100, 0] }, o: { a: 0, k: 100 },
          g: { p: 2, k: { a: 0, k: [0, 1, 1, 1, 1, 0, 0, 0, /* opacity */ 0, 1, 1, 0] } },
        }] }],
      }],
    };
    expect(planLottieImport(json).layers[0]!.fill!.opacityStops).toEqual([
      { offset: 0, opacity: 1 },
      { offset: 1, opacity: 0 },
    ]);
  });

  it('a radial gradient normalises centre + radius against the drawable box', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{
        ty: 4, ind: 1, shapes: [{ ty: 'gr', it: [
          { ty: 'el', s: { a: 0, k: [100, 100] }, p: { a: 0, k: [0, 0] } },
          { ty: 'gf', t: 2, s: { a: 0, k: [0, 0] }, e: { a: 0, k: [50, 0] }, o: { a: 0, k: 100 },
            g: { p: 2, k: { a: 0, k: [0, 1, 1, 1, 1, 0, 0, 0] } } },
        ] }],
      }],
    };
    const f = planLottieImport(json).layers[0]!.fill!;
    expect(f.type).toBe('radial');
    // Box is [-50..50]², so the centre (0,0) is the middle of it.
    expect(f.cx).toBeCloseTo(0.5, 4);
    expect(f.cy).toBeCloseTo(0.5, 4);
    // radius 50 over a half-diagonal of hypot(100,100)/2 ≈ 70.71.
    expect(f.radius).toBeCloseTo(50 / (Math.hypot(100, 100) / 2), 4);
  });

  it('a stroke is imported (it used to be dropped with no warning at all)', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{
        ty: 4, ind: 1, shapes: [{ ty: 'gr', it: [path(0), {
          ty: 'st', c: { a: 0, k: [0, 0, 1, 1] }, w: { a: 0, k: 6 }, o: { a: 0, k: 50 },
        }] }],
      }],
    };
    expect(planLottieImport(json).layers[0]!.stroke).toEqual({ color: '#0000ff', width: 6, opacity: 0.5 });
  });

  it('nested groups inherit the enclosing paint', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{
        ty: 4, ind: 1, shapes: [{ ty: 'gr', it: [
          { ty: 'gr', it: [path(0)] },
          fill(1, 1, 0),
        ] }],
      }],
    };
    expect(planLottieImport(json).layers[0]!.staticProps.fill).toBe('#ffff00');
  });
});

describe('visibility windows (ip / op)', () => {
  it('a layer that starts late gets a timing window in comp seconds', () => {
    const json: LottieJson = {
      fr: 60, op: 300,
      layers: [{ ty: 4, ind: 1, nm: 'Late', ip: 120, op: 240, shapes: [{ ty: 'gr', it: [path(0)] }] }],
    };
    expect(planLottieImport(json).layers[0]!.timing).toEqual({ inSec: 2, outSec: 4 });
  });

  it('a full-length layer carries no window (nothing to trim)', () => {
    const json: LottieJson = {
      fr: 30, op: 90,
      layers: [{ ty: 4, ind: 1, ip: 0, op: 90, shapes: [{ ty: 'gr', it: [path(0)] }] }],
    };
    expect(planLottieImport(json).layers[0]!.timing).toBeUndefined();
  });

  it('a precomp child is offset by the precomp start time and clipped to its window', () => {
    const json: LottieJson = {
      fr: 30, op: 300,
      assets: [{ id: 'pc', layers: [{ ty: 4, ind: 1, nm: 'Inner', ip: 0, op: 300, shapes: [{ ty: 'gr', it: [path(0)] }] }] }],
      layers: [{ ty: 0, ind: 1, nm: 'Pre', refId: 'pc', ip: 60, op: 150, st: 30, ks: {} }],
    };
    const plan = planLottieImport(json);
    // The precomp is a ROOT layer → a clip bar, frames 60→150.
    expect(plan.layers.find((l) => l.name === 'Pre')!.timing).toEqual({ inSec: 2, outSec: 5 });
    // The child runs 30→330 in parent frames but cannot outlive its precomp.
    // Nested → no clip bar is possible, so it gates via opacity over the same
    // window (2s→5s).
    const inner = plan.layers.find((l) => l.name === 'Inner')!;
    expect(inner.timing).toBeUndefined();
    const gate = inner.scalarTracks.find((t) => t.prop === 'opacity')!;
    expect(gate.keyframes[0]).toEqual({ t: 0, value: 0, easing: 'hold' });
    expect(gate.keyframes[1]!.t).toBeCloseTo(2, 6);
    expect(gate.keyframes[1]!.value).toBe(100);
    expect(gate.keyframes[gate.keyframes.length - 1]).toEqual({ t: 5, value: 0, easing: 'hold' });
  });

  it('the opacity gate is a hard cut, not a fade (a hold frame precedes the out)', () => {
    const json: LottieJson = {
      fr: 30, op: 300,
      assets: [{ id: 'pc', layers: [{ ty: 4, ind: 1, nm: 'Inner', shapes: [{ ty: 'gr', it: [path(0)] }] }] }],
      layers: [{ ty: 0, ind: 1, nm: 'Pre', refId: 'pc', ks: {} }],
    };
    // Give the inner layer a window that ends before the comp does.
    (json.assets![0]!.layers![0] as { ip: number; op: number }).ip = 30;
    (json.assets![0]!.layers![0] as { ip: number; op: number }).op = 90;
    const gate = planLottieImport(json).layers.find((l) => l.name === 'Inner')!
      .scalarTracks.find((t) => t.prop === 'opacity')!;
    expect(gate.keyframes.map((k) => [+k.t.toFixed(4), k.value, k.easing])).toEqual([
      [0, 0, 'hold'],
      [1, 100, 'hold'],
      [2.9667, 100, 'hold'],
      [3, 0, 'hold'],
    ]);
  });

  it('a nested layer never visible in this comp is simply hidden', () => {
    const json: LottieJson = {
      fr: 30, op: 60,
      assets: [{ id: 'pc', layers: [{ ty: 4, ind: 1, nm: 'Inner', ip: 200, op: 260, shapes: [{ ty: 'gr', it: [path(0)] }] }] }],
      layers: [{ ty: 0, ind: 1, nm: 'Pre', refId: 'pc', ks: {} }],
    };
    const inner = planLottieImport(json).layers.find((l) => l.name === 'Inner')!;
    expect(inner.staticProps.opacity).toBe(0);
  });

  it('a window entirely outside the comp collapses to zero length on a root layer', () => {
    const json: LottieJson = {
      fr: 30, op: 60,
      layers: [{ ty: 4, ind: 1, ip: 200, op: 260, shapes: [{ ty: 'gr', it: [path(0)] }] }],
    };
    expect(planLottieImport(json).layers[0]!.timing).toEqual({ inSec: 0, outSec: 0 });
  });
});

/**
 * Containers carry transform only — parenting propagates transform, not opacity
 * (AE's rule, and the engine's). Anything opacity-shaped that lands on one is
 * therefore inert, and BOTH mechanisms Lottie uses to hide things are opacity-
 * shaped. In "Book a call" that meant the phone drew on top of the dotted arrow
 * it replaces, the label stayed lit under the pill that wipes it, and the
 * "Call booked" bubble was on screen from frame 0.
 */
describe('a container cannot hold opacity — it has to reach the drawables', () => {
  it('a shape layer that expanded gates its DRAWABLES, not the container', () => {
    const json: LottieJson = {
      fr: 30, op: 90,
      layers: [{
        ty: 4, ind: 1, nm: 'Letters', ip: 30, op: 60,
        shapes: [{ ty: 'gr', it: [path(0), path(20)] }],
      }],
    };
    const plan = planLottieImport(json);
    const host = plan.layers.find((l) => l.name === 'Letters')!;
    expect(host.kind).toBe('group');
    expect(host.scalarTracks.find((t) => t.prop === 'opacity')).toBeUndefined();

    const drawables = plan.layers.filter((l) => l.pointsTrack);
    expect(drawables).toHaveLength(2);
    for (const d of drawables) {
      const gate = d.scalarTracks.find((t) => t.prop === 'opacity')!;
      expect(gate.keyframes[0]).toEqual({ t: 0, value: 0, easing: 'hold' });
      // Lit for its window (1s–2s), dark again after.
      expect(sampleAt(gate.keyframes, 1.5)).toBe(100);
      expect(sampleAt(gate.keyframes, 0.5)).toBe(0);
      expect(sampleAt(gate.keyframes, 2.5)).toBe(0);
    }
  });

  it('a precomp layer’s opacity animation multiplies into its contents', () => {
    const json: LottieJson = {
      fr: 30, op: 60,
      assets: [{ id: 'pc', layers: [{ ty: 4, ind: 1, nm: 'Inner', shapes: [{ ty: 'gr', it: [path(0)] }] }] }],
      layers: [{
        ty: 0, ind: 1, nm: 'Pre', refId: 'pc',
        // Fades out over the first second, stays out.
        ks: { o: { a: 1, k: [{ t: 0, s: [100] }, { t: 30, s: [0] }] } },
      }],
    };
    const plan = planLottieImport(json);
    const pre = plan.layers.find((l) => l.name === 'Pre')!;
    const inner = plan.layers.find((l) => l.name === 'Inner')!;
    // The precomp keeps its transform and loses the opacity it could not apply.
    expect(pre.kind).toBe('group');
    expect(pre.scalarTracks.find((t) => t.prop === 'opacity')).toBeUndefined();
    expect(pre.staticProps.opacity).toBeUndefined();
    // …which now lives on the thing that draws.
    const fade = inner.scalarTracks.find((t) => t.prop === 'opacity')!;
    expect(sampleAt(fade.keyframes, 0)).toBe(100);
    expect(sampleAt(fade.keyframes, 0.5)).toBeCloseTo(50, 5);
    expect(sampleAt(fade.keyframes, 1)).toBe(0);
  });

  it('a container fade MULTIPLIES with a fade the drawable already had', () => {
    const json: LottieJson = {
      fr: 30, op: 60,
      assets: [{
        id: 'pc',
        layers: [{
          ty: 4, ind: 1, nm: 'Inner',
          ks: { o: { a: 1, k: [{ t: 0, s: [100] }, { t: 30, s: [50] }] } },
          shapes: [{ ty: 'gr', it: [path(0)] }],
        }],
      }],
      layers: [{
        ty: 0, ind: 1, nm: 'Pre', refId: 'pc',
        ks: { o: { a: 1, k: [{ t: 0, s: [100] }, { t: 30, s: [0] }] } },
      }],
    };
    const plan = planLottieImport(json);
    const fade = plan.layers.find((l) => l.name === 'Inner')!.scalarTracks.find((t) => t.prop === 'opacity')!;
    // At 0.5s: the layer is at 75%, the precomp at 50% → 37.5%, not either one.
    expect(sampleAt(fade.keyframes, 0.5)).toBeCloseTo(37.5, 4);
    expect(sampleAt(fade.keyframes, 1)).toBe(0);
  });
});

/**
 * A path node's texture box is symmetric about its local origin, so an outline
 * drawn far from that origin needed a box big enough to reach it — a 30px glyph
 * 380px along its layer got a 766×142 box. The art was in the right place, but
 * the selection rectangle was the size of the whole word.
 */
describe('outlines are re-centred so their box is their own size', () => {
  it('a far-flung outline keeps its position but gets a tight box', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [{
        ty: 4, ind: 1, nm: 'Far', ks: { p: { a: 0, k: [100, 100] } },
        // Two drawables so the host stays a container and the drawable is its
        // own node; `bez(380)` spans x 380..390, y 0..10.
        shapes: [{ ty: 'gr', it: [path(380), path(0)] }],
      }],
    };
    const plan = planLottieImport(json);
    const far = plan.layers.filter((l) => l.pointsTrack).find((l) => inkCentre(l)[0] > 100)!;
    // The ink is still where the file put it…
    expect(inkCentre(far)).toEqual([385, 5]);
    // …but the outline itself now sits on its own origin, so `outlineExtent`
    // (2 × max|v|) is the glyph's real 10×10 rather than 780×10.
    const pts = far.pointsTrack!.keyframes[0]!.value as Array<{ x: number; y: number }>;
    const half = Math.max(...pts.map((p) => Math.abs(p.x)));
    expect(half * 2).toBe(10);
  });
});

describe('warnings', () => {
  it('names masks, blend modes, trim paths, repeaters and time stretch — once each', () => {
    const json: LottieJson = {
      fr: 30, op: 30,
      layers: [
        { ty: 4, ind: 1, nm: 'A', hasMask: true, masksProperties: [{}], bm: 3, sr: 2,
          shapes: [{ ty: 'gr', it: [path(0), path(10), { ty: 'tm' }, { ty: 'rp' }] }] },
      ],
    };
    const w = planLottieImport(json).warnings;
    expect(w.some((s) => /mask/i.test(s))).toBe(true);
    expect(w.some((s) => /blend mode/i.test(s))).toBe(true);
    expect(w.some((s) => /trim-path/i.test(s))).toBe(true);
    expect(w.some((s) => /repeater/i.test(s))).toBe(true);
    expect(w.some((s) => /time stretch/i.test(s))).toBe(true);
    // Deduplicated: a file with forty identical trim-paths says it once.
    expect(new Set(w).size).toBe(w.length);
  });
});
