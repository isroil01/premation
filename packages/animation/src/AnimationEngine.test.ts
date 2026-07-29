import { sampleTrack } from './interpolate';
import { AnimationEngine } from './AnimationEngine';
import { makeKeyframeId, parseKeyframeId } from './keyframeId';
import type { PropertyTrack } from './types';

const track = (keyframes: PropertyTrack['keyframes']): PropertyTrack => ({
  nodeId: 'n',
  prop: 'x',
  keyframes,
});

describe('sampleTrack', () => {
  test('clamps before first and after last keyframe', () => {
    const t = track([{ t: 1, value: 10 }, { t: 3, value: 30 }]);
    expect(sampleTrack(t, 0)).toBe(10);
    expect(sampleTrack(t, 5)).toBe(30);
  });

  test('linear interpolates the midpoint', () => {
    const t = track([{ t: 0, value: 0 }, { t: 2, value: 100 }]);
    expect(sampleTrack(t, 1)).toBeCloseTo(50);
  });

  test('step easing holds the start value', () => {
    const t = track([{ t: 0, value: 0, easing: 'step' }, { t: 2, value: 100 }]);
    expect(sampleTrack(t, 1.9)).toBe(0);
    expect(sampleTrack(t, 2)).toBe(100);
  });

  test('easeIn is below linear at the midpoint', () => {
    const t = track([{ t: 0, value: 0, easing: 'easeIn' }, { t: 1, value: 100 }]);
    expect(sampleTrack(t, 0.5)).toBeCloseTo(25); // 0.5^2 * 100
  });

  test('empty track returns undefined', () => {
    expect(sampleTrack(track([]), 1)).toBeUndefined();
  });
});

describe('AnimationEngine', () => {
  test('setKeyframe + sample', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 100);
    a.setKeyframe('n1', 'x', 2, 300);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(200);
    expect(a.hasAnimation('n1')).toBe(true);
  });

  test('evaluateScene returns only animated props', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 10);
    a.setKeyframe('n1', 'y', 0, 5);
    const snap = a.evaluateScene(0.5);
    expect(snap.get('n1')?.get('x')).toBeCloseTo(5);
    expect(snap.get('n1')?.get('y')).toBe(5);
    expect(snap.get('n2')).toBeUndefined();
  });

  test('keyframes stay sorted and replace on same time', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 2, 20);
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 0, 5); // replace
    const kfs = a.tracksFor('n1')[0]!.keyframes;
    expect(kfs.map((k) => k.t)).toEqual([0, 2]);
    expect(kfs[0]!.value).toBe(5);
  });

  test('setBezier switches the keyframe to a custom easing curve', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setBezier('n1', 'x', 0, [1 / 3, 0, 2 / 3, 1]);
    const kf = a.tracksFor('n1')[0]!.keyframes[0]!;
    expect(kf.easing).toBe('bezier');
    expect(kf.bezier).toEqual([1 / 3, 0, 2 / 3, 1]);
  });

  test('setEasing to autoBezier seeds default bezier handles', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setEasing('n1', 'x', 0, 'autoBezier');
    const kf = a.tracksFor('n1')[0]!.keyframes[0]!;
    expect(kf.easing).toBe('autoBezier');
    expect(kf.bezier).toEqual([0.333, 0, 0.667, 1]);
  });

  test('setRoving flags and re-times the keyframe for constant speed', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 50); // off-centre in time
    a.setKeyframe('n1', 'x', 10, 100);
    a.setRoving('n1', 'x', 2, true);
    const mid = a.tracksFor('n1')[0]!.keyframes[1]!;
    expect(mid.roving).toBe(true);
    expect(mid.t).toBeCloseTo(5, 4); // equal value steps ⇒ centred in the span
  });

  test('evaluateNode samples only that node at the given time', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setKeyframe('n2', 'x', 0, 999);
    const v = a.evaluateNode('n1', 1);
    expect(v.get('x')).toBeCloseTo(50); // n1 midpoint, sampled at t=1
    expect(v.has('y')).toBe(false);
    // Sampling at a remapped time gives a different value (E6 time stretch).
    expect(a.evaluateNode('n1', 0.5).get('x')).toBeCloseTo(25);
  });

  test('timeSpan reports first→last keyframe across a node’s tracks', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 1, 0);
    a.setKeyframe('n1', 'x', 4, 0);
    a.setKeyframe('n1', 'y', 0, 0);
    a.setKeyframe('n1', 'y', 6, 0);
    expect(a.timeSpan('n1')).toEqual({ start: 0, end: 6 });
    expect(a.timeSpan('missing')).toBeNull();
  });

  test('moveKeyframe reties a keyframe to a new time, preserving value', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.moveKeyframe('n1', 'x', 1, 3);
    const kfs = a.tracksFor('n1')[0]!.keyframes;
    expect(kfs.map((k) => k.t)).toEqual([0, 3]);
    expect(a.sample('n1', 'x', 3)).toBe(100);
  });

  test('removeTrack disables animation for a prop', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    expect(a.isAnimated('n1', 'x')).toBe(true);
    a.removeTrack('n1', 'x');
    expect(a.isAnimated('n1', 'x')).toBe(false);
  });
});

