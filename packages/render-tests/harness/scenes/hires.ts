/**
 * High-resolution scene: renders at 4× output (view.scale = 4), the analog of
 * exporting a small comp to 4K. It exercises the resolution-tier path: with the
 * old fixed 2× supersample the GPU would sample a texture smaller than the
 * on-screen size and upscale it (soft), diverging hard from the crisp Canvas2D
 * reference (which draws directly at device resolution). With resolution tiers
 * the vector re-rasters at tier(4)=4 × supersample, staying crisp.
 *
 * Hard-edged content (stroke + text) makes any upscale softness obvious.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 120, height: 80, background: '#0c0c12' };

export const hiresScenes: Scene[] = [
  defineScene({
    id: 'hires-4x-stroke-text',
    description: 'Stroked rect + text at 4× output — exercises resolution-tier re-raster (4K-export analog).',
    size: { w: 480, h: 320 }, // 4× comp → view.scale 4 → resolution tier 4
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph) {
      graph.addNode(node('s', {
        kind: 'shape',
        position: { x: 60, y: 40 },
        transform: { width: 72, height: 48, shapeType: 'rect', cornerRadius: 8 },
        style: { fill: '#1f4f8f' },
      }));
      graph.setStroke('s', { enabled: true, color: '#ffcf33', width: 6, opacity: 1, align: 'center', dash: [], cap: 'round', join: 'round' });
      graph.addNode(node('t', {
        kind: 'text',
        position: { x: 60, y: 40 },
        components: [
          { id: 't_c', type: 'Text', props: { content: 'Sharp', fontSize: 18, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#eaf0ff' } },
        ],
      }));
    },
  }),
];
