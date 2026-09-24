/**
 * Cross-engine rig parity (plan D2: the C++ engine producing its own frame).
 *
 * Every case is a rigged layer built with the editor's own stores, captured as
 * the `.motion` document the C++ engine opens, and rendered by `buildSnapshot`
 * at several times. The fixture records the document and, per time, what
 * buildSnapshot fed its rig block and the `layer.deformedMesh` it produced.
 * `native/engine/tests/test_rig_parity.cpp` opens the same document with the
 * C++ engine's reader and must produce the same bytes through the same entry
 * point snapshot_build uses (`build_rig_mesh_for`).
 *
 * `GEN_NATIVE_RIG=1 npx jest rigCrossEngine` rewrites the fixture; without it
 * this test fails when the checked-in fixture no longer matches the TypeScript
 * (a rig change that did not regenerate it).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { rasterPadding } from '@core/rendering/raster/vectorDraw';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { captureDocument } from '@core/api/cloudDocument';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { PuppetRig } from './puppet';
import type { SkeletonRig } from './skeletonCommands';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/rig_parity.json');
const DEG = Math.PI / 180;
const comp = { width: 800, height: 600, background: '#101014' };

interface Sample {
  t: number;
  rigT: number;
  width: number;
  height: number;
  pad: number;
  pathPoints: unknown;
  pathOpen: boolean;
  vertices: number[];
  triangles: number[];
  depth?: number[];
}
interface Case {
  name: string;
  node: string;
  document: unknown;
  samples: Sample[];
}

function shapeNode(id: string, w: number, h: number, outline?: Array<{ x: number; y: number }>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 150, rotation: 0, width: w, height: h } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      // A closed outline: what the silhouette mesh follows.
      ...(outline ? [{ id: `${id}_g`, type: 'Geometry', props: { points: outline, open: false } }] : []),
    ],
  } as unknown as SceneNode;
}

/** A closed blob outline (layer px about the centre) — a silhouette mesh's input. */
function blob(): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? 70 : 52;
    pts.push({ x: Math.round(Math.cos(a) * r * 100) / 100, y: Math.round(Math.sin(a) * r * 0.7 * 100) / 100 });
  }
  return pts;
}

const BONES = [
  { id: 'upper', parentId: null, length: 70, x: -55, y: 18, rotation: -22 * DEG },
  { id: 'fore', parentId: 'upper', length: 45, x: 70, y: 0, rotation: 48 * DEG },
];

