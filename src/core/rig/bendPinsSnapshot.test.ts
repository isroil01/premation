/**
 * Bend pins across the seam: scene → `resolveLivePins` → `deform` → snapshot.
 *
 * `bendPins.test.ts` covers the solve and `livePins.test.ts` covers the
 * sampling, and between them every unit is green — which is precisely the state
 * rule 4c warns about. `kind` has to survive a hand-written object literal in
 * `buildSnapshot` to get from the stored rig into the solver, and neither of
 * those suites observes that hop. Before the extraction there were TWO such
 * literals, in files that never import each other; either could have been left
 * behind with a clean `tsc` and a full green suite.
 *
 * So this asserts the crossing itself: a bend pin authored on a node changes the
 * vertices that come out of `buildSnapshot`, and changes them the way a bend pin
 * should rather than the way an advanced pin would.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { PuppetRig, PinKind } from './puppet';

const comp = { width: 800, height: 600, background: '#101014' };

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, rotation: 0, width: 120, height: 90 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

/** Two drivers plus a middle pin of the given kind, with the middle pin turned. */
function scene(kind: PinKind, middleRotation: number): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addNode(shapeNode('m'));
  const rig: PuppetRig = {
    meshDensity: 12,
    meshExpansion: 6,
    solver: 'lbs',
    pins: [
      { id: 'L', name: 'L', x: -40, y: 0 },
      { id: 'R', name: 'R', x: 40, y: 0 },
      { id: 'M', name: 'M', x: 0, y: 0, kind, rotation: middleRotation },
    ],
  };
  graph.setPuppet('m', rig);

  const anim = new AnimationEngine();
  // A driver in motion, so "the centre travels" has something to travel with.
  anim.setDataTrack('m', 'puppet.L.position', {
    nodeId: 'm', prop: 'puppet.L.position', kind: 'points',
    keyframes: [
      { t: 0, value: [{ x: -40, y: 0 }] },
      { t: 2, value: [{ x: -40, y: -30 }] },
    ],
  });
  return { graph, anim };
}

function meshAt(graph: SceneGraph, anim: AnimationEngine, t: number): Float32Array {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 'm');
  expect(layer).toBeDefined();
  expect(layer!.deformedMesh).toBeDefined();
  return layer!.deformedMesh!.vertices;
}

function differs(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

describe('a bend pin reaches the renderer', () => {
  it("the stored kind changes the render — 'bend' and 'advanced' do not agree", () => {
    // The seam guard. Drop `kind` anywhere between the rig and `deform` and both
    // sides solve as advanced pins, these two arrays become identical, and this
    // is the only test in the repo that notices.
    const bend = scene('bend', 30);
    const advanced = scene('advanced', 30);
    const t = 2;
    expect(differs(meshAt(bend.graph, bend.anim, t), meshAt(advanced.graph, advanced.anim, t))).toBe(true);
  });

  it('a bend pin at rest still renders — it does not blank or collapse the mesh', () => {
    const { graph, anim } = scene('bend', 0);
    const v = meshAt(graph, anim, 2);
    expect(v.length).toBeGreaterThan(0);
    for (let i = 0; i < v.length; i++) expect(Number.isFinite(v[i])).toBe(true);
  });

  it('its rotation is what moves the mesh — turning it changes the render', () => {
    const idle = scene('bend', 0);
    const turned = scene('bend', 40);
    expect(differs(meshAt(idle.graph, idle.anim, 2), meshAt(turned.graph, turned.anim, 2))).toBe(true);
  });

  it('stays deterministic across builds, so preview and export agree', () => {
    const { graph, anim } = scene('bend', 40);
    const a = meshAt(graph, anim, 2);
    const b = meshAt(graph, anim, 2);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i])).toBe(true);
  });
});
