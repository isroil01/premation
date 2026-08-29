/**
 * Projected cast shadows.
 *
 * A caster is projected onto the nearest shadow-accepting plane BEHIND it, from
 * the first shadow-casting non-ambient light. The shadow must therefore respond
 * to depth: far from the receiver it is large and offset, and as the caster
 * approaches the receiver it shrinks and converges onto the caster's own
 * position. That depth response is the whole point — the previous implementation
 * was a fixed-offset drop-shadow on the caster that never touched another layer.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import { depthEligible3D } from '@motion/renderer';

const COMP = { width: 800, height: 600, background: '#101014' };

function node(id: string, kind: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: kind, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: 100, height: 100, ...props },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

/** Light in front (−z), receiver wall behind (+z), caster between them. */
function scene(
  casterZ: number,
  opts: { lightZ?: number; wallZ?: number; casterX?: number; casterY?: number } = {},
): SceneGraph {
  const g = new SceneGraph();
  g.addNode(node('light', 'light', { x: 400, y: 100, z: opts.lightZ ?? -600, intensity: 100, radius: 2000, castShadows: true }));
  g.addNode(node('wall', 'shape', { x: 400, y: 300, z: opts.wallZ ?? 500, width: 900, height: 900, rotationX: 0, rotationY: 0 }));
  // Built off-centre where a test asks for it. Mutating the node AFTER
  // `addNode` does not work — the graph keeps its own copy — which is exactly
  // how a placement assertion can pass while measuring the default position.
  g.addNode(node('caster', 'shape', {
    x: opts.casterX ?? 400, y: opts.casterY ?? 300, z: casterZ, rotationX: 0, rotationY: 0,
  }));
  return g;
}

function shadowOf(g: SceneGraph, comp: Record<string, unknown> = {}) {
  const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, { ...COMP, ...comp } as never);
  return s.layers.find((l) => l.id === 'caster::shadow');
}