/** Each case builds its layer into the (fresh) global stores. */
const CASES: Array<{ name: string; node: string; times: number[]; build(): void }> = [
  {
    name: 'puppet: animated pin position, rotation and stiffness (ARAP)',
    node: 'pup',
    times: [0, 1, 2],
    build() {
      defaultSceneGraph.addNode(shapeNode('pup', 120, 90));
      defaultSceneGraph.setPuppet('pup', {
        meshDensity: 12, meshExpansion: 6,
        pins: [{ id: 'pinA', name: 'A', x: -40, y: 0, stiffness: 0.5 }, { id: 'pinB', name: 'B', x: 40, y: 0 }],
      } as PuppetRig);
      defaultAnimation.setDataTrack('pup', 'puppet.pinA.position', {
        nodeId: 'pup', prop: 'puppet.pinA.position', kind: 'points',
        keyframes: [{ t: 0, value: [{ x: -40, y: 0 }] }, { t: 2, value: [{ x: -20, y: 25 }] }],
      } as never);
      defaultAnimation.setKeyframe('pup', 'puppet.pinB.rotation', 0, 0);
      defaultAnimation.setKeyframe('pup', 'puppet.pinB.rotation', 2, 45);
      defaultAnimation.setKeyframe('pup', 'puppet.pinA.stiffness', 0, 0);
      defaultAnimation.setKeyframe('pup', 'puppet.pinA.stiffness', 2, 2);
    },
  },
  {
    name: 'puppet: bend pin, LBS solver, a rotation limit',
    node: 'bend',
    times: [0, 1.5],
    build() {
      defaultSceneGraph.addNode(shapeNode('bend', 120, 90));
      defaultSceneGraph.setPuppet('bend', {
        meshDensity: 12, meshExpansion: 6, solver: 'lbs', maxRotationDeg: 60,
        pins: [
          { id: 'L', name: 'L', x: -40, y: 0 },
          { id: 'R', name: 'R', x: 40, y: 0 },
          { id: 'M', name: 'M', x: 0, y: 0, kind: 'bend', rotation: 30 },
        ],
      } as PuppetRig);
      defaultAnimation.setDataTrack('bend', 'puppet.L.position', {
        nodeId: 'bend', prop: 'puppet.L.position', kind: 'points',
        keyframes: [{ t: 0, value: [{ x: -40, y: 0 }] }, { t: 2, value: [{ x: -40, y: -30 }] }],
      } as never);
    },
  },
  {
    name: 'puppet: overlap pins — per-vertex depth and triangle order',
    node: 'ovl',
    times: [0],
    build() {
      defaultSceneGraph.addNode(shapeNode('ovl', 160, 100));
      defaultSceneGraph.setPuppet('ovl', {
        meshDensity: 10,
        pins: [
          { id: 'a', name: 'a', x: -50, y: 0, overlap: -70 },
          { id: 'b', name: 'b', x: 50, y: 0, overlap: 70 },
          { id: 'c', name: 'c', x: 0, y: 30 },
        ],
      } as PuppetRig);
    },
  },
  {
    name: 'puppet: silhouette mesh on a closed path',
    node: 'sil',
    times: [0, 1],
    build() {
      defaultSceneGraph.addNode(shapeNode('sil', 140, 100, blob()));
      defaultSceneGraph.setPuppet('sil', {
        meshDensity: 14, meshMode: 'silhouette',
        pins: [{ id: 'p', name: 'p', x: -30, y: 0 }, { id: 'q', name: 'q', x: 30, y: 0 }],
      } as PuppetRig);
      defaultAnimation.setDataTrack('sil', 'puppet.q.position', {
        nodeId: 'sil', prop: 'puppet.q.position', kind: 'points',
        keyframes: [{ t: 0, value: [{ x: 30, y: 0 }] }, { t: 1, value: [{ x: 45, y: -20 }] }],
      } as never);
    },
  },
  {
    name: 'skeleton: FK bone keys',
    node: 'fk',
    times: [0, 1],
    build() {
      defaultSceneGraph.addNode(shapeNode('fk', 180, 120));
      defaultSceneGraph.setSkeleton('fk', { bones: BONES, meshDensity: 8 } as SkeletonRig);
      defaultAnimation.setKeyframe('fk', 'bone.fore.rotation', 0, 48 * DEG);
      defaultAnimation.setKeyframe('fk', 'bone.fore.rotation', 1, 10 * DEG);
      defaultAnimation.setKeyframe('fk', 'bone.upper.x', 0, -55);
      defaultAnimation.setKeyframe('fk', 'bone.upper.x', 1, -40);
    },
  },
  {
    name: 'skeleton: an IK target',
    node: 'ik',
    times: [0],
    build() {
      defaultSceneGraph.addNode(shapeNode('ik', 180, 120));
      defaultSceneGraph.setSkeleton('ik', {
        bones: BONES, meshDensity: 8, ikTargets: [{ boneId: 'fore', x: 15, y: 62, chainLength: 2 }],
      } as SkeletonRig);
    },
  },
  {
    name: 'puppet + skeleton on one layer',
    node: 'both',
    times: [0, 1],
    build() {
      defaultSceneGraph.addNode(shapeNode('both', 180, 120));
      defaultSceneGraph.setPuppet('both', {
        meshDensity: 10, pins: [{ id: 'k', name: 'k', x: -60, y: 0 }, { id: 'j', name: 'j', x: 60, y: 10 }],
      } as PuppetRig);
      defaultSceneGraph.setSkeleton('both', { bones: BONES } as SkeletonRig);
      defaultAnimation.setKeyframe('both', 'bone.upper.rotation', 0, -22 * DEG);
      defaultAnimation.setKeyframe('both', 'bone.upper.rotation', 1, 5 * DEG);
    },
  },
];

let h: Harness & { engine: LocalEngine };
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function generate(): Promise<Case[]> {
  const out: Case[] = [];
  for (const c of CASES) {
    await h.dispose();
    h = await setupAppEngine();
    c.build();
    const samples: Sample[] = [];
    for (const t of c.times) {
      const snap = buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, comp);
      const layer = snap.layers.find((l) => l.id === c.node);
      if (!layer?.deformedMesh) throw new Error(`${c.name}: no deformed mesh at t=${t}`);
      const m = layer.deformedMesh;
      samples.push({
        t,
        rigT: layer.sourceTime ?? t,
        width: layer.width ?? 100,
        height: layer.height ?? 100,
        pad: rasterPadding(layer),
        pathPoints: layer.pathPoints ?? null,
        pathOpen: layer.pathOpen === true,
        vertices: Array.from(m.vertices),
        triangles: Array.from(m.triangles),
        ...(m.depth ? { depth: Array.from(m.depth) } : {}),
      });
    }
    out.push({ name: c.name, node: c.node, document: JSON.parse(JSON.stringify(captureDocument())), samples });
  }
  return out;
}

test('the C++ rig parity fixture matches what buildSnapshot produces', async () => {
  const cases = await generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/rig/rigCrossEngine.test.ts (GEN_NATIVE_RIG=1). Do not edit.', cases })}\n`;
  if (process.env.GEN_NATIVE_RIG === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  const stored = JSON.parse(readFileSync(OUT, 'utf8')) as { cases: Case[] };
  // The meshes, not the documents' incidental bytes (ids minted by the fresh stores match run to run anyway).
  expect(stored.cases.map((c) => ({ name: c.name, samples: c.samples }))).toEqual(cases.map((c) => ({ name: c.name, samples: c.samples })));
  // Every case really exercises its feature.
  for (const c of cases) expect(c.samples.every((s) => s.vertices.length > 0 && s.triangles.length > 0)).toBe(true);
  expect(cases.some((c) => c.samples.some((s) => s.depth))).toBe(true);
  expect(cases.find((c) => c.node === 'sil')!.samples.every((s) => Array.isArray(s.pathPoints))).toBe(true);
});
