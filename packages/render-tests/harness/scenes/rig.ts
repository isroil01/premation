/**
 * Rig family: puppet-pin and skeleton mesh deformation.
 *
 * WHY THIS FAMILY EXISTS: `deformedMesh` had no golden coverage at all. Every
 * rig behaviour was unit-tested at the vertex level, but nothing checked the
 * PIXELS — and the mesh path is exactly where vertex-level assertions miss
 * things: UV mapping into the padded texture, the unit-quad normalisation in
 * snapshotToFrameScene, triangle winding, and (since overlap resolves as draw
 * ORDER rather than a depth test) which fold ends up on top.
 *
 * Every scene here is a still at a time where the deformation is unambiguous,
 * and deliberately asymmetric so a mirrored or transposed mesh cannot pass.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import type { AnimationEngine } from '@motion/animation';
import type { SceneGraph } from '@core/scene/SceneGraph';

const COMP = { width: 360, height: 240, background: '#0c0c12' };
const SIZE = { w: 360, h: 240 };

/** A wide bar centred in the comp — the subject every rig scene deforms. */
function bar(graph: SceneGraph, opts: { w?: number; h?: number } = {}): void {
  graph.addNode(node('bar', {
    kind: 'shape',
    position: { x: 180, y: 120 },
    transform: { width: opts.w ?? 240, height: opts.h ?? 60 },
    style: { fill: '#4cc9f0' },
  }));
}

