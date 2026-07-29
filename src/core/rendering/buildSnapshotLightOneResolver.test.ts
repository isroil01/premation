/**
 * ONE light, ONE resolver.
 *
 * A light is read by three consumers — the visible WASH quad, the per-fragment
 * `sceneLights` used for Accepts-Lights shading, and `shadowLight` for cast
 * shadows. They have disagreed twice:
 *
 *   1. the wash went through `worldTransformOf` (parent-aware) while the shading
 *      and the shadow light read the raw LOCAL props, so parenting a light to a
 *      null flew the glow across the frame and left every lit surface frozen —
 *      the lighting array came back BYTE-IDENTICAL;
 *   2. after that was fixed at two of the three sites, the wash still took the
 *      2D world affine for x/y plus the RAW LOCAL z. So a light under a 3D null
 *      dollying in depth glowed from one place and lit from another, and the
 *      wash ignored the parent's z entirely.
 *
 * These pin all three onto the same 4×4 parent-aware path. The un-parented case
 * must stay bit-identical, or every existing project shifts on next render.
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

const three = (p: Record<string, unknown> = {}) => ({ z: 0, rotationX: 0, rotationY: 0, ...p });

const snap = (g: SceneGraph) =>
  buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    width: W, height: H, background: '#000', rootId: 'root',
  } as never);

/**
 * A point light under a null, plus a lit box. `nullZ` exercises the half the
 * previous fix missed: a parent moving in DEPTH.
 */
function rig(nullX: number, nullZ = 0) {
  const g = new SceneGraph();
  g.addNode(node('root', 'group', null, {}));
  g.addChild('root', node('nul', 'null', 'root', { x: nullX, y: 0, ...three({ z: nullZ }) }));
  g.addChild('nul', node('lamp', 'light', 'nul', {
    x: 100, y: 300, z: -200, intensity: 100, radius: 900, lightType: 'point',
  }));
  g.addChild('root', node('box', 'shape', 'root', {
    x: 400, y: 300, width: 200, height: 200, acceptsLights: true, ...three(),
  }));
  const s = snap(g);
  const wash = s.layers.find((l) => l.id === 'lamp')!;
  return { washX: wash.x, washY: wash.y, lighting: s.layers.find((l) => l.id === 'box')!.lighting };
}

describe('the wash and the shading resolve the light identically', () => {
  it('a parent offset in X moves both', () => {
    const at0 = rig(0);
    const at900 = rig(900);
    expect(at900.washX).not.toBeCloseTo(at0.washX, 1);
    expect(at0.lighting).toBeDefined();
    // The original bug's signature: the lighting array came back unchanged
    // while the wash flew across the frame.
    expect(at900.lighting).not.toEqual(at0.lighting);
  });

  it('a parent offset in DEPTH moves both — the half the earlier fix missed', () => {
    // The wash used to take the 2D affine for x/y plus the light's RAW LOCAL z,
    // so a null dollying in depth changed the shading and left the glow alone.
    const flat = rig(0, 0);
    const deep = rig(0, 600);
    expect(deep.lighting).not.toEqual(flat.lighting);
    // The wash is projected, so moving the light in z changes where it lands.
    expect(deep.washX !== flat.washX || deep.washY !== flat.washY).toBe(true);
  });

  it('an un-offset parent stays bit-identical to no parent at all', () => {
    // The regression guard: composing an identity parent must change nothing,
    // or every existing project shifts the first time it re-renders.
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('lamp', 'light', 'root', {
      x: 100, y: 300, z: -200, intensity: 100, radius: 900, lightType: 'point',
    }));
    g.addChild('root', node('box', 'shape', 'root', {
      x: 400, y: 300, width: 200, height: 200, acceptsLights: true, ...three(),
    }));
    const s = snap(g);
    const unparentedWash = s.layers.find((l) => l.id === 'lamp')!;
    const unparentedLighting = s.layers.find((l) => l.id === 'box')!.lighting;

    const parented = rig(0, 0);
    expect(parented.lighting).toEqual(unparentedLighting);
    expect(parented.washX).toBeCloseTo(unparentedWash.x, 6);
    expect(parented.washY).toBeCloseTo(unparentedWash.y, 6);
  });

  it('an AMBIENT light is exempt — it has no position to move', () => {
    // Ambient lifts the whole frame uniformly; projecting it would slide a
    // whole-frame wash off the frame.
    const ambient = (nullX: number) => {
      const g = new SceneGraph();
      g.addNode(node('root', 'group', null, {}));
      g.addChild('root', node('nul', 'null', 'root', { x: nullX, y: 0, ...three() }));
      g.addChild('nul', node('lamp', 'light', 'nul', {
        x: 100, y: 300, intensity: 100, radius: 900, lightType: 'ambient',
      }));
      return snap(g).layers.find((l) => l.id === 'lamp')!;
    };
    const a = ambient(0);
    const b = ambient(900);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });
});
