/**
 * Camera and light PARENTING — the null-object rig.
 *
 * A camera parented to a null is the standard After Effects camera rig: you
 * animate or orbit the null and the shot follows. Three separate readers used to
 * disagree about where a camera or light actually was:
 *
 *   • `cameraFromNode` read the camera's raw LOCAL props, so the rig moved
 *     nothing — the UI offered the parent link and the render ignored it;
 *   • the light WASH resolved through `worldTransformOf` (parent-aware) while
 *     the Lambert shading and the cast-shadow light read the raw local props, so
 *     dragging a light's parent moved the glow across the frame while the
 *     shading on every lit layer stayed frozen.
 *
 * These pin all of them to ONE resolution, because "the light moved but the
 * shading didn't" is invisible in code review and obvious on screen.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const W = 800;
const H = 600;

function node(
  id: string,
  kind: string,
  parent: string | null,
  props: Record<string, unknown>,
): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...props } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

const snap = (g: SceneGraph) =>
  buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    width: W, height: H, background: '#000', rootId: 'root',
  } as never);

describe('a camera parented to a null follows it', () => {
  /**
   * Camera under a null at `nullX`. Two boxes: `box` sits still in comp space,
   * `rider` is parented to the SAME null so it holds its place in the rig.
   */
  function rig(nullX: number, opts: { twoNode?: boolean } = {}) {
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('nul', 'null', 'root', { x: nullX, y: 0 }));
    g.addChild('nul', node('cam', 'camera', 'nul', {
      x: W / 2, y: H / 2, z: -1000, focalLength: 1000,
      ...(opts.twoNode ? { poiX: W / 2, poiY: H / 2, poiZ: 0 } : {}),
    }));
    g.addChild('root', node('box', 'shape', 'root', {
      x: W / 2, y: H / 2, z: 0, rotationX: 0, rotationY: 0, width: 100, height: 100,
    }));
    g.addChild('nul', node('rider', 'shape', 'nul', {
      x: W / 2, y: H / 2, z: 0, rotationX: 0, rotationY: 0, width: 100, height: 100,
    }));
    const ls = snap(g).layers;
    return { box: ls.find((l) => l.id === 'box')!, rider: ls.find((l) => l.id === 'rider')! };
  }

  it('leaves the shot unchanged when the null sits at the origin', () => {
    // The regression guard: an un-offset parent must compose to the identity, or
    // every existing project shifts the first time it re-renders.
    expect(rig(0).box.x).toBeCloseTo(W / 2, 6);
  });

  it('swings the framing when the null moves', () => {
    // Null at +3000 puts the eye at x = 3400 while `box` stays at 400, so it
    // projects 3000 px to the LEFT of the principal point. Before the fix the
    // camera ignored the null entirely and this stayed at 400.
    expect(rig(3000).box.x).toBeCloseTo(W / 2 - 3000, 6);
  });

  it('carries a two-node camera POINT OF INTEREST through the rig', () => {
    // The eye and its target ride the same parent, so a subject that holds its
    // place in the rig stays framed however far the null travels.
    //
    // This discriminates sharply: lift the eye but NOT the POI and the camera
    // ends up at x = 3400 squinting back at a target abandoned at x = 400 — a
    // yaw of about −71°, which throws `rider` out to x = 3400 instead of 400.
    expect(rig(3000, { twoNode: true }).rider.x).toBeCloseTo(W / 2, 6);
  });
});

describe('a light parented to a null moves its wash AND its shading together', () => {
  function rig(nullX: number) {
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('nul', 'null', 'root', { x: nullX, y: 0 }));
    g.addChild('nul', node('lamp', 'light', 'nul', {
      x: 100, y: 300, z: -200, intensity: 100, radius: 900, lightType: 'point',
    }));
    g.addChild('root', node('box', 'shape', 'root', {
      x: 400, y: 300, z: 0, rotationX: 0, rotationY: 0, width: 200, height: 200,
      acceptsLights: true,
    }));
    const s = snap(g);
    return {
      wash: s.layers.find((l) => l.id === 'lamp')!.x,
      lighting: s.layers.find((l) => l.id === 'box')!.lighting,
    };
  }

  it('moves both, not just the wash', () => {
    const at0 = rig(0);
    const at900 = rig(900);
    expect(at900.wash).not.toBeCloseTo(at0.wash, 1);
    // The bug: these two used to be byte-identical while the wash flew across
    // the frame, because the shading read the light's raw LOCAL x.
    expect(at0.lighting).toBeDefined();
    expect(at900.lighting).not.toEqual(at0.lighting);
  });

  it('leaves an un-offset parent bit-identical', () => {
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('lamp', 'light', 'root', {
      x: 100, y: 300, z: -200, intensity: 100, radius: 900, lightType: 'point',
    }));
    g.addChild('root', node('box', 'shape', 'root', {
      x: 400, y: 300, z: 0, rotationX: 0, rotationY: 0, width: 200, height: 200,
      acceptsLights: true,
    }));
    const unparented = snap(g).layers.find((l) => l.id === 'box')!.lighting;
    expect(rig(0).lighting).toEqual(unparented);
  });
});
