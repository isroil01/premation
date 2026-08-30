/**
 * Does the RENDERER actually slow down?
 *
 * `speedRamp.test.ts` proves the curve is the right integral and
 * `speedRampCommands.test.ts` proves the right curve gets written. Neither
 * would notice if `buildSnapshot` ignored the track — which is the real risk
 * here, because `timeRemap` is only sampled for precomp containers, and a ramp
 * written onto anything else is stored, drawn in the graph editor, and inert.
 *
 * So this drives the actual snapshot builder and reads `sourceTime` off the
 * precomp container: the source playhead the renderer chose for that layer,
 * which is the number a ramp exists to change.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { buildTimeRemap, type SpeedPoint } from './speedRamp';

const PRECOMP = 'pre';
const CHILD = 'ch';

/**
 * A precomp with one shape inside it.
 *
 * The child is not decoration: an EMPTY precomp is not emitted into the
 * snapshot at all (verified — it renders nothing, which is correct), so a
 * fixture without one reads back the identity for every ramp and quietly
 * proves nothing.
 */
function setup(): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addChild(null as unknown as string, {
    id: PRECOMP, name: PRECOMP, parent: null, children: [CHILD], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'pre_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'group', x: 0, y: 0, width: 100, height: 100 } },
      { id: 'pre_fx', type: 'fx', props: { precomp: true } },
    ],
  } as unknown as SceneNode);
  graph.addChild(PRECOMP, {
    id: CHILD, name: CHILD, parent: PRECOMP, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'ch_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 10, height: 10 } },
      { id: 'ch_s', type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as unknown as SceneNode);
  return { graph, anim: new AnimationEngine() };
}

/** Apply a speed profile as this precomp's time-remap track. */
function ramp(anim: AnimationEngine, profile: SpeedPoint[]): void {
  anim.setKeyframes(PRECOMP, 'timeRemap', buildTimeRemap(profile, 0).map((k) => ({
    t: k.t,
    value: k.value,
    ...(k.bezier ? { easing: 'bezier', bezier: k.bezier } : { easing: 'linear' }),
  })) as never);
}

/** The source playhead the renderer chose for the precomp at comp time `t`. */
function sourceTimeAt(graph: SceneGraph, anim: AnimationEngine, t: number): number {
  const layer = buildSnapshot(graph, anim, t).layers.find((l) => l.id === PRECOMP);
  return layer?.sourceTime ?? t;
}

describe('a speed ramp changes what the renderer shows', () => {
  it('runs source time with comp time when there is no remap', () => {
    // The control. Without this the readings below prove nothing.
    const { graph, anim } = setup();
    expect(sourceTimeAt(graph, anim, 2)).toBeCloseTo(2, 3);
    expect(sourceTimeAt(graph, anim, 4)).toBeCloseTo(4, 3);
  });

  it('advances source time at a quarter rate after ramping to 25%', () => {
    const { graph, anim } = setup();
    ramp(anim, [{ t: 0, speed: 1 }, { t: 0.5, speed: 0.25 }, { t: 10, speed: 0.25 }]);

    const a = sourceTimeAt(graph, anim, 2);
    const b = sourceTimeAt(graph, anim, 6);
    expect((b - a) / 4).toBeCloseTo(0.25, 2);
  });

  it('decelerates through the transition rather than stepping', () => {
    // The ramp's whole point: speed between the two anchors is in between,
    // not one value then the other.
    const { graph, anim } = setup();
    ramp(anim, [{ t: 0, speed: 1 }, { t: 1, speed: 0.25 }, { t: 10, speed: 0.25 }]);

    const slopeAt = (t: number): number =>
      (sourceTimeAt(graph, anim, t + 0.01) - sourceTimeAt(graph, anim, t)) / 0.01;
    const early = slopeAt(0.05);
    const middle = slopeAt(0.5);
    const late = slopeAt(0.95);
    expect(early).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(late);
    expect(early).toBeCloseTo(1, 1);
    expect(late).toBeCloseTo(0.25, 1);
  });

  it('holds one source frame when ramped to a freeze', () => {
    const { graph, anim } = setup();
    ramp(anim, [{ t: 0, speed: 1 }, { t: 0.5, speed: 0 }, { t: 10, speed: 0 }]);
    expect(sourceTimeAt(graph, anim, 8)).toBeCloseTo(sourceTimeAt(graph, anim, 3), 3);
  });

  it('runs source time faster than comp time when sped up', () => {
    const { graph, anim } = setup();
    ramp(anim, [{ t: 0, speed: 1 }, { t: 0.5, speed: 2 }, { t: 10, speed: 2 }]);
    const a = sourceTimeAt(graph, anim, 2);
    const b = sourceTimeAt(graph, anim, 6);
    expect((b - a) / 4).toBeCloseTo(2, 1);
  });
});

describe('a VIDEO layer honours its own time remap', () => {
  /**
   * The correction. This file first tested only precomps, on the belief that
   * `timeRemap` was sampled for precomp containers alone — `precompSourceTime`
   * and the precomp ancestor chain both say so, and the general layer path a
   * thousand lines further down samples it for EVERY node. Ramping a video
   * clip is the main thing anyone wants a speed ramp for, and the commands
   * were refusing it.
   */
  const VIDEO = 'vid';

  function videoSetup(): { graph: SceneGraph; anim: AnimationEngine } {
    const graph = new SceneGraph();
    graph.addChild(null as unknown as string, {
      id: VIDEO, name: VIDEO, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        {
          id: 'vid_t',
          type: 'Transform',
          props: { [SCENE_KIND_PROP]: 'video', assetId: 'a1', x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    } as unknown as SceneNode);
    return { graph, anim: new AnimationEngine() };
  }

  function videoSourceAt(graph: SceneGraph, anim: AnimationEngine, t: number): number {
    const layer = buildSnapshot(graph, anim, t).layers.find((l) => l.id === VIDEO);
    return layer?.sourceTime ?? t;
  }

  it('runs source time with comp time when there is no remap', () => {
    const { graph, anim } = videoSetup();
    expect(videoSourceAt(graph, anim, 4)).toBeCloseTo(4, 3);
  });

  it('shows a quarter of the footage per second after a ramp to 25%', () => {
    const { graph, anim } = videoSetup();
    anim.setKeyframes(VIDEO, 'timeRemap', buildTimeRemap(
      [{ t: 0, speed: 1 }, { t: 0.5, speed: 0.25 }, { t: 10, speed: 0.25 }], 0,
    ).map((k) => ({
      t: k.t, value: k.value,
      ...(k.bezier ? { easing: 'bezier', bezier: k.bezier } : { easing: 'linear' }),
    })) as never);

    const a = videoSourceAt(graph, anim, 2);
    const b = videoSourceAt(graph, anim, 6);
    expect((b - a) / 4).toBeCloseTo(0.25, 2);
  });

  it('holds one frame when the video is ramped to a freeze', () => {
    const { graph, anim } = videoSetup();
    anim.setKeyframes(VIDEO, 'timeRemap', buildTimeRemap(
      [{ t: 0, speed: 1 }, { t: 0.5, speed: 0 }, { t: 10, speed: 0 }], 0,
    ).map((k) => ({
      t: k.t, value: k.value,
      ...(k.bezier ? { easing: 'bezier', bezier: k.bezier } : { easing: 'linear' }),
    })) as never);
    expect(videoSourceAt(graph, anim, 8)).toBeCloseTo(videoSourceAt(graph, anim, 3), 3);
  });
});
