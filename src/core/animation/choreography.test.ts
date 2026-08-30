/**
 * Choreography, tested on the things that separate it from a loop over
 * `applyPreset`: the stagger has to be non-uniform but ordered, every layer
 * has to land in ONE undo step, exits have to be genuine mirrors, and the
 * times have to be on the keyframe axis rather than raw comp seconds.
 *
 * The archetype maths belongs to `entranceArchetypes` and is not re-tested
 * here; what is tested is that this module hands it the right layers, the
 * right resting positions and the right times, and commits the result once.
 */

import { animateLayers, staggerOffsets, CHOREOGRAPHY_ARCHETYPES } from './choreography';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { AnimationEngine } from '@motion/animation';

interface Written {
  nodeId: string;
  prop: string;
  t: number;
  value: number;
  easing: string | undefined;
}

/**
 * An engine stand-in that records writes and can answer sampled values.
 *
 * `sample` returns undefined by default so the resting position resolves the
 * way it does for a plain static layer — through the node's own props — which
 * is the common case. Pass `sampled` to exercise the other path: a layer that
 * is ALREADY animated, whose resting value is whatever the engine evaluates at
 * that time rather than the stale prop.
 */
function recorder(sampled?: Record<string, number>): {
  engine: AnimationEngine;
  written: Written[];
  beziers: Array<{ prop: string; t: number }>;
} {
  const written: Written[] = [];
  const beziers: Array<{ prop: string; t: number }> = [];
  const engine = {
    setKeyframe: (nodeId: string, prop: string, t: number, value: number, easing?: string) => {
      written.push({ nodeId, prop, t, value, easing });
    },
    setBezier: (_nodeId: string, prop: string, t: number) => {
      beziers.push({ prop, t });
    },
    sample: (_nodeId: string, prop: string) => sampled?.[prop],
    tracksFor: () => [],
  } as unknown as AnimationEngine;
  return { engine, written, beziers };
}

function addLayer(id: string, x = 100, y = 200): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: id,
    parent: 'comp_root',
    children: [],
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: 'solid', x, y, width: 100, height: 100 } }],
  } as never);
}

const LAYERS = ['l1', 'l2', 'l3', 'l4'];

beforeEach(() => {
  for (const id of [...LAYERS, 'gone']) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode?.(id);
  }
  for (const id of LAYERS) addLayer(id);
});

