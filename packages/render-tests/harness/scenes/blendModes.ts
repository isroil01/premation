/**
 * Blend-mode family: one scene per LayerBlendMode (17 total, per
 * src/core/effects/blendMode.ts). A colourful gradient base with a
 * mid-tone ellipse on top carrying the blend mode — chosen so every mode
 * produces a visibly distinct composite.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 320, height: 220, background: '#101014' };
const SIZE = { w: 320, h: 220 };

// The full 17, in menu order (blendMode.ts:42). 'normal' is the default.
const MODES = [
  'normal', 'add', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
  'exclusion', 'hue', 'saturation', 'color', 'luminosity',
] as const;

function blendScene(mode: string): Scene {
  const isGpuOk = ['overlay', 'hard-light', 'soft-light', 'luminosity'].includes(mode);
  return defineScene({
    id: `blend-${mode}`,
    description: `Blend mode "${mode}": mid-tone ellipse over a gradient base.`,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: isGpuOk ? 'expect-pass' : 'known-divergent',
    build(graph) {
      // Base: comp-filling multi-stop gradient.
      graph.addNode(node('base', { kind: 'shape', style: { fill: '#000' } }));
      graph.setSolid('base', true);
      graph.setFill('base', {
        type: 'linear',
        angle: 45,
        stops: [
          { id: 'a', offset: 0, color: '#1030ff' },
          { id: 'b', offset: 0.5, color: '#ff2d55' },
          { id: 'c', offset: 1, color: '#ffd000' },
        ],
      } as never);
      // Top: mid-tone ellipse carrying the blend mode.
      graph.addNode(node('top', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 200, height: 160, shapeType: 'ellipse' },
        style: { fill: '#6f8fa8' },
      }));
      graph.setBlendMode('top', mode);
    },
  });
}

export const blendModeScenes: Scene[] = MODES.map(blendScene);
