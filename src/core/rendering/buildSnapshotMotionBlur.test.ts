/**
 * Motion blur — sub-frame samples.
 *
 * The gap these cover: the backend PREFERS a layer's baked `matrix` over its
 * decomposed x/y/rotation/scale. Samples carried only the decomposed values, so
 * on a 3D layer every sample drew through the same matrix — N identical draws
 * at reduced opacity. Blur was a no-op on exactly the layers that move most,
 * and no test noticed because none inspected the samples of a 3D layer.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { MotionBlurConfig } from '@core/effects/motionBlur';

const COMP = { width: 800, height: 600, background: '#101014' };
const BLUR: MotionBlurConfig = {
  enabled: true,
  fps: 30,
  shutterAngle: 180,
  shutterPhase: -90,
  samples: 8,
  adaptiveSampleLimit: 128,
};

function node(id: string, opts: { threeD?: boolean; motionBlur?: boolean } = {}): SceneNode {
  const props: Record<string, unknown> = { [SCENE_KIND_PROP]: 'shape', x: 100, y: 300, rotation: 0, width: 50, height: 50 };
  if (opts.threeD) props.z = 0;
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      ...(opts.motionBlur !== false ? [{ id: `${id}_fx`, type: 'fx', props: { motionBlur: true } }] : []),
    ],
  } as unknown as SceneNode;
}

/** A layer travelling fast in x, so the shutter interval spans real distance. */
function movingLayer(opts: { threeD?: boolean } = {}) {
  const graph = new SceneGraph();
  graph.addNode(node('mover', { threeD: opts.threeD }));
  const anim = new AnimationEngine();
  anim.setKeyframe('mover', 'x', 0, 100);
  anim.setKeyframe('mover', 'x', 2, 700);
  if (opts.threeD) {
    // A z track is what marks the layer 3D for is3DEnabled.
    anim.setKeyframe('mover', 'z', 0, 0);
    anim.setKeyframe('mover', 'z', 2, 0);
  }
  return buildSnapshot(graph, anim, 1, undefined, undefined, undefined, BLUR, COMP).layers[0]!;
}

describe('motion blur samples', () => {
  it('emits multiple samples for a moving, opted-in layer', () => {
    const l = movingLayer();
    expect(l.motionSamples?.length).toBe(BLUR.samples);
  });

  it('spreads the samples across the shutter interval', () => {
    const xs = movingLayer().motionSamples!.map((s) => s.x);
    expect(new Set(xs).size).toBeGreaterThan(1);
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs));
  });

  it('gives a 3D layer a DISTINCT matrix per sample', () => {
    const samples = movingLayer({ threeD: true }).motionSamples;
    expect(samples).toBeDefined();
    expect(samples!.every((s) => s.matrix !== undefined)).toBe(true);

    // The regression: identical matrices ⇒ N identical draws ⇒ no blur at all.
    const tx = samples!.map((s) => s.matrix![4]);
    expect(new Set(tx).size).toBe(samples!.length);
    expect(Math.max(...tx)).toBeGreaterThan(Math.min(...tx));
  });

  it("each 3D sample's matrix tracks that sample's own position", () => {
    const samples = movingLayer({ threeD: true }).motionSamples!;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    // Sample x increases across the shutter, so the matrix translation must too.
    expect(last.x).toBeGreaterThan(first.x);
    expect(last.matrix![4]).toBeGreaterThan(first.matrix![4]);
  });

  it('omits per-sample matrices for 2D layers (they use x/y directly)', () => {
    const samples = movingLayer().motionSamples!;
    expect(samples.every((s) => s.matrix === undefined)).toBe(true);
  });

  it('emits no samples for a static layer', () => {
    const graph = new SceneGraph();
    graph.addNode(node('still'));
    const l = buildSnapshot(graph, new AnimationEngine(), 1, undefined, undefined, undefined, BLUR, COMP).layers[0]!;
    expect(l.motionSamples).toBeUndefined();
  });

  it('emits no samples when the layer has not opted in', () => {
    const graph = new SceneGraph();
    graph.addNode(node('mover', { motionBlur: false }));
    const anim = new AnimationEngine();
    anim.setKeyframe('mover', 'x', 0, 100);
    anim.setKeyframe('mover', 'x', 2, 700);
    const l = buildSnapshot(graph, anim, 1, undefined, undefined, undefined, BLUR, COMP).layers[0]!;
    expect(l.motionSamples).toBeUndefined();
  });

  it('emits no samples when comp motion blur is off', () => {
    const graph = new SceneGraph();
    graph.addNode(node('mover'));
    const anim = new AnimationEngine();
    anim.setKeyframe('mover', 'x', 0, 100);
    anim.setKeyframe('mover', 'x', 2, 700);
    const l = buildSnapshot(
      graph, anim, 1, undefined, undefined, undefined, { ...BLUR, enabled: false }, COMP,
    ).layers[0]!;
    expect(l.motionSamples).toBeUndefined();
  });
});
