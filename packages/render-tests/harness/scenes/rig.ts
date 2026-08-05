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
 * and deliberately asymmetric so a mirrored mesh cannot pass.
 *
 * CORRECTION, measured 2026-08-06. The line above used to claim a TRANSPOSED
 * mesh could not pass either. It could. Every scene below fills its bar with a
 * FLAT COLOUR, and UV mapping is only observable through texture CONTENT — a
 * uniform texture samples the same colour at every coordinate, so swapping u and
 * v changes nothing. Verified by transposing the UV write in both the grid and
 * the silhouette path and running the gate: green both times. The mesh being
 * asymmetric was never the property that mattered; the TEXTURE being asymmetric
 * is. `rig-uv-orientation` below is the scene that closes it.
 *
 * TWO UV PATHS, and both are now covered. A plain bbox layer meshes on the GRID
 * path; a layer with a CLOSED path silhouette meshes on `buildSilhouetteMesh`,
 * which has its own UV write. `rig-uv-orientation` covers the first and
 * `rig-uv-orientation-silhouette` the second — the same swap is a separate bug
 * in each, and the first mutation attempt during this work hit the silhouette
 * site while every scene took the grid one, so green meant nothing.
 *
 * TRIANGLE WINDING, also measured, and NOT a gap. Reversing the winding at both
 * emission sites leaves the gate green — correctly, because nothing in the
 * renderer culls (`grep cullMode|cullFace|CULL_FACE` finds no state anywhere),
 * and a filled triangle covers the same pixels whichever way it is wound. A
 * pixel guard for winding would be a test that cannot fail, which is worse than
 * no test; the honest record is this note.
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

/**
 * A bar whose texture has DIRECTIONAL content — the fixture a UV error needs.
 *
 * The ramp runs along one axis with five distinct hues, so sampling it with u
 * and v exchanged rotates the ramp a quarter turn and moves thousands of pixels.
 * A flat fill cannot do this no matter how asymmetric the mesh is.
 */
function texturedBar(graph: SceneGraph): void {
  graph.addNode(node('bar', {
    kind: 'shape',
    position: { x: 180, y: 120 },
    // Deliberately NOT square: a square bar would make u and v interchangeable
    // in extent as well as in content, which is a second way to hide the swap.
    transform: { width: 240, height: 60 },
    style: { fill: '#4cc9f0' },
  }));
  graph.setFill('bar', {
    type: 'linear',
    angle: 0,
    stops: [
      { id: 'u0', offset: 0, color: '#ff0040' },
      { id: 'u1', offset: 0.25, color: '#ff9e00' },
      { id: 'u2', offset: 0.5, color: '#00d4ff' },
      { id: 'u3', offset: 0.75, color: '#7a00ff' },
      { id: 'u4', offset: 1, color: '#00ff88' },
    ],
  });
}

export const rigScenes: Scene[] = [
  defineScene({
    id: 'rig-uv-orientation-silhouette',
    description:
      'The SILHOUETTE mesh path with a directional ramp — the second UV write site, which the grid scene cannot reach.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph) {
      // A CLOSED path of >=3 points is what routes the mesh through
      // `buildSilhouetteMesh` instead of the bbox grid — see
      // `silhouetteFromPathPoints`. Deliberately not a rectangle and not
      // symmetric about either axis, so the outline itself carries orientation.
      graph.addNode(node('bar', {
        kind: 'shape',
        position: { x: 180, y: 120 },
        transform: { width: 240, height: 90 },
        style: { fill: '#4cc9f0' },
        components: [
          {
            id: 'sil_g',
            type: 'Geometry',
            props: {
              points: [
                { x: -120, y: -20 }, { x: -30, y: -45 }, { x: 60, y: -30 },
                { x: 120, y: 10 }, { x: 40, y: 45 }, { x: -70, y: 30 },
              ].map((pt) => ({ ...pt, inX: pt.x, inY: pt.y, outX: pt.x, outY: pt.y })),
            },
          },
        ],
      }));
      graph.setFill('bar', {
        type: 'linear',
        angle: 0,
        stops: [
          { id: 'u0', offset: 0, color: '#ff0040' },
          { id: 'u1', offset: 0.25, color: '#ff9e00' },
          { id: 'u2', offset: 0.5, color: '#00d4ff' },
          { id: 'u3', offset: 0.75, color: '#7a00ff' },
          { id: 'u4', offset: 1, color: '#00ff88' },
        ],
      });
      graph.setPuppet('bar', {
        // meshMode is what actually routes to `buildSilhouetteMesh`; a closed
        // outline alone only CULLS the grid. Without this the scene rendered a
        // convincing hexagon and still took the grid path — which is exactly
        // how the first version of this scene failed to catch its own subject.
        meshMode: 'silhouette',
        meshDensity: 12,
        meshExpansion: 0,
        pins: [
          { id: 'p0', name: 'L', x: -90, y: 0 },
          { id: 'p1', name: 'R', x: 90, y: 0 },
          { id: 'p2', name: 'M', x: 0, y: -30 },
        ],
      });
    },
  }),

  defineScene({
    id: 'rig-uv-orientation',
    description:
      'Deformed bar with a five-hue ramp ACROSS it — the only scene here whose texture can show a u/v swap.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph: SceneGraph) {
      texturedBar(graph);
      // A bend, so the mesh is genuinely deformed and the UVs are doing work
      // rather than mapping an undisturbed rectangle onto itself.
      graph.setPuppet('bar', {
        meshDensity: 12,
        meshExpansion: 0,
        pins: [
          { id: 'p0', name: 'L', x: -90, y: 0 },
          { id: 'p1', name: 'R', x: 90, y: 0 },
          { id: 'p2', name: 'M', x: 0, y: -34 },
        ],
      });
    },
  }),

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
