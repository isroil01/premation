/**
 * Shape family: primitive kinds (rect/ellipse/bezier path), rounded corners,
 * and geometry operators (trim path, repeater, path-op). One feature per scene.
 */

import { defineScene, node, shapeNode, type Scene } from '../sceneKit';

const COMP = { width: 360, height: 280, background: '#101014' };
const SIZE = { w: 360, h: 280 };
const CENTER = { x: 180, y: 140 };

function scene(
  id: string,
  description: string,
  build: Scene['build'],
  gpuParity: Scene['gpuParity'] = 'expect-pass',
  divergence?: Scene['divergence'],
): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity, divergence, build });
}

export const shapeScenes: Scene[] = [
  scene('shape-rect', 'Axis-aligned rectangle primitive.', (graph) => {
    graph.addNode(node('r', { kind: 'shape', position: CENTER, transform: { width: 200, height: 140, shapeType: 'rect' }, style: { fill: '#3a7bd5' } }));
  }),

  scene('shape-ellipse', 'Ellipse primitive.', (graph) => {
    graph.addNode(node('e', { kind: 'shape', position: CENTER, transform: { width: 200, height: 160, shapeType: 'ellipse' }, style: { fill: '#e0518a' } }));
  }),

  scene('shape-rounded-rect', 'Rounded rectangle (cornerRadius).', (graph) => {
    graph.addNode(node('rr', { kind: 'shape', position: CENTER, transform: { width: 200, height: 150, shapeType: 'rect', cornerRadius: 36 }, style: { fill: '#33c1a6' } }));
  }),

  scene('shape-bezier-path', 'Closed custom bezier path (triangle-ish).', (graph) => {
    graph.addNode(
      node('p', {
        kind: 'shape',
        position: CENTER,
        style: { fill: '#f0a030' },
        components: [
          {
            id: 'p_g',
            type: 'Geometry',
            props: {
              points: [
                { x: 0, y: -90, inX: 0, inY: -90, outX: 0, outY: -90 },
                { x: 100, y: 80, inX: 100, inY: 80, outX: 100, outY: 80 },
                { x: -100, y: 80, inX: -100, inY: 80, outX: -100, outY: 80 },
              ],
            },
          },
        ],
      }),
    );
  }),

  scene('shape-trim-path', 'Stroked rect with trim path revealing 0→65% of the outline.', (graph) => {
    graph.addNode(shapeNode('s', { x: 180, y: 140, rotation: 0, fill: '#1f2f47' }));
    graph.setStroke('s', { enabled: true, color: '#66e0ff', width: 14, opacity: 1, align: 'center', dash: [], cap: 'round', join: 'round' });
    graph.setTrimPath('s', { start: 0, end: 65, offset: 0 });
  }),

  // The F14 gate. A trim with NO stroke at all: every inked pixel in this frame
  // is fill, so it can only be right if the trim cut the geometry the fill is
  // traced from. Before the fix this rendered a solid rectangle — `layer.trim`
  // was read inside the stroke loop and the fill ignored it.
  scene('shape-trim-fill', 'FILL follows the trim (no stroke) — the path is cut, not annotated.', (graph) => {
    graph.addNode(shapeNode('f', { x: 180, y: 140, rotation: 0, fill: '#f0a030' }));
    graph.setTrimPath('f', { start: 0, end: 50, offset: 0 });
  }),

  // Two runs from one path — the case a single `pathPoints` polyline could not
  // express, and therefore the reason trim could not cut geometry at all.
  scene('shape-trim-wrap', 'Trim window wrapped past the end of the path: TWO subpaths, filled + stroked.', (graph) => {
    graph.addNode(shapeNode('w', { x: 180, y: 140, rotation: 0, fill: '#1f2f47' }));
    graph.setStroke('w', { enabled: true, color: '#66e0ff', width: 10, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    graph.setTrimPath('w', { start: 0, end: 40, offset: 80 });
  }),

  scene('shape-repeater', 'Repeater: 4 copies with x/rotation/scale offset.', (graph) => {
    graph.addNode(node('rc', { kind: 'shape', position: { x: 90, y: 140 }, transform: { width: 70, height: 70, shapeType: 'rect' }, style: { fill: '#8a7bff' } }));
    graph.setRepeater('rc', { copies: 4, offsetX: 60, offsetY: 0, offsetRotation: 12, offsetScale: 0.85, offsetOpacity: 0.85 });
  }),

  scene('shape-path-op-zigzag', 'Zigzag path operator on a stroked rect.', (graph) => {
    graph.addNode(shapeNode('z', { x: 180, y: 140, rotation: 0, fill: '#22344f' }));
    graph.setStroke('z', { enabled: true, color: '#ffd166', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    graph.setPathOps('z', [{ id: 'z1', type: 'zigzag', amount: 16, detail: 5 }]);
  }),
  // Was marked `known-divergent` against a Canvas2D oracle. Two things ended
  // that: the references were re-blessed from WebGL2 (the documented
  // `wouldMatchWhen`, already met), and the scene's `setPathOps` call was
  // repaired — from schema 1.3.0 until 2026-08-04 it called the older
  // `setPathOp`, threw during setup, and rendered NOTHING, so the "accepted
  // coverage gap" was really a missing image. It matches exactly now, so it
  // gates like any other scene. See F15.
];