export const rigScenes: Scene[] = [
  defineScene({
    id: 'rig-puppet-bend',
    description: 'Two puppet pins, one displaced upward — ARAP bend. The baseline mesh render.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      bar(graph);
      graph.setPuppet('bar', {
        meshDensity: 12,
        meshExpansion: 0,
        pins: [
          { id: 'a', name: 'a', x: -100, y: 0 },
          { id: 'b', name: 'b', x: 100, y: 0 },
        ],
      });
      // Displace the right pin up and in — a clear, asymmetric bend.
      anim.setDataTrack('bar', 'puppet.b.position', {
        nodeId: 'bar',
        prop: 'puppet.b.position',
        kind: 'points',
        keyframes: [{ t: 0, value: [{ x: 70, y: -45 }] }],
      } as never);
    },
  }),

  defineScene({
    id: 'rig-puppet-lbs-vs-arap',
    description: 'Same two-pin bend solved with LBS — the candy-wrapper collapse ARAP avoids.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      bar(graph);
      graph.setPuppet('bar', {
        meshDensity: 12,
        meshExpansion: 0,
        solver: 'lbs',
        pins: [
          { id: 'a', name: 'a', x: -100, y: 0, rotation: 0 },
          { id: 'b', name: 'b', x: 100, y: 0, rotation: 70 },
        ],
      });
      void anim;
    },
  }),

  defineScene({
    id: 'rig-puppet-scale',
    description: 'Per-pin scale (AE Advanced pin): the right pin balloons its region.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      bar(graph);
      graph.setPuppet('bar', {
        meshDensity: 12,
        meshExpansion: 0,
        pins: [
          { id: 'a', name: 'a', x: -100, y: 0 },
          { id: 'b', name: 'b', x: 100, y: 0, scale: 1.9 },
        ],
      });
      void anim;
    },
  }),

  defineScene({
    id: 'rig-puppet-rotation-refinement',
    description: 'A 140° pin rotation CLAMPED to 20° by Mesh Rotation Refinement.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      bar(graph);
      graph.setPuppet('bar', {
        meshDensity: 12,
        meshExpansion: 0,
        maxRotationDeg: 20,
        pins: [
          { id: 'a', name: 'a', x: -100, y: 0 },
          { id: 'b', name: 'b', x: 100, y: 0, rotation: 140 },
        ],
      });
      void anim;
    },
  }),

  defineScene({
    id: 'rig-puppet-overlap',
    description:
      'Overlap pins: two folded regions with opposing depth. Locks the painter\'s draw ORDER — ' +
      'the one visual behaviour no vertex-level assertion can check.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      bar(graph, { h: 90 });
      graph.setPuppet('bar', {
        meshDensity: 14,
        meshExpansion: 0,
        pins: [
          // Fold the two ends across each other so the mesh genuinely overlaps,
          // then give them opposite depth so ordering decides what is visible.
          { id: 'left', name: 'left', x: -90, y: 0, overlap: -90 },
          { id: 'right', name: 'right', x: 90, y: 0, overlap: 90 },
        ],
      });
      anim.setDataTrack('bar', 'puppet.left.position', {
        nodeId: 'bar', prop: 'puppet.left.position', kind: 'points',
        keyframes: [{ t: 0, value: [{ x: 40, y: -25 }] }],
      } as never);
      anim.setDataTrack('bar', 'puppet.right.position', {
        nodeId: 'bar', prop: 'puppet.right.position', kind: 'points',
        keyframes: [{ t: 0, value: [{ x: -40, y: 25 }] }],
      } as never);
    },
  }),

  defineScene({
    id: 'rig-skeleton-pose',
    description: 'Two-bone skeleton, forearm rotated 40° — LBS skinning through the bone hierarchy.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      // Sized so the POSED result stays fully inside the frame — a golden that
      // clips loses coverage of whatever falls outside it.
      bar(graph, { w: 170, h: 44 });
      graph.setSkeleton('bar', {
        bones: [
          { id: 'upper', name: 'Upper', parentId: null, length: 45, x: -70, y: 0, rotation: 0 },
          { id: 'fore', name: 'Fore', parentId: 'upper', length: 45, x: 45, y: 0, rotation: 0 },
        ],
        ikTargets: [],
        meshDensity: 12,
        meshExpansion: 0,
      });
      anim.setKeyframe('bar', 'bone.fore.rotation', 0, (40 * Math.PI) / 180);
    },
  }),

  defineScene({
    id: 'rig-skeleton-bone-scale',
    description: 'Bone scaleX squash/stretch — the track that existed in the type but was never sampled.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      bar(graph, { w: 140, h: 50 });
      graph.setSkeleton('bar', {
        bones: [
          { id: 'upper', name: 'Upper', parentId: null, length: 40, x: -55, y: 0, rotation: 0 },
          { id: 'fore', name: 'Fore', parentId: 'upper', length: 40, x: 40, y: 0, rotation: 0 },
        ],
        ikTargets: [],
        meshDensity: 12,
        meshExpansion: 0,
      });
      anim.setKeyframe('bar', 'bone.fore.scaleX', 0, 1.7);
      anim.setKeyframe('bar', 'bone.fore.scaleY', 0, 0.55);
    },
  }),

  defineScene({
    id: 'rig-compose-puppet-skeleton',
    description:
      'BOTH rigs on one layer: the puppet refines in rest space, the skeleton poses on top. ' +
      'Locks the composition order documented in rigDeform.ts.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph, anim: AnimationEngine) {
      bar(graph, { w: 170, h: 44 });
      graph.setPuppet('bar', {
        meshDensity: 12,
        meshExpansion: 0,
        pins: [
          { id: 'a', name: 'a', x: -70, y: 0 },
          { id: 'b', name: 'b', x: 70, y: 0 },
        ],
      });
      graph.setSkeleton('bar', {
        bones: [
          { id: 'upper', name: 'Upper', parentId: null, length: 45, x: -70, y: 0, rotation: 0 },
          { id: 'fore', name: 'Fore', parentId: 'upper', length: 45, x: 45, y: 0, rotation: 0 },
        ],
        ikTargets: [],
      });
      anim.setDataTrack('bar', 'puppet.b.position', {
        nodeId: 'bar', prop: 'puppet.b.position', kind: 'points',
        keyframes: [{ t: 0, value: [{ x: 55, y: -28 }] }],
      } as never);
      anim.setKeyframe('bar', 'bone.fore.rotation', 0, (30 * Math.PI) / 180);
    },
  }),
];
