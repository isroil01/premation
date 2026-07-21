/**
 * Live-vs-export vertex parity: the same document at the same time must produce
 * bit-identical puppet mesh vertices no matter how many times the snapshot is
 * built (the live viewport and the exporter both call buildSnapshot — any
 * nondeterminism here would make exports differ from the preview).
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
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, rotation: 0, width: 120, height: 90 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function riggedScene(): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addNode(shapeNode('m'));
  graph.setPuppet('m', {
    meshDensity: 12,
    meshExpansion: 6,
    pins: [
      { id: 'pinA', name: 'A', x: -40, y: 0, stiffness: 0.5 },
      { id: 'pinB', name: 'B', x: 40, y: 0 },
    ],
  });

  const anim = new AnimationEngine();
  // Animated pin position (data track, 'points' kind).
  anim.setDataTrack('m', 'puppet.pinA.position', {
    nodeId: 'm',
    prop: 'puppet.pinA.position',
    kind: 'points',
    keyframes: [
      { t: 0, value: [{ x: -40, y: 0 }] },
      { t: 2, value: [{ x: -20, y: 25 }] },
    ],
  });
  // Animated pin rotation + stiffness (scalar tracks).
  anim.setKeyframe('m', 'puppet.pinB.rotation', 0, 0);
  anim.setKeyframe('m', 'puppet.pinB.rotation', 2, 45);
  anim.setKeyframe('m', 'puppet.pinA.stiffness', 0, 0);
  anim.setKeyframe('m', 'puppet.pinA.stiffness', 2, 2);
  return { graph, anim };
}

function meshAt(graph: SceneGraph, anim: AnimationEngine, t: number): Float32Array {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 'm');
  expect(layer).toBeDefined();
  expect(layer!.deformedMesh).toBeDefined();
  return layer!.deformedMesh!.vertices;
}

describe('Puppet snapshot parity (live vs export determinism)', () => {
  it('two snapshot builds at the same time yield bit-identical mesh vertices', () => {
    const { graph, anim } = riggedScene();
    for (const t of [0, 0.7333, 1.5, 2]) {
      const v1 = meshAt(graph, anim, t);
      const v2 = meshAt(graph, anim, t);
      expect(v1.length).toBe(v2.length);
      expect(v1.length).toBeGreaterThan(0);
      for (let i = 0; i < v1.length; i++) {
        expect(Object.is(v1[i], v2[i])).toBe(true);
      }
    }
  });

  it('a fresh graph/engine with the same document reproduces the same vertices', () => {
    const a = riggedScene();
    const b = riggedScene();
    const t = 1.25;
    const v1 = meshAt(a.graph, a.anim, t);
    const v2 = meshAt(b.graph, b.anim, t);
    expect(v1.length).toBe(v2.length);
    for (let i = 0; i < v1.length; i++) {
      expect(Object.is(v1[i], v2[i])).toBe(true);
    }
  });

  it('animated rotation/stiffness actually change the mesh over time', () => {
    const { graph, anim } = riggedScene();
    const v0 = meshAt(graph, anim, 0);
    const v2 = meshAt(graph, anim, 2);
    expect(v0.length).toBe(v2.length);
    let differs = false;
    for (let i = 0; i < v0.length; i++) {
      if (v0[i] !== v2[i]) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });
});
