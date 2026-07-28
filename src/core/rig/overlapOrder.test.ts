/**
 * Overlap resolve (3E) — painter's ordering of the mesh's own triangles, and
 * the buildSnapshot integration for every Phase 3/4 property.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { buildRestMesh, sortTrianglesByDepth, type PuppetRig } from './puppet';

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

const RIG: PuppetRig = {
  meshDensity: 8,
  meshExpansion: 0,
  pins: [
    { id: 'a', name: 'a', x: -50, y: 0 },
    { id: 'b', name: 'b', x: 50, y: 0 },
  ],
};

function sceneWith(rig: PuppetRig) {
  const graph = new SceneGraph();
  graph.addNode(shapeNode('m'));
  graph.setPuppet('m', rig);
  return { graph, anim: new AnimationEngine() };
}

function meshOf(graph: SceneGraph, anim: AnimationEngine) {
  const snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 'm');
  expect(layer?.deformedMesh).toBeDefined();
  return layer!.deformedMesh!;
}

describe('sortTrianglesByDepth', () => {
  it('orders back-to-front so positive overlap paints last (on top)', () => {
    // 3 triangles over 5 vertices, depths chosen so the authored order is wrong.
    const tris = new Uint16Array([0, 1, 2, 1, 2, 3, 2, 3, 4]);
    const depth = new Float32Array([10, 10, 10, -20, -20]);
    const out = sortTrianglesByDepth(tris, depth);
    const avg = (t: number) =>
      (depth[out[t * 3]!]! + depth[out[t * 3 + 1]!]! + depth[out[t * 3 + 2]!]!) / 3;
    expect(avg(0)).toBeLessThanOrEqual(avg(1));
    expect(avg(1)).toBeLessThanOrEqual(avg(2));
  });

  it('preserves triangle winding (only the order of triangles changes)', () => {
    const tris = new Uint16Array([0, 1, 2, 3, 4, 5]);
    const depth = new Float32Array([5, 5, 5, -5, -5, -5]);
    const out = sortTrianglesByDepth(tris, depth);
    expect(Array.from(out.slice(0, 3))).toEqual([3, 4, 5]);
    expect(Array.from(out.slice(3, 6))).toEqual([0, 1, 2]);
  });

  it('is a stable sort — equal depths keep authored order', () => {
    const tris = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const depth = new Float32Array(9).fill(0);
    expect(Array.from(sortTrianglesByDepth(tris, depth))).toEqual(Array.from(tris));
  });

  it('keeps the same triangle count and index multiset', () => {
    const m = buildRestMesh(160, 120, 0, RIG);
    const depth = new Float32Array(m.vertices.length / 4).map((_, i) => (i % 7) - 3);
    const out = sortTrianglesByDepth(m.triangles, depth);
    expect(out.length).toBe(m.triangles.length);
    expect(Array.from(out).sort()).toEqual(Array.from(m.triangles).sort());
  });

  it('is deterministic', () => {
    const m = buildRestMesh(160, 120, 0, RIG);
    const depth = new Float32Array(m.vertices.length / 4).map((_, i) => Math.sin(i));
    expect(Array.from(sortTrianglesByDepth(m.triangles, depth)))
      .toEqual(Array.from(sortTrianglesByDepth(m.triangles, depth)));
  });
});

describe('buildSnapshot integration', () => {
  it('no overlap → index buffer passed through untouched, no depth attached', () => {
    const { graph, anim } = sceneWith(RIG);
    const mesh = meshOf(graph, anim);
    const rest = buildRestMesh(160, 120, 0, RIG);
    expect(mesh.depth).toBeUndefined();
    expect(Array.from(mesh.triangles)).toEqual(Array.from(rest.triangles));
  });

  it('an overlap pin attaches depth and reorders the triangles', () => {
    const rig: PuppetRig = {
      ...RIG,
      pins: [
        { id: 'a', name: 'a', x: -50, y: 0, overlap: -70 },
        { id: 'b', name: 'b', x: 50, y: 0, overlap: 70 },
      ],
    };
    const { graph, anim } = sceneWith(rig);
    const mesh = meshOf(graph, anim);
    expect(mesh.depth).toBeDefined();
    expect(mesh.depth!.length).toBe(mesh.vertices.length / 4);
    const rest = buildRestMesh(160, 120, 0, rig);
    expect(Array.from(mesh.triangles)).not.toEqual(Array.from(rest.triangles));
    // Same geometry, just reordered.
    expect(Array.from(mesh.triangles).sort()).toEqual(Array.from(rest.triangles).sort());
  });

  it('per-pin scale reaches the rendered mesh', () => {
    const plain = sceneWith(RIG);
    const scaled = sceneWith({
      ...RIG,
      pins: [{ id: 'a', name: 'a', x: -50, y: 0 }, { id: 'b', name: 'b', x: 50, y: 0, scale: 2 }],
    });
    const a = meshOf(plain.graph, plain.anim).vertices;
    const b = meshOf(scaled.graph, scaled.anim).vertices;
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differs = true; break; }
    expect(differs).toBe(true);
  });

  it('mesh rotation refinement reaches the rendered mesh', () => {
    const free = sceneWith({
      ...RIG,
      pins: [{ id: 'a', name: 'a', x: -50, y: 0 }, { id: 'b', name: 'b', x: 50, y: 0, rotation: 140 }],
    });
    const capped = sceneWith({
      ...RIG,
      maxRotationDeg: 15,
      pins: [{ id: 'a', name: 'a', x: -50, y: 0 }, { id: 'b', name: 'b', x: 50, y: 0, rotation: 140 }],
    });
    const a = meshOf(free.graph, free.anim).vertices;
    const b = meshOf(capped.graph, capped.anim).vertices;
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differs = true; break; }
    expect(differs).toBe(true);
  });

  it('animated pin scale changes the mesh over time', () => {
    const { graph, anim } = sceneWith(RIG);
    anim.setKeyframe('m', 'puppet.b.scale', 0, 1);
    anim.setKeyframe('m', 'puppet.b.scale', 2, 2.5);
    const at = (t: number) => {
      const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
      return snap.layers.find((l) => l.id === 'm')!.deformedMesh!.vertices;
    };
    const v0 = at(0);
    const v2 = at(2);
    let differs = false;
    for (let i = 0; i < v0.length; i++) if (v0[i] !== v2[i]) { differs = true; break; }
    expect(differs).toBe(true);
  });

  it('bone scale tracks reach the pose', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('m'));
    graph.setSkeleton('m', {
      bones: [
        { id: 'root', name: 'Root', parentId: null, length: 50, x: -60, y: 0, rotation: 0 },
        { id: 'tip', name: 'Tip', parentId: 'root', length: 50, x: 50, y: 0, rotation: 0 },
      ],
      ikTargets: [],
      meshDensity: 8,
      meshExpansion: 0,
    });
    const anim = new AnimationEngine();
    const base = meshOf(graph, anim).vertices;
    anim.setKeyframe('m', 'bone.tip.scaleX', 0, 2.5);
    const scaled = meshOf(graph, anim).vertices;
    let differs = false;
    for (let i = 0; i < base.length; i++) if (base[i] !== scaled[i]) { differs = true; break; }
    expect(differs).toBe(true);
  });
});
