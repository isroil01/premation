/**
 * Which camera a composition renders through.
 *
 * Both rules pinned here were wrong, and both failed silently — the camera
 * layer really was animating, every call was valid, and the render was simply
 * unaffected:
 *
 *  1. The search walked the WHOLE project, so a camera in one composition
 *     steered another composition's render.
 *  2. It took the FIRST camera found. Creation order is paint order and paint
 *     order is back-to-front, so that is the bottom-most camera — the opposite
 *     of After Effects, where the topmost camera wins.
 *
 * Together they broke repeat AI runs: nothing deletes layers between runs, so
 * run 2's camera was created after run 1's and lost. Every generative prompt
 * after the first produced a fully keyframed camera nothing ever read.
 */

import { activeCameraNode, readSceneCamera } from './camera3d';
import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import type { SceneNode } from '@core/types';

function addComp(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addCamera(id: string, parent: string, focalLength: number): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { x: 0, y: 0, focalLength } },
      { id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'camera' } },
    ],
  } as unknown as SceneNode);
}

describe('the active camera', () => {
  beforeEach(() => {
    for (const root of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(root.id);
  });

  it('takes the LAST camera in a composition, not the first', () => {
    // The AI-run case: a second prompt appends a second camera. The newer one
    // is on top and must win, or every run after the first is inert.
    addComp('compA');
    addCamera('cam_old', 'compA', 1000);
    addCamera('cam_new', 'compA', 4000);

    expect(activeCameraNode(defaultSceneGraph, 'compA')?.id).toBe('cam_new');
    expect(readSceneCamera(defaultSceneGraph, 1920, 1080, undefined, 'compA').focalLength).toBe(4000);
  });

  it('ignores a camera belonging to a different composition', () => {
    addComp('compA');
    addComp('compB');
    addCamera('camB', 'compB', 4000);

    // compA has no camera of its own, so it must fall back to the default —
    // NOT borrow compB's.
    const a = readSceneCamera(defaultSceneGraph, 1920, 1080, undefined, 'compA');
    expect(activeCameraNode(defaultSceneGraph, 'compA')).toBeNull();
    expect(a.focalLength).not.toBe(4000);

    expect(activeCameraNode(defaultSceneGraph, 'compB')?.id).toBe('camB');
  });

  it('falls back to the default camera when the composition has none', () => {
    addComp('compA');
    const cam = readSceneCamera(defaultSceneGraph, 1920, 1080, undefined, 'compA');
    expect(cam.focalLength).toBeGreaterThan(0);
    expect(cam.position).toBeDefined();
  });

  it('still searches the whole scene when no composition is given', () => {
    // The axis widget and scene-ref geometry have no comp context; they keep the
    // behaviour they had rather than silently losing the camera.
    addComp('compA');
    addCamera('camA', 'compA', 2500);
    expect(activeCameraNode(defaultSceneGraph)?.id).toBe('camA');
    expect(readSceneCamera(defaultSceneGraph, 1920, 1080).focalLength).toBe(2500);
  });

  it('lets a keyframed focal length beat the static prop', () => {
    addComp('compA');
    addCamera('camA', 'compA', 2500);
    const sampled = readSceneCamera(
      defaultSceneGraph, 1920, 1080,
      (id, prop) => (id === 'camA' && prop === 'focalLength' ? 900 : undefined),
      'compA',
    );
    expect(sampled.focalLength).toBe(900);
  });
});