describe('expression API v2 (engine)', () => {
  test('valueAtTime samples own keyframes, not the expression (no recursion)', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setExpression('n1', 'x', 'valueAtTime(1) + 1');
    // 51 at every playhead: keyframed value at t=1 (50) + 1 — never 52, 53…
    expect(a.sample('n1', 'x', 0)).toBeCloseTo(51);
    expect(a.sample('n1', 'x', 2)).toBeCloseTo(51);
  });

  test("layer() reads another node's keyframed value via the resolver", () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'Title' ? 'title' : null));
    a.setKeyframe('title', 'x', 0, 0);
    a.setKeyframe('title', 'x', 2, 200);
    a.setKeyframe('follower', 'y', 0, 0); // needs a track so sample() runs
    a.setExpression('follower', 'y', "layer('Title', 'x') / 2");
    expect(a.sample('follower', 'y', 1)).toBeCloseTo(50); // title.x@1 = 100
    // layerAt reads at an explicit time, independent of the playhead.
    a.setExpression('follower', 'y', "layerAt('Title', 'x', 2)");
    expect(a.sample('follower', 'y', 0)).toBeCloseTo(200);
  });

  test("layer() evaluates the referenced layer's expression (AE chaining)", () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'Title' ? 'title' : null));
    a.setKeyframe('title', 'x', 0, 0);
    a.setKeyframe('title', 'x', 2, 200);
    a.setExpression('title', 'x', 'value + 1000'); // evaluates title's expression when sampled
    a.setKeyframe('follower', 'y', 0, 0);
    a.setExpression('follower', 'y', "layer('Title', 'x')");
    expect(a.sample('follower', 'y', 1)).toBeCloseTo(1100); // chained expression
    expect(a.sample('title', 'x', 1)).toBeCloseTo(1100);
  });

  test('previewExpression surfaces explicit cycle detection error when cross-layer cycle exists', () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => {
      if (name === 'Layer A') return 'nodeA';
      if (name === 'Layer B') return 'nodeB';
      return null;
    });
    a.setKeyframe('nodeA', 'x', 0, 10);
    a.setKeyframe('nodeB', 'x', 0, 20);
    a.setExpression('nodeA', 'x', "layer('Layer B', 'x') + 5");
    a.setExpression('nodeB', 'x', "layer('Layer A', 'x') + 5");

    const res = a.previewExpression('nodeA', 'x', "layer('Layer B', 'x') + 5", 0);
    expect(res.error).toMatch(/Cycle detected across expression evaluation/i);
  });

  test('layer() falls back to the host base-value provider when un-keyframed', () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'Title' ? 'title' : null));
    a.setBaseValueProvider((nodeId, prop) => (nodeId === 'title' && prop === 'x' ? 320 : undefined));
    a.setKeyframe('follower', 'y', 0, 0);
    a.setExpression('follower', 'y', "layer('Title', 'x') + 5");
    expect(a.sample('follower', 'y', 0)).toBe(325);
  });

  test('unknown layer resolves to 0 (graceful)', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setExpression('n1', 'x', "layer('Ghost', 'x') + 5");
    expect(a.sample('n1', 'x', 0)).toBe(5);
  });

  test("self-referencing layer('self') surfaces cycle error in preview and falls back safely during sampling", () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'self' ? 'n1' : null));
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setExpression('n1', 'x', "layer('self', 'x') + 10");
    // In preview mode, explicit error is surfaced:
    expect(a.previewExpression('n1', 'x', "layer('self', 'x') + 10", 1).error).toMatch(/Cycle detected/i);
    // When sampling during rendering, safely falls back to keyframed base (50):
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50);
  });

  test('loopOut cycle / pingpong / offset via engine sampling', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.setExpression('n1', 'x', "loopOut('cycle')");
    expect(a.sample('n1', 'x', 0.5)).toBeCloseTo(50); // inside span untouched
    expect(a.sample('n1', 'x', 1.25)).toBeCloseTo(25);
    a.setExpression('n1', 'x', "loopOut('pingpong')");
    expect(a.sample('n1', 'x', 1.25)).toBeCloseTo(75);
    a.setExpression('n1', 'x', "loopOut('offset')");
    expect(a.sample('n1', 'x', 1.5)).toBeCloseTo(150);
  });

  test('loopIn maps time before the first keyframe (non-zero span start)', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 1, 0);
    a.setKeyframe('n1', 'x', 2, 100);
    a.setExpression('n1', 'x', "loopIn('cycle')");
    expect(a.sample('n1', 'x', 0.5)).toBeCloseTo(50); // ≙ keyframed value @1.5
    a.setExpression('n1', 'x', "loopIn('offset')");
    expect(a.sample('n1', 'x', 0.5)).toBeCloseTo(-50);
  });

  test('previewExpression evaluates with the same context as sample()', () => {
    const a = new AnimationEngine();
    a.setLayerResolver((name) => (name === 'Title' ? 'title' : null));
    a.setKeyframe('title', 'x', 0, 0);
    a.setKeyframe('title', 'x', 2, 200);
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    const r = a.previewExpression('n1', 'x', "loopOut('cycle') + layer('Title', 'x')", 1.25);
    expect(r.error).toBeNull();
    expect(r.value).toBeCloseTo(25 + 125);
  });

  test('deterministic: repeated samples of v2 expressions are identical', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.setExpression('n1', 'x', "loopOut('offset') + valueAtTime(0.5) + wiggle(3, 20)");
    const first = a.sample('n1', 'x', 4.2);
    expect(a.sample('n1', 'x', 4.2)).toBe(first);
    expect(typeof first).toBe('number');
  });
});