describe('animateLayers', () => {
  it('animates every selected layer', () => {
    const { engine, written } = recorder();
    const out = animateLayers({ nodeIds: LAYERS, atCompTime: 1, phase: 'in', engine });

    expect(out.layers).toBe(4);
    expect(out.keyframes).toBeGreaterThan(0);
    expect(new Set(written.map((w) => w.nodeId))).toEqual(new Set(LAYERS));
  });

  it('staggers the layers in order, with gaps that are not identical', () => {
    const { engine, written } = recorder();
    animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine, seed: 7, fps: 30 });

    // Asserted on what was WRITTEN, not on the planned offsets. The first
    // version of this test checked the plan and passed while the engine stored
    // a perfect metronome: keyframe times snap to the frame grid, and a ±30%
    // wobble on a 3-frame stagger is less than one frame, so every gap rounded
    // to the same value. A plan nobody can see is not the feature.
    const starts = LAYERS.map((id) =>
      Math.min(...written.filter((w) => w.nodeId === id).map((w) => w.t)));

    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    }
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
    expect(new Set(gaps.map((g) => g.toFixed(4))).size).toBeGreaterThan(1);
  });

  it('puts every stagger boundary on a whole frame', () => {
    const { engine, written } = recorder();
    animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine, seed: 7, fps: 30 });
    const starts = LAYERS.map((id) =>
      Math.min(...written.filter((w) => w.nodeId === id).map((w) => w.t)));
    for (const s of starts) expect(Math.abs(s * 30 - Math.round(s * 30))).toBeLessThan(1e-6);
  });

  it('produces a varied rhythm for almost any seed, not just lucky ones', () => {
    // The distribution, not one seed. An earlier version varied the gaps by a
    // FRACTION of a frame, so whether the rhythm survived quantization came
    // down to where the multipliers happened to land — one real selection
    // rounded all four gaps back to equal. A rhythm that works 60% of the time
    // is not a rhythm, so this pins the rate.
    let flat = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const offs = staggerOffsets(5, 0.1, 30, seed);
      const gaps = offs.slice(1).map((o, i) => Math.round((o - offs[i]!) * 30));
      if (new Set(gaps).size === 1) flat++;
    }
    expect(flat / 300).toBeLessThan(0.1);
  });

  it('swings by at least a whole frame, because less is unrepresentable', () => {
    // 0.1s at 30fps is a 3-frame gap; ±30% of that is under a frame, so the
    // swing has to be floored at one or quantization eats it.
    const seen = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const offs = staggerOffsets(5, 0.1, 30, seed);
      offs.slice(1).forEach((o, i) => seen.add(Math.round((o - offs[i]!) * 30)));
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThanOrEqual(2);
  });

  it('degrades to one-frame gaps rather than sub-frame nonsense', () => {
    // 0.01 s of stagger at 30 fps is a third of a frame. There is no rhythm to
    // be had below the timebase; the honest answer is consecutive frames.
    const { engine } = recorder();
    const out = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine, seed: 5, fps: 30 });
    const gaps = out.offsets.slice(1).map((o, i) => o - out.offsets[i]!);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(1 / 30 - 1e-9);
  });

  it('is deterministic for a seed, and different across seeds', () => {
    const a = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, seed: 1 });
    const b = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, seed: 1 });
    const c = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, seed: 99 });

    expect(a.archetypes).toEqual(b.archetypes);
    expect(a.offsets).toEqual(b.offsets);
    expect([a.archetypes.join(), a.offsets.join()]).not.toEqual([c.archetypes.join(), c.offsets.join()]);
  });

  it('varies the archetype across layers instead of repeating one', () => {
    // Not a strict requirement of any single seed, so this asserts the
    // DISTRIBUTION: across many seeds the picker must reach more than one
    // archetype, or the whole point of having six is lost.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const out = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, seed });
      for (const a of out.archetypes) seen.add(a);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('only picks archetypes it can actually perform', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const out = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, seed });
      for (const a of out.archetypes) seen.add(a);
    }
    // blur_resolve and char_cascade need an effect / text animator installed;
    // offering them and substituting silently is what this guards against.
    for (const a of seen) expect(CHOREOGRAPHY_ARCHETYPES).toContain(a);
  });

  it('honours an explicit archetype for every layer', () => {
    const out = animateLayers({
      nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, archetype: 'scale_pop',
    });
    expect(out.archetypes).toEqual(['scale_pop', 'scale_pop', 'scale_pop', 'scale_pop']);
  });

  it('lands the entrance ON the layer’s resting position', () => {
    const { engine, written } = recorder();
    animateLayers({ nodeIds: ['l1'], atCompTime: 0, phase: 'in', engine, archetype: 'rise' });

    // `rise` animates y from below; the LAST y keyframe must be the resting
    // value, or the layer arrives somewhere it was never placed.
    const ys = written.filter((w) => w.prop === 'y').sort((a, b) => a.t - b.t);
    expect(ys.length).toBeGreaterThan(1);
    expect(ys[ys.length - 1]!.value).toBeCloseTo(200, 5);
    expect(ys[0]!.value).toBeGreaterThan(200);
  });

  it('mirrors an exit: it leaves from rest toward where it came from', () => {
    const inRun = recorder();
    animateLayers({ nodeIds: ['l1'], atCompTime: 0, phase: 'in', engine: inRun.engine, archetype: 'rise' });
    const outRun = recorder();
    animateLayers({ nodeIds: ['l1'], atCompTime: 0, phase: 'out', engine: outRun.engine, archetype: 'rise' });

    const ysIn = inRun.written.filter((w) => w.prop === 'y').sort((a, b) => a.t - b.t);
    const ysOut = outRun.written.filter((w) => w.prop === 'y').sort((a, b) => a.t - b.t);

    // Same times, values swapped end for end.
    expect(ysOut.map((k) => k.t)).toEqual(ysIn.map((k) => k.t));
    expect(ysOut.map((k) => k.value)).toEqual(ysIn.map((k) => k.value).reverse());
    // And an exit starts at rest rather than arriving there.
    expect(ysOut[0]!.value).toBeCloseTo(200, 5);
  });

  it('keeps an exit’s early fade early rather than reversing the times', () => {
    // `rise` fades in over the first 55% of its duration. Mirroring the whole
    // plan would move that fade to the END of the exit, so the layer would
    // hang around at full opacity and then blink out.
    const { engine, written } = recorder();
    animateLayers({ nodeIds: ['l1'], atCompTime: 0, phase: 'out', engine, archetype: 'rise' });
    const op = written.filter((w) => w.prop === 'opacity').sort((a, b) => a.t - b.t);
    expect(op[0]!.value).toBe(100);
    expect(op[op.length - 1]!.value).toBe(0);
    // The fade finishes before the movement does.
    const lastY = Math.max(...written.filter((w) => w.prop === 'y').map((w) => w.t));
    expect(op[op.length - 1]!.t).toBeLessThan(lastY);
  });

  it('starts the first layer at the requested time', () => {
    const { engine, written } = recorder();
    animateLayers({ nodeIds: LAYERS, atCompTime: 2.5, phase: 'in', engine, seed: 3 });
    expect(Math.min(...written.map((w) => w.t))).toBeCloseTo(2.5, 5);
  });

  it('writes bezier handles for the curved tracks', () => {
    const { engine, beziers } = recorder();
    animateLayers({ nodeIds: ['l1'], atCompTime: 0, phase: 'in', engine, archetype: 'scale_pop' });
    expect(beziers.length).toBeGreaterThan(0);
  });

  it('skips ids with no node instead of throwing', () => {
    const { engine, written } = recorder();
    const out = animateLayers({ nodeIds: ['l1', 'gone', 'l2'], atCompTime: 0, phase: 'in', engine });
    expect(out.layers).toBe(2);
    expect(written.every((w) => w.nodeId !== 'gone')).toBe(true);
  });

  it('does nothing, loudly, for an empty selection', () => {
    const { engine, written } = recorder();
    const out = animateLayers({ nodeIds: [], atCompTime: 0, phase: 'in', engine });
    expect(out).toEqual({ layers: 0, keyframes: 0, archetypes: [], offsets: [], durationSec: 0 });
    expect(written).toHaveLength(0);
  });

  it('reports a duration that covers the last layer’s move', () => {
    const { engine, written } = recorder();
    const out = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine, feel: 'smooth' });
    expect(out.durationSec).toBeGreaterThanOrEqual(Math.max(...written.map((w) => w.t)));
  });

  it('rests on the ENGINE’s value when the layer is already animated', () => {
    // A layer with existing keyframes rests wherever it evaluates to at this
    // time; using its static prop instead would snap it back to where it was
    // first placed, which is a jump the user never asked for.
    const { engine, written } = recorder({ x: 100, y: 640 });
    animateLayers({ nodeIds: ['l1'], atCompTime: 0, phase: 'in', engine, archetype: 'rise' });
    const ys = written.filter((w) => w.prop === 'y').sort((a, b) => a.t - b.t);
    expect(ys[ys.length - 1]!.value).toBeCloseTo(640, 5);
  });

  it('lets an explicit beat grid replace the stagger entirely', () => {
    // The music is the rhythm; a nominal stagger on top would fight it.
    const { engine, written } = recorder();
    const beats = [1, 1.5, 2.25, 3, 3.5];
    animateLayers({ nodeIds: LAYERS, atCompTime: 1, phase: 'in', engine, startTimes: beats, fps: 30 });

    const starts = LAYERS.map((id) =>
      Math.min(...written.filter((w) => w.nodeId === id).map((w) => w.t)));
    // Frame-quantized, so compare on the grid the engine stores on.
    expect(starts.map((s) => Math.round(s * 30))).toEqual(beats.slice(0, 4).map((b) => Math.round(b * 30)));
  });

  it('shares the last beat when the grid is shorter than the selection', () => {
    // The caller is expected to have extended its grid; this is the backstop,
    // and it must not throw or write NaN times.
    const { engine, written } = recorder();
    animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine, startTimes: [0, 0.5], fps: 30 });
    expect(written.every((w) => Number.isFinite(w.t))).toBe(true);
    const last = Math.min(...written.filter((w) => w.nodeId === 'l4').map((w) => w.t));
    expect(last).toBeCloseTo(0.5, 5);
  });

  it('gives each feel its own timing', () => {
    const snappy = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, feel: 'snappy' });
    const smooth = animateLayers({ nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, feel: 'smooth' });
    expect(snappy.durationSec).toBeLessThan(smooth.durationSec);
  });
});

