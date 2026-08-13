/**
 * Taper and Wave tracks reach the renderer.
 *
 * ## Why this file exists at all
 *
 * `strokeProfile.test.ts` pins the profile maths and `strokeProfiled.test.ts`
 * pins the ribbon it draws. Both pass on a build where no TRACK ever reaches
 * either — which is exactly F34 and F35, twice on this board. Nine new
 * keyframeable properties is nine new chances to make the same mistake, so the
 * crossing gets its own guard: `buildSnapshot(...).layers[].stroke.taper/.wave`.
 *
 * ## The fallback rule this pins, which is the part that is easy to get wrong
 *
 * Animating ONE of the nine must not reset the other eight. The fold falls back
 * to the STORED profile, not to a constant — so a statically authored taper
 * survives when only its phase is keyframed. A fixture where the stored values
 * equal the defaults could not tell those apart, so the stored profile here is
 * deliberately non-default on every field.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const comp = { width: 400, height: 300, background: '#101014' };

/** Non-default on every field — see the header. */
const STORED_TAPER = {
  startWidth: 0.3, endWidth: 0.7,
  startLength: 0.2, endLength: 0.4,
  startEase: 0.5, endEase: 0.6,
};
const STORED_WAVE = { amount: 7, wavelength: 55, phase: 20 };

function node(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 150, width: 160, height: 120 } },
    ],
  } as unknown as SceneNode;
}

function scene(): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addNode(node('s'));
  graph.setStroke('s', {
    enabled: true, color: '#33e0a0', width: 12, opacity: 1,
    align: 'center', dash: [], cap: 'butt', join: 'miter',
    taper: { ...STORED_TAPER }, wave: { ...STORED_WAVE },
  } as never);
  return { graph, anim: new AnimationEngine() };
}

const strokeAt = (graph: SceneGraph, anim: AnimationEngine, t: number) => {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  return snap.layers.find((l) => l.id === 's')!.stroke;
};

describe('the fixture is unclean, as the fallback rule requires', () => {
  it('POSITIVE CONTROL: no stored field equals its registry default', () => {
    // Defaults are 1/1/0/0/0/0 for taper and 0/0/0 for wave. If any stored
    // value matched, "the fold fell back to the stored profile" and "the fold
    // fell back to a constant" would be indistinguishable on that field.
    expect(Object.values(STORED_TAPER)).not.toContain(1);
    expect(Object.values(STORED_TAPER)).not.toContain(0);
    expect(Object.values(STORED_WAVE)).not.toContain(0);
  });

  it('the STORED profile survives with no tracks at all', () => {
    const { graph, anim } = scene();
    const s = strokeAt(graph, anim, 0);
    expect(s?.taper).toEqual(STORED_TAPER);
    expect(s?.wave).toEqual(STORED_WAVE);
  });
});

describe('an animated track reaches the resolved stroke', () => {
  it.each([
    ['strokeTaperStartWidth', 0.15],
    ['strokeTaperEndWidth', 0.25],
    ['strokeTaperStartLength', 0.35],
    ['strokeTaperEndLength', 0.45],
    ['strokeTaperStartEase', 0.55],
    ['strokeTaperEndEase', 0.65],
  ])('%s lands on the taper', (prop, value) => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', prop, 0, value, 'linear');
    const key = prop.replace('strokeTaper', '');
    const field = key.charAt(0).toLowerCase() + key.slice(1);
    expect((strokeAt(graph, anim, 0)?.taper as unknown as Record<string, number>)[field]).toBeCloseTo(value, 6);
  });

  it.each([
    ['strokeWaveAmount', 'amount', 13],
    ['strokeWaveWavelength', 'wavelength', 90],
    ['strokeWavePhase', 'phase', 135],
  ])('%s lands on the wave', (prop, field, value) => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', prop, 0, value, 'linear');
    expect((strokeAt(graph, anim, 0)?.wave as unknown as Record<string, number>)[field]).toBeCloseTo(value, 6);
  });

  it('PHASE animates over time — the one the feature is for', () => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'strokeWavePhase', 0, 0, 'linear');
    anim.setKeyframe('s', 'strokeWavePhase', 2, 360, 'linear');
    expect(strokeAt(graph, anim, 0)?.wave?.phase).toBeCloseTo(0, 5);
    expect(strokeAt(graph, anim, 1)?.wave?.phase).toBeCloseTo(180, 5);
    expect(strokeAt(graph, anim, 2)?.wave?.phase).toBeCloseTo(360, 5);
  });
});

describe('animating ONE field does not reset the others', () => {
  it('a keyframed phase leaves the stored amount and wavelength alone', () => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'strokeWavePhase', 0, 99, 'linear');
    const w = strokeAt(graph, anim, 0)?.wave;
    expect({ amount: w?.amount, wavelength: w?.wavelength, phase: w?.phase })
      .toEqual({ amount: STORED_WAVE.amount, wavelength: STORED_WAVE.wavelength, phase: 99 });
  });

  it('a keyframed start width leaves the other five taper fields alone', () => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'strokeTaperStartWidth', 0, 0.05, 'linear');
    expect(strokeAt(graph, anim, 0)?.taper).toEqual({ ...STORED_TAPER, startWidth: 0.05 });
  });

  it('a taper track does not invent a wave, and vice versa', () => {
    // The two groups are independent; folding one must not synthesise the other.
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'strokeTaperStartWidth', 0, 0.05, 'linear');
    expect(strokeAt(graph, anim, 0)?.wave).toEqual(STORED_WAVE);
  });
});
