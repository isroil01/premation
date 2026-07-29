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
    const firstXs = drawables.map((d) => (d.pointsTrack!.keyframes[0]!.value as Array<{ x: number }>)[0]!.x);
    expect(firstXs).toEqual([0, 20, 40]);
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
    expect(wrap.staticProps).toMatchObject({ scaleX: 2, scaleY: 2, rotation: 45, opacity: 50 });
    // The drawable hangs off the container, not off the host.
    expect(plan.layers.find((l) => l.pointsTrack)!.parentUid).toBe(wrap.uid);
  });

  it('a group anchor is baked into its children (the engine composes with anchor 0)', () => {
    const plan = planLottieImport(grouped({
      p: { a: 0, k: [0, 0] }, a: { a: 0, k: [10, 20] },
      s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
    }));
    const child = plan.layers.find((l) => l.pointsTrack)!;
    expect([child.x, child.y]).toEqual([-10, -20]);
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
