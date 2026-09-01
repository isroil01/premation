/**
 * Camera motion blur — the gap: `moves()` inspects only a layer's OWN animated
 * props and the frame's `project` closure is built from the camera at `t`, so a
 * static 3D layer under a fully keyframed camera rendered perfectly sharp. An
 * animated active camera must (a) extend the motion gate to every 3D layer and
 * (b) give each sub-frame sample the camera's pose at that sample's comp time.
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

function shape3d(id: string, opts: { motionBlur?: boolean } = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    // Off the comp centre on purpose: the orbit test pivots the camera about
    // the comp centre, and a card AT the pivot projects to the same place from
    // every yaw. `z: 0` in the Transform props is what marks the layer 3D
    // (is3DEnabled) — no keyframes, so `moves()` stays false and only the
    // camera gate can admit it to the blur path.
    transform: { position: { x: 600, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 600, y: 300, rotation: 0, width: 50, height: 50, z: 0 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      { id: `${id}_fx`, type: 'fx', props: { motionBlur: opts.motionBlur !== false } },
    ],
  } as unknown as SceneNode;
}

function cameraNode(id = 'cam'): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'camera', x: 400, y: 300, focalLength: 889 } },
    ],
  } as unknown as SceneNode;
}

/** Static 3D card; camera keyframed (or not) on `prop`. */
function scene(cameraTrack?: { prop: string; from: number; to: number }) {
  const graph = new SceneGraph();
  graph.addNode(shape3d('card'));
  graph.addNode(cameraNode());
  const anim = new AnimationEngine();
  if (cameraTrack) {
    anim.setKeyframe('cam', cameraTrack.prop, 0, cameraTrack.from);
    anim.setKeyframe('cam', cameraTrack.prop, 2, cameraTrack.to);
  }
  const snap = buildSnapshot(graph, anim, 1, undefined, undefined, undefined, BLUR, COMP);
  return snap.layers.find((l) => l.id === 'card')!;
}

describe('camera motion blur', () => {
  it('a static 3D layer under a keyframed camera pan gets motion samples', () => {
    const l = scene({ prop: 'x', from: 100, to: 1500 });
    expect(l.motionSamples).toBeDefined();
    expect(l.motionSamples!.length).toBeGreaterThan(1);
    // Each sample projects through the camera pose at ITS comp time, so the
    // projected origins must actually spread — N identical matrices would be
    // the old no-op blur.
    const tx = l.motionSamples!.map((s) => s.matrix![4]);
    expect(Math.max(...tx)).toBeGreaterThan(Math.min(...tx) + 1);
  });

  it('an orbit (orbitYaw) blurs too — the camera prop list is not just x/y/z', () => {
    // Fast orbit: ±180° over 2s is 3° of yaw across a 180° shutter at 30fps —
    // enough projected travel to assert a real spread, not sub-pixel noise.
    const l = scene({ prop: 'orbitYaw', from: -180, to: 180 });
    expect(l.motionSamples).toBeDefined();
    const tx = l.motionSamples!.map((s) => s.matrix![4]);
    expect(Math.max(...tx)).toBeGreaterThan(Math.min(...tx) + 1);
  });

  it('a static camera adds no samples to a static layer', () => {
    const l = scene(undefined);
    expect(l.motionSamples).toBeUndefined();
  });

  it('respects the per-layer motion blur switch', () => {
    const graph = new SceneGraph();
    graph.addNode(shape3d('card', { motionBlur: false }));
    graph.addNode(cameraNode());
    const anim = new AnimationEngine();
    anim.setKeyframe('cam', 'x', 0, 100);
    anim.setKeyframe('cam', 'x', 2, 1500);
    const snap = buildSnapshot(graph, anim, 1, undefined, undefined, undefined, BLUR, COMP);
    const l = snap.layers.find((c) => c.id === 'card')!;
    expect(l.motionSamples).toBeUndefined();
  });

  it('2D layers stay outside the camera gate', () => {
    const graph = new SceneGraph();
    graph.addNode({
      id: 'flat', name: 'flat', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'flat_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 50, height: 50 } },
        { id: 'flat_fx', type: 'fx', props: { motionBlur: true } },
      ],
    } as unknown as SceneNode);
    graph.addNode(cameraNode());
    const anim = new AnimationEngine();
    anim.setKeyframe('cam', 'x', 0, 100);
    anim.setKeyframe('cam', 'x', 2, 1500);
    const snap = buildSnapshot(graph, anim, 1, undefined, undefined, undefined, BLUR, COMP);
    const l = snap.layers.find((c) => c.id === 'flat')!;
    expect(l.motionSamples).toBeUndefined();
  });
});
