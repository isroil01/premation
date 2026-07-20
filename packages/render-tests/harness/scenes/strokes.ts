/**
 * Stroke family: join styles, dashed + caps, and multi-stroke stacking.
 *
 * All use the fixed 220px shape centred in a 360×280 comp so corners (joins)
 * and dash gaps (caps) are fully on-canvas. Flagged known-divergent — stroke
 * geometry is one of the areas the two engines are expected to differ on until
 * unification; the suite tracks the gap.
 */

import { defineScene, shapeNode, type Scene } from '../sceneKit';

const COMP = { width: 360, height: 280, background: '#101014' };
const SIZE = { w: 360, h: 280 };

interface StrokeOpts {
  color: string;
  width: number;
  opacity?: number;
  align?: 'center' | 'inside' | 'outside';
  dash?: number[];
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

function strokeScene(id: string, description: string, strokes: StrokeOpts[]): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph) {
      graph.addNode(shapeNode('s', { x: 180, y: 140, rotation: 0, fill: '#1f4f8f' }));
      const payload = strokes.map((s) => ({
        enabled: true,
        opacity: 1,
        align: 'center',
        dash: [],
        cap: 'butt',
        join: 'miter',
        ...s,
      }));
      if (payload.length === 1) graph.setStroke('s', payload[0]);
      else graph.setStrokes('s', payload);
    },
  });
}

export const strokeScenes: Scene[] = [
  strokeScene('stroke-join-miter', 'Thick miter-join stroke on a rect.', [
    { color: '#ffcf33', width: 20, join: 'miter' },
  ]),
  strokeScene('stroke-join-round', 'Thick round-join stroke on a rect.', [
    { color: '#ffcf33', width: 20, join: 'round' },
  ]),
  strokeScene('stroke-join-bevel', 'Thick bevel-join stroke on a rect.', [
    { color: '#ffcf33', width: 20, join: 'bevel' },
  ]),
  strokeScene('stroke-dashed-round-cap', 'Dashed stroke with round caps.', [
    { color: '#33e0a0', width: 14, dash: [30, 22], cap: 'round' },
  ]),
  strokeScene('stroke-dashed-square-cap', 'Dashed stroke with square caps.', [
    { color: '#33e0a0', width: 14, dash: [30, 22], cap: 'square' },
  ]),
  strokeScene('stroke-multi', 'Two stacked strokes (wide dark under thin bright).', [
    { color: '#20304a', width: 28, join: 'round' },
    { color: '#ff6b9d', width: 8, join: 'round' },
  ]),
];
