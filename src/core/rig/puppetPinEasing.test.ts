/**
 * Does easing on a puppet pin's POSITION track actually reach the deformed mesh?
 *
 * `puppet.<pinId>.position` is a data track (`points` kind), and the known
 * failure mode is that data tracks interpolate strictly linearly — which would
 * make every puppet animation mechanical no matter how good the solver is.
 * These tests check the whole chain end to end: DataKeyframe easing → sampled
 * pin position → ARAP solve → the vertices buildSnapshot hands the renderer.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const comp = { width: 800, height: 600, background: '#101014' };

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, rotation: 0, width: 160, height: 120 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

/** A rig whose pin travels 0 → 60 in x between t=0 and t=2. */
function scene(easing?: string, bezier?: unknown) {
  const graph = new SceneGraph();
  graph.addNode(shapeNode('m'));
  graph.setPuppet('m', {
    meshDensity: 10,
    meshExpansion: 4,
    pins: [
      { id: 'anchor', name: 'anchor', x: -60, y: 0 },
      { id: 'mover', name: 'mover', x: 0, y: 0 },
    ],
  });
  const anim = new AnimationEngine();
  anim.setDataTrack('m', 'puppet.mover.position', {
    nodeId: 'm',
    prop: 'puppet.mover.position',
    kind: 'points',
    keyframes: [
      { t: 0, value: [{ x: 0, y: 0 }], ...(easing ? { easing } : {}), ...(bezier ? { bezier } : {}) },
      { t: 2, value: [{ x: 60, y: 0 }] },
    ],
  } as never);
  return { graph, anim };
}

/** The mover pin's sampled x at time t, read straight off the track. */
function pinXAt(anim: AnimationEngine, t: number): number {
  const v = anim.sampleData('m', 'puppet.mover.position', t) as Array<{ x: number }>;
  return v[0]!.x;
}

function meshAt(graph: SceneGraph, anim: AnimationEngine, t: number): Float32Array {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 'm');
  expect(layer?.deformedMesh).toBeDefined();
  return layer!.deformedMesh!.vertices;
}

describe('puppet pin position easing', () => {
  it('linear (default) reaches the halfway value at the halfway time', () => {
    const { anim } = scene();
    expect(pinXAt(anim, 1)).toBeCloseTo(30, 5);
  });

  it('ease-in makes the midpoint LAG the linear midpoint', () => {
    const linear = scene();
    const eased = scene('easeIn');
    const lin = pinXAt(linear.anim, 1);
    const ei = pinXAt(eased.anim, 1);
    expect(ei).toBeLessThan(lin - 1);
    // Endpoints must still land exactly.
    expect(pinXAt(eased.anim, 0)).toBeCloseTo(0, 5);
    expect(pinXAt(eased.anim, 2)).toBeCloseTo(60, 5);
  });

  it('ease-out makes the midpoint LEAD the linear midpoint', () => {
    const eased = scene('easeOut');
    expect(pinXAt(eased.anim, 1)).toBeGreaterThan(pinXAt(scene().anim, 1) + 1);
  });

  it('hold freezes the pin until the next keyframe', () => {
    const held = scene('hold');
    expect(pinXAt(held.anim, 0.5)).toBeCloseTo(0, 5);
    expect(pinXAt(held.anim, 1.99)).toBeCloseTo(0, 5);
    expect(pinXAt(held.anim, 2)).toBeCloseTo(60, 5);
  });

  it('a custom bezier curve is honoured', () => {
    // BezierHandles is a TUPLE [x1, y1, x2, y2] (CSS cubic-bezier order).
    const slowStart = scene('bezier', [0.9, 0.0, 1.0, 0.2]);
    expect(pinXAt(slowStart.anim, 1)).toBeLessThan(pinXAt(scene().anim, 1) - 5);
  });

  it('the easing actually changes the DEFORMED MESH, not just the sampled value', () => {
    const linear = scene();
    const eased = scene('easeIn');
    const vLin = meshAt(linear.graph, linear.anim, 1);
    const vEase = meshAt(eased.graph, eased.anim, 1);

    expect(vLin.length).toBe(vEase.length);
    let maxDelta = 0;
    for (let i = 0; i < vLin.length; i += 4) {
      maxDelta = Math.max(maxDelta, Math.abs(vLin[i]! - vEase[i]!));
    }
    // If easing stopped at the sampler and never reached the solver, this is 0.
    expect(maxDelta).toBeGreaterThan(1);
  });

  it('endpoints still match between eased and linear (no drift at the keys)', () => {
    const linear = scene();
    const eased = scene('easeInOut');
    for (const t of [0, 2]) {
      const a = meshAt(linear.graph, linear.anim, t);
      const b = meshAt(eased.graph, eased.anim, t);
      for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i]!, 4);
    }
  });
});
