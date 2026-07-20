/**
 * Precomp family: a precomposed group (subtree → one texture) and time-remap
 * (sampling the inner timeline at a remapped time).
 */

import { defineScene, node, type Scene } from '../sceneKit';

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
