/**
 * Generative family: paint strokes (deterministic freehand geometry).
 *
 * DEFERRED (need committed binary assets or Canvas2D sim support):
 *   - particles: the particle sim does not rasterise on the Canvas2D oracle
 *     (the emitter falls back to a plain shape body), so it can't be blessed
 *     from Canvas2D yet.
 *   - image-sequence / video: require committed frame assets.
 * Tracked in the Phase 0 coverage task.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 360, height: 280, background: '#0c0c12' };
const SIZE = { w: 360, h: 280 };

export const generativeScenes: Scene[] = [
  defineScene({
    id: 'paint-strokes',
    description: 'Freehand paint strokes on a layer.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph) {
      graph.addNode(node('canvas', { kind: 'shape', position: { x: 180, y: 140 }, transform: { width: 300, height: 220, shapeType: 'rect' }, style: { fill: '#1a2233' } }));
      graph.setPaint('canvas', {
        strokes: [
          { id: 'p1', points: [{ x: -110, y: 40 }, { x: -40, y: -50 }, { x: 30, y: 40 }, { x: 110, y: -50 }], color: '#ff7ad0', size: 14, opacity: 1, hardness: 1, mode: 'paint' },
          { id: 'p2', points: [{ x: -110, y: -10 }, { x: 110, y: -10 }], color: '#7affd0', size: 8, opacity: 1, hardness: 1, mode: 'paint' },
        ],
      });
    },
  }),
];