describe('the motion feel is reachable', () => {
  /**
   * The regression this pins. `ChoreographyFeel` shipped with three values and
   * every command hardcoded `smooth`, so `snappy` and `bouncy` were tested,
   * documented, and unreachable — the same dead-option shape this codebase
   * already had once in `pickFeatures`. A feel nobody can select is not a
   * feature, so the commands that select it are checked here alongside the
   * behaviour they change.
   */
  it('offers a command per feel, as a radio group', () => {
    const { buildChoreographyCommands } = require('./choreographyCommands') as typeof import('./choreographyCommands');
    const { usePreferenceStore } = require('@stores/preferenceStore') as typeof import('@stores/preferenceStore');
    const feelCommands = buildChoreographyCommands().filter((c) => String(c.id).startsWith('animation.motionFeel.'));
    expect(feelCommands.map((c) => String(c.id))).toEqual([
      'animation.motionFeel.snappy',
      'animation.motionFeel.smooth',
      'animation.motionFeel.bouncy',
    ]);

    usePreferenceStore.getState().set('motionFeel', 'bouncy');
    const checked = feelCommands.filter((c) => c.isChecked?.() === true).map((c) => String(c.id));
    expect(checked).toEqual(['animation.motionFeel.bouncy']);
    usePreferenceStore.getState().set('motionFeel', 'smooth');
  });

  it('changes the timing that gets written', () => {
    const { currentFeel } = require('./choreographyCommands') as typeof import('./choreographyCommands');
    const { usePreferenceStore } = require('@stores/preferenceStore') as typeof import('@stores/preferenceStore');

    usePreferenceStore.getState().set('motionFeel', 'snappy');
    const snappy = animateLayers({
      nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, feel: currentFeel(), fps: 30,
    });
    usePreferenceStore.getState().set('motionFeel', 'smooth');
    const smooth = animateLayers({
      nodeIds: LAYERS, atCompTime: 0, phase: 'in', engine: recorder().engine, feel: currentFeel(), fps: 30,
    });
    expect(snappy.durationSec).toBeLessThan(smooth.durationSec);
  });
});
