/**
 * Backdrop blur plumbing: layer prop → snapshot → renderable, and the samplable
 * -target precondition.
 *
 * The compositing itself (copy → separable blur → mask by the layer's alpha)
 * needs real pixels and is verified in the browser; what regresses silently is
 * the plumbing — drop any link and glass quietly stops frosting with nothing
 * failing.
 */

import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const COMP = { width: 800, height: 600, background: '#101014' };

function shape(id: string, styleProps: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, width: 200, height: 200 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff', ...styleProps } },
    ],
  } as unknown as SceneNode;
}

function build(graph: SceneGraph, anim = new AnimationEngine()) {
  return buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, COMP as never);
}

describe('backdrop blur', () => {
  it('carries the prop from the layer into the snapshot and the renderable', () => {
    const g = new SceneGraph();
    g.addNode(shape('panel', { backdropBlur: 18 }));
    const snap = build(g);
    expect(snap.layers.find((l) => l.id === 'panel')?.backdropBlur).toBe(18);
    const scene = snapshotToFrameScene(snap);
    expect(scene.renderables.find((r) => r.id === 'panel')?.backdropBlur).toBe(18);
  });

  it('omits it entirely when unset, so ordinary layers take the cheap path', () => {
    const g = new SceneGraph();
    g.addNode(shape('plain'));
    const scene = snapshotToFrameScene(build(g));
    expect(scene.renderables.find((r) => r.id === 'plain')?.backdropBlur).toBeUndefined();
  });

  // The branch samples the target it is drawing into, so it needs the offscreen
  // scene-colour target. Straight to the surface there is nothing to sample and
  // the layer silently would not frost.
  it('forces a samplable scene target (hasEffects)', () => {
    const plain = new SceneGraph();
    plain.addNode(shape('plain'));
    expect(snapshotToFrameScene(build(plain)).hasEffects).toBe(false);

    const glass = new SceneGraph();
    glass.addNode(shape('panel', { backdropBlur: 12 }));
    expect(snapshotToFrameScene(build(glass)).hasEffects).toBe(true);
  });

  it('is keyframeable — an animated track beats the static prop', () => {
    const g = new SceneGraph();
    g.addNode(shape('panel', { backdropBlur: 4 }));
    const anim = new AnimationEngine();
    anim.setKeyframe('panel', 'backdropBlur', 0, 0);
    anim.setKeyframe('panel', 'backdropBlur', 2, 40);
    const at1 = buildSnapshot(g, anim, 1, undefined, undefined, undefined, undefined, COMP as never);
    expect(at1.layers.find((l) => l.id === 'panel')?.backdropBlur).toBeCloseTo(20, 5);
  });
});
