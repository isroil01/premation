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
function scene(casterZ: number, opts: { lightZ?: number; wallZ?: number } = {}): SceneGraph {
  const g = new SceneGraph();
  g.addNode(node('light', 'light', { x: 400, y: 100, z: opts.lightZ ?? -600, intensity: 100, radius: 2000, castShadows: true }));
  g.addNode(node('wall', 'shape', { x: 400, y: 300, z: opts.wallZ ?? 500, width: 900, height: 900, rotationX: 0, rotationY: 0 }));
  g.addNode(node('caster', 'shape', { x: 400, y: 300, z: casterZ, rotationX: 0, rotationY: 0 }));
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

  it('the shadow is flattened onto the receiver, not re-projected in 3D', () => {
    const sh = shadowOf(scene(0))!;
    expect(sh.matrix).toBeUndefined();
    expect(sh.world3d).toBeUndefined();
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