describe('keyframeId codec', () => {
  test('round-trips node/prop/time', () => {
    const id = makeKeyframeId('shape_circle', 'x', 2.5);
    expect(parseKeyframeId(id)).toEqual({ nodeId: 'shape_circle', prop: 'x', t: 2.5 });
  });

  test('rejects malformed ids', () => {
    expect(parseKeyframeId('bad')).toBeNull();
    expect(parseKeyframeId('a::b::notnum')).toBeNull();
  });
});

describe('spatial tangents (engine)', () => {
  it('setSpatialTangent sets, leaves, and clears each side independently', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.setSpatialTangent('n1', 'x', 0, { so: 40 });
    a.setSpatialTangent('n1', 'x', 1, { si: -20 });
    let kfs = a.getTrackKeyframes('n1', 'x')!;
    expect(kfs[0]!.so).toBe(40);
    expect(kfs[1]!.si).toBe(-20);
    // undefined leaves a side untouched; null clears it.
    a.setSpatialTangent('n1', 'x', 0, { si: 5 });
    a.setSpatialTangent('n1', 'x', 0, { so: null });
    kfs = a.getTrackKeyframes('n1', 'x')!;
    expect(kfs[0]!.si).toBe(5);
    expect(kfs[0]!.so).toBeUndefined();
  });

  it('the sampled value bends through the tangents', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    const straight = a.sample('n1', 'x', 0.5)!;
    a.setSpatialTangent('n1', 'x', 0, { so: 60 });
    a.setSpatialTangent('n1', 'x', 1, { si: 60 });
    expect(a.sample('n1', 'x', 0.5)!).toBeGreaterThan(straight);
    expect(a.sample('n1', 'x', 0)!).toBeCloseTo(0);
    expect(a.sample('n1', 'x', 1)!).toBeCloseTo(100);
  });

  it('smoothSpatialTangents / clearSpatialTangents round-trip the track', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.setKeyframe('n1', 'x', 2, 0);
    a.smoothSpatialTangents('n1', 'x');
    const smoothed = a.getTrackKeyframes('n1', 'x')!;
    expect(smoothed[0]!.so).toBeDefined();
    expect(smoothed[1]!.si).toBeDefined();
    a.clearSpatialTangents('n1', 'x');
    const cleared = a.getTrackKeyframes('n1', 'x')!;
    expect(cleared.every((k) => k.si === undefined && k.so === undefined)).toBe(true);
  });

  it('re-keying a value at the same time preserves tangents, easing and bezier', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0, 'easeIn');
    a.setSpatialTangent('n1', 'x', 0, { so: 40 });
    a.setKeyframe('n1', 'x', 0, 25); // value-only re-key (e.g. path point drag)
    const kf = a.getTrackKeyframes('n1', 'x')![0]!;
    expect(kf.value).toBe(25);
    expect(kf.so).toBe(40);
    expect(kf.easing).toBe('easeIn');
  });

  it('tangents survive snapshot → restore', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.setSpatialTangent('n1', 'x', 0, { so: 33 });
    const snap = a.snapshot();
    const b = new AnimationEngine();
    b.restore(snap);
    expect(b.getTrackKeyframes('n1', 'x')![0]!.so).toBe(33);
  });

  it('updateKeyframe keeps tangents through time/value patches', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.setSpatialTangent('n1', 'x', 1, { si: -15 });
    a.updateKeyframe('n1', 'x', 1, { t: 2, value: 90 });
    const kf = a.getTrackKeyframes('n1', 'x')!.find((k) => k.t === 2)!;
    expect(kf.value).toBe(90);
    expect(kf.si).toBe(-15);
  });
});