describe('projected cast shadows', () => {
  it('emits a shadow onto the accepting plane behind the caster', () => {
    const sh = shadowOf(scene(0));
    expect(sh).toBeDefined();
    expect(sh!.fill).toBe('#000000');
    expect(sh!.opacity).toBeGreaterThan(0);
  });

  // Regression: the light's z was read from the ANIMATION map with a `?? 0`
  // fallback, so an unanimated light sat in the comp plane. `denom` collapsed to
  // the caster's own z, and every caster near the front of the scene — z = 0
  // most of all — silently produced NO shadow.
  it('casts from a STATIC (unanimated) light z, not a 0 fallback', () => {
    for (const z of [0, 1, 50, 100, 200]) {
      expect(shadowOf(scene(z))).toBeDefined();
    }
  });

  it('shrinks and converges on the caster as it approaches the receiver', () => {
    const widths: number[] = [];
    const offsets: number[] = [];
    for (const z of [0, 150, 300, 450]) {
      const sh = shadowOf(scene(z));
      expect(sh).toBeDefined();
      widths.push(sh!.width * sh!.scaleX);
      offsets.push(Math.abs(sh!.y - 300)); // distance from the caster's own y
    }
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
      expect(offsets[i]!).toBeLessThan(offsets[i - 1]!);
    }
  });

  it('casts nothing when no plane accepts shadows behind the caster', () => {
    const g = new SceneGraph();
    g.addNode(node('light', 'light', { x: 400, y: 100, z: -600, intensity: 100, radius: 2000, castShadows: true }));
    g.addNode(node('caster', 'shape', { x: 400, y: 300, z: 0, rotationX: 0, rotationY: 0 }));
    expect(shadowOf(g)).toBeUndefined();
  });

  it('casts nothing from a light with shadows switched off', () => {
    const g = scene(0);
    const t = g.getNode('light')!.components.find((c) => c.type === 'Transform')!;
    g.writeProp('light', t.id, 'castShadows', false);
    expect(shadowOf(g)).toBeUndefined();
  });

  it('Draft 3D skips cast shadows entirely', () => {
    expect(shadowOf(scene(0), { draft3d: true })).toBeUndefined();
  });

  /**
   * The shadow is REAL GEOMETRY on the receiver's plane.
   *
   * It used to be a plain 2D quad with no matrix, which cost it two things. A
   * quad with no matrix is not depth-eligible, so nothing could occlude it: it
   * painted at the end of the stack, over the objects standing in front of the
   * wall it had supposedly landed on. And its position was computed by scaling
   * the caster's SCREEN x/y about the light's WORLD x/y — two different spaces
   * subtracted from each other, which only agreed while the projection was
   * identity. Orbit or dolly the camera and every shadow slid off its caster.
   */
  describe('built in world space, on the receiver plane', () => {
    // (wallZ − lightZ) / (casterZ − lightZ) — how far along the light→caster ray
    // the receiver sits.
    const T = (500 - -600) / (0 - -600);

    it('carries a world matrix and a projected affine, like any 3D layer', () => {
      const sh = shadowOf(scene(0))!;
      expect(sh.matrix).toBeDefined();
      expect(sh.world3d).toBeDefined();
    });

    it('sits just in front of the plane it lands on, never coplanar with it', () => {
      // Coplanar quads z-fight on the GPU depth path and sort arbitrarily on the
      // painter path, so the shadow is nudged one unit toward the camera.
      const z = shadowOf(scene(0))!.world3d![14]!;
      expect(z).toBeLessThan(500);
      expect(z).toBeGreaterThan(495);
    });

    it('places the shadow at the light-scaled WORLD position', () => {
      // Caster off-centre so the arithmetic has something to get wrong: the
      // shadow centre is the light→caster ray carried on to the wall.
      const sh = shadowOf(scene(0, { casterX: 200, casterY: 150 }))!;
      expect(sh.world3d![12]).toBeCloseTo(400 + (200 - 400) * T, 4);
      expect(sh.world3d![13]).toBeCloseTo(100 + (150 - 100) * T, 4);
    });

    it('the VIEW cannot move it — only the projection it is drawn through', () => {
      // The same scene through the scene camera and through a Top view. The
      // shadow's world position is a property of the light and the geometry, so
      // it must be identical; only its projected screen position may differ.
      // Under the old screen-space arithmetic the world placement itself moved
      // with the camera, which is precisely the bug.
      const g = scene(0, { casterX: 200, casterY: 150 });
      const active = shadowOf(g)!;
      const top = shadowOf(g, { camera3dMode: 'top' })!;
      expect(top.world3d![12]).toBeCloseTo(active.world3d![12]!, 6);
      expect(top.world3d![13]).toBeCloseTo(active.world3d![13]!, 6);
      expect(top.world3d![14]).toBeCloseTo(active.world3d![14]!, 6);
      // ...and the two really are different views, so this is not a no-op.
      expect(top.y).not.toBeCloseTo(active.y, 1);
    });

    it("is a plain dark silhouette, never the caster's blend mode", () => {
      // Inherited through the spread, a screen-blended caster threw an INVISIBLE
      // shadow (black screened is a no-op) and a multiply-blended one threw a
      // double-dark hole. An advanced blend also cost it depth eligibility.
      const g = scene(0);
      (g.getNode('caster')!.components[0]!.props as Record<string, unknown>).blend = 'screen';
      expect(shadowOf(g)!.blend).toBe('normal');
    });

    /**
     * The payoff. Painter order alone is not occlusion: the GPU groups
     * contiguous runs of depth-eligible renderables into one depth pass, and a
     * renderable with no `threeD` model both falls out of that pass AND splits
     * the run around it. A shadow that is not depth-eligible therefore cannot be
     * occluded by anything, however it is sorted.
     */
    it('reaches the GPU depth pass as a depth-eligible renderable', () => {
      const snap = buildSnapshot(scene(0), new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
      const r = snapshotToFrameScene(snap).renderables.find((x) => x.id === 'caster::shadow');
      expect(r).toBeDefined();
      expect(r!.threeD).toBeDefined();
      expect(depthEligible3D(r!)).toBe(true);
    });

    it('depth-sorts, so a nearer layer paints over it', () => {
      const g = scene(0);
      // A 3D layer standing between the wall and the camera. It must NOT accept
      // shadows, or it becomes the nearest receiver behind the caster and steals
      // the shadow off the wall — correct behaviour, wrong scene for this test.
      g.addNode(node('infront', 'shape', {
        x: 400, y: 300, z: 200, rotationX: 0, rotationY: 0, acceptsShadows: 'off',
      }));
      const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
      const ids = s.layers.map((l) => l.id);
      // Painter order runs back→front, so the shadow (on the far wall) must be
      // emitted BEFORE the layer standing in front of it.
      expect(ids.indexOf('caster::shadow')).toBeLessThan(ids.indexOf('infront'));
    });
  });

  it('projects one shadow per shadow-casting light', () => {
    const g = scene(0);
    g.addNode(node('light2', 'light', {
      x: 100, y: 100, z: -600, intensity: 100, radius: 2000, castShadows: true,
    }));
    const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
    const shadows = s.layers.filter((l) => l.id.startsWith('caster::shadow'));
    expect(shadows).toHaveLength(2);
    expect(shadows.some((l) => l.id === 'caster::shadow')).toBe(true);
    expect(shadows.some((l) => l.id === 'caster::shadow:1')).toBe(true);
  });
});
