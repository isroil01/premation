/**
 * The boundary test for frame blending: scene graph -> RenderLayer.
 *
 * `frameBlend` lived in the model and the Time Controls dropdown for years as a
 * documented no-op — `layerTime.ts` even says "applied to real frames once the
 * asset pipeline exists". Nothing read it, so nothing could fail. This suite is
 * the read: if the flag stops reaching the renderer, it fails here.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import type { FrameBlend } from '@core/scene/layerTime';

function mediaNode(id: string, kind: 'video' | 'shape', frameBlend: FrameBlend, stretch = 200): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0 } },
      { id: `${id}_m`, type: 'Media', props: { src: 'clip.mp4', opacity: 100 } },
      { id: `${id}_fx`, type: 'fx', props: { time: { stretch, reverse: false, freeze: false, freezeTime: 0, frameBlend } } },
    ],
  } as unknown as SceneNode;
}

const layerAt = (node: SceneNode, t: number) => {
  const graph = new SceneGraph();
  graph.addNode(node);
  const anim = new AnimationEngine();
  // A remap track gives the layer a fractional source time to bracket.
  anim.setKeyframe(node.id, 'timeRemap', 0, 0);
  anim.setKeyframe(node.id, 'timeRemap', 10, 10);
  return buildSnapshot(graph, anim, t).layers.find((l) => l.id === node.id);
};

describe('frame blending reaches the renderer', () => {
  it('emits bracket times and a weight when the layer asks for Frame Mix', () => {
    const l = layerAt(mediaNode('v1', 'video', 'mix'), 0.5);
    expect(l!.frameBlend).toBeDefined();
    expect(l!.frameBlend!.b).toBeGreaterThan(l!.frameBlend!.a);
    expect(l!.frameBlend!.weight).toBeGreaterThan(0);
    expect(l!.frameBlend!.weight).toBeLessThan(1);
  });

  it('emits nothing when frame blending is off', () => {
    expect(layerAt(mediaNode('v2', 'video', 'none'), 0.5)!.frameBlend).toBeUndefined();
  });

  it('does not blend a shape layer', () => {
    // A shape has no frames to mix — its motion is continuous keyframes, so
    // blending would be meaningless rather than merely invisible.
    expect(layerAt(mediaNode('v3', 'shape', 'mix'), 0.5)!.frameBlend).toBeUndefined();
  });

  it('brackets around the layer\'s REMAPPED source time, not comp time', () => {
    // 200% stretch: at comp t=2 the source is at 1. If we bracketed comp time
    // the blend would target the wrong frames entirely — which is the whole
    // reason the feature exists (it only matters on retimed footage).
    const l = layerAt(mediaNode('v4', 'video', 'mix', 200), 2.05);
    expect(l!.frameBlend!.a).toBeGreaterThanOrEqual(0.9);
    expect(l!.frameBlend!.a).toBeLessThanOrEqual(1.1);
  });

  it('emits nothing exactly on a frame boundary', () => {
    // Whole comp frames at 100% land exactly on source frames: nothing to
    // blend toward, so the cheap single-frame draw must stay.
    const l = layerAt(mediaNode('v5', 'video', 'mix', 100), 1);
    expect(l!.frameBlend).toBeUndefined();
  });
});