describe('batch()', () => {
  // The app's change listener runs a synchronous scene bump + hit-test
  // invalidation + autosave scheduling. One interactive edit affords that; a
  // bulk import firing it per track froze the app. batch holds notifications
  // and flushes ONE '*' at the end.

  test('coalesces every notification inside into one final "*"', () => {
    const a = new AnimationEngine();
    const seen: string[] = [];
    a.setChangeListener((id) => seen.push(id));
    a.batch(() => {
      for (let i = 0; i < 50; i++) a.setKeyframe(`n${i}`, 'x', 0, i);
      a.setKeyframes('bulk', 'y', [{ t: 0, value: 0 }, { t: 1, value: 10 }]);
    });
    expect(seen).toEqual(['*']);
    // The writes themselves all landed.
    expect(a.tracksFor('n49')).toHaveLength(1);
    expect(a.tracksFor('bulk')[0]!.keyframes).toHaveLength(2);
  });

  test('emits nothing when the batch made no changes', () => {
    const a = new AnimationEngine();
    const seen: string[] = [];
    a.setChangeListener((id) => seen.push(id));
    a.batch(() => {});
    expect(seen).toEqual([]);
  });

  test('nested batches flush once, at the outermost close', () => {
    const a = new AnimationEngine();
    const seen: string[] = [];
    a.setChangeListener((id) => seen.push(id));
    a.batch(() => {
      a.setKeyframe('n1', 'x', 0, 1);
      a.batch(() => a.setKeyframe('n2', 'x', 0, 2));
      expect(seen).toEqual([]); // inner close must not flush
    });
    expect(seen).toEqual(['*']);
  });

  test('still flushes when the batched function throws', () => {
    // Listeners must not be left stale about mutations that landed before the
    // error — a half-imported file still has to show up.
    const a = new AnimationEngine();
    const seen: string[] = [];
    a.setChangeListener((id) => seen.push(id));
    expect(() =>
      a.batch(() => {
        a.setKeyframe('n1', 'x', 0, 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toEqual(['*']);
  });

  test('notifications outside a batch still fire per call', () => {
    const a = new AnimationEngine();
    const seen: string[] = [];
    a.setChangeListener((id) => seen.push(id));
    a.setKeyframe('n1', 'x', 0, 1);
    a.setKeyframe('n1', 'x', 1, 2);
    expect(seen).toEqual(['n1', 'n1']);
  });
});
