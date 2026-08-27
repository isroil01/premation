/**
 * Precomp family: a precomposed group (subtree → one texture) and time-remap
 * (sampling the inner timeline at a remapped time).
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { COMP_REF_PROP, COMP_COLLAPSE_PROP } from '@core/scene/compInstance';

const COMP = { width: 360, height: 240, background: '#0c0c12' };
const SIZE = { w: 360, h: 240 };

function scene(id: string, description: string, build: Scene['build']): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], build });
}

export const precompScenes: Scene[] = [
  scene('precomp-group', 'Precomposed group of two shapes rendered as one layer.', (graph) => {
    graph.addNode(node('G', { kind: 'group', position: { x: 0, y: 0 }, style: { opacity: 100 } }));
    graph.addChild('G', node('c1', { kind: 'shape', position: { x: 120, y: 120 }, transform: { width: 120, height: 120, shapeType: 'rect' }, style: { fill: '#ff5d73' } }));
    graph.addChild('G', node('c2', { kind: 'shape', position: { x: 240, y: 120 }, transform: { width: 120, height: 120, shapeType: 'ellipse' }, style: { fill: '#5db4ff' } }));
    graph.setPrecomp('G', true);
  }),

  /**
   * Nested precomps: outer group isolates an inner precomp that holds two
   * shapes. Both isolation boundaries must hold — flattening either level
   * inline would double-apply opacity or lose the outer transform's unit
   * of compositing.
   */
  defineScene({
    id: 'precomp-nested',
    description: 'Precomp containing another precomp (two isolation boundaries).',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    gpuParity: 'expect-pass',
    build(graph) {
      graph.addNode(node('outer', { kind: 'group', position: { x: 0, y: 0 }, style: { opacity: 100 } }));
      graph.addChild('outer', node('inner', { kind: 'group', position: { x: 40, y: 20 }, style: { opacity: 100 } }));
      graph.addChild('inner', node('c1', {
        kind: 'shape',
        position: { x: 100, y: 100 },
        transform: { width: 100, height: 100, shapeType: 'rect' },
        style: { fill: '#ff5d73' },
      }));
      graph.addChild('inner', node('c2', {
        kind: 'shape',
        position: { x: 220, y: 140 },
        transform: { width: 110, height: 110, shapeType: 'ellipse' },
        style: { fill: '#5db4ff' },
      }));
      graph.setPrecomp('inner', true);
      graph.setPrecomp('outer', true);
    },
  }),

  /**
   * Adjustment INSIDE a precomp must grade only the precomp's children.
   * A sibling solid outside the precomp stays ungraded — if the adjustment
   * leaked to the parent comp, that sibling would hue-shift too.
   */
  defineScene({
    id: 'adjustment-in-precomp',
    description: 'Hue-rotate adjustment inside a precomp; sibling outside stays ungraded.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    gpuParity: 'expect-pass',
    build(graph) {
      // Left: outside the precomp — must remain #00c853 (green).
      graph.addNode(node('outside', {
        kind: 'shape',
        position: { x: 70, y: 120 },
        transform: { width: 100, height: 160, shapeType: 'rect' },
        style: { fill: '#00c853' },
      }));
      graph.addNode(node('G', { kind: 'group', position: { x: 0, y: 0 }, style: { opacity: 100 } }));
      // Right: inside the precomp, graded by the adjustment.
      graph.addChild('G', node('inside', {
        kind: 'shape',
        position: { x: 250, y: 120 },
        transform: { width: 140, height: 160, shapeType: 'rect' },
        style: { fill: '#1030ff' },
      }));
      graph.addChild('G', node('adj', { kind: 'shape', style: { opacity: 100 } }));
      graph.setSolid('adj', true);
      graph.setAdjustment('adj', true);
      graph.setEffects('adj', [{ id: 'a1', type: 'hue-rotate', params: { amount: 140 } }]);
      graph.setPrecomp('G', true);
    },
  }),

  /**
   * Collapse Transformations — the AE-style still the unit tests could not be.
   *
   * `buildSnapshotCollapseTransforms.test.ts` pins the LAYER LIST (spliced vs
   * contained), but nothing pinned the pixels: a regression that kept the list
   * shape while flattening the projection would pass every unit test and ship
   * wrong frames. This scene makes the semantics visible in one image.
   *
   * Two placements of the SAME referenced comp, side by side. The host camera
   * sits far off to the right, so "did the host camera reach the inner 3D
   * layer?" is the left/right shear of the box:
   *
   *   • left, NOT collapsed — a sealed frame. Its 3D box resolves the inner
   *     comp's own default camera (dead centre), renders symmetric, and the
   *     host camera only moves the flat card that results.
   *   • right, collapsed — the inner layers are spliced into the host, take
   *     the host's off-axis camera, and the same box renders sheared.
   *
   * If collapse silently stopped splicing, both halves would render identical
   * cards and the diff catches it; if the camera scoping regressed the other
   * way (the pre-fix leak), the LEFT half shears too. One golden, both
   * directions of the historical bug.
   */
  defineScene({
    id: 'precomp-collapse',
    description: 'Same placed comp twice: collapsed takes the host camera, uncollapsed stays a sealed card.',
    size: SIZE,
    comp: {
      ...COMP,
      rootId: 'host',
      compSizeOf: (id) => (id === 'innerC' ? { width: 150, height: 110 } : undefined),
    },
    fps: 30,
    frames: [0],
    build(graph) {
      // The referenced comp: a 3D panel, deliberately rotated so its projected
      // silhouette is camera-dependent, over a flat backing card that shows the
      // instance's own footprint either way.
      graph.addNode(node('innerC', { kind: 'group', position: { x: 0, y: 0 }, style: { opacity: 100 } }));
      graph.addChild('innerC', node('iback', {
        kind: 'shape',
        position: { x: 75, y: 55 },
        transform: { width: 140, height: 100, shapeType: 'rect' },
        style: { fill: '#233047' },
      }));
      graph.addChild('innerC', node('ibox', {
        kind: 'shape',
        position: { x: 75, y: 55 },
        transform: { width: 70, height: 70, shapeType: 'rect', z: 0, rotationY: 45 },
        style: { fill: '#ffb020' },
      }));

      // The host: an off-axis camera and the two placements. The camera sits
      // 40px right of the comp centre — projection is about the comp-centre
      // principal point, so the collapsed 3D box shifts left by 45px (still on
      // its card) rather than off-frame. Enough to be unmistakable in a diff,
      // small enough to stay in the picture.
      graph.addNode(node('host', { kind: 'group', position: { x: 0, y: 0 }, style: { opacity: 100 } }));
      graph.addChild('host', node('cam', {
        kind: 'camera',
        position: { x: 220, y: 120 },
        transform: { z: -700, focalLength: 700 },
      }));
      const instance = (id: string, x: number, collapsed: boolean) => {
        graph.addChild('host', node(id, {
          kind: 'comp',
          position: { x, y: 120 },
          components: [{
            id: `${id}_fx`,
            type: 'fx',
            props: {
              precomp: true,
              [COMP_REF_PROP]: 'innerC',
              ...(collapsed ? { [COMP_COLLAPSE_PROP]: true } : {}),
            },
          }],
        }));
      };
      instance('flatInst', 95, false);
      instance('collInst', 265, true);
    },
  }),

  defineScene({
    id: 'precomp-time-remap',
    description: 'Precomp with reversed time remap; sampled at comp t=0 → inner t=1.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph, anim) {
      graph.addNode(node('G', { kind: 'group', position: { x: 0, y: 0 }, style: { opacity: 100 } }));
      graph.addChild('G', node('mover', { kind: 'shape', position: { x: 60, y: 120 }, transform: { width: 80, height: 80, shapeType: 'ellipse' }, style: { fill: '#ffca3a' } }));
      graph.setPrecomp('G', true);
      // Inner animation: mover sweeps over 2s.
      anim.setKeyframe('mover', 'x', 0, 60);
      anim.setKeyframe('mover', 'x', 2, 300);
      // Reverse time: comp t=0 → inner t=1 (mover halfway across).
      anim.setKeyframe('G', 'timeRemap', 0, 1);
      anim.setKeyframe('G', 'timeRemap', 1, 0);
    },
  }),
];
