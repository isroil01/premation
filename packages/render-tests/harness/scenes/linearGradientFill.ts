/**
 * Canary scene: a composition-filling rectangle with a 5-stop linear gradient.
 *
 * Purpose = divergence detection. The GPU path is documented to render only the
 * FIRST gradient stop (see capabilities.ts / snapshotToFrameScene.ts), so this
 * scene is expected to DIVERGE from the Canvas2D reference across the whole
 * frame until Phase 1/2 lands multi-stop gradients. It proves the suite can
 * actually see a real, large pixel difference — and it becomes a green parity
 * gate the moment the gradient gap is closed.
 */

import { defineScene, shapeNode } from '../sceneKit';

export default defineScene({
  id: 'linear-gradient-fill',
  description: '5-stop linear gradient fill across the comp (exposes GPU first-stop gap).',
  size: { w: 320, h: 200 },
  comp: { width: 320, height: 200, background: '#101014' },
  fps: 30,
  frames: [0],
  build(graph) {
    graph.addNode(shapeNode('bg'));
    graph.setSolid('bg', true);
    graph.setFill('bg', {
      type: 'linear',
      angle: 90,
      stops: [
        { id: 's0', offset: 0, color: '#ff0040' },
        { id: 's1', offset: 0.25, color: '#ff9e00' },
        { id: 's2', offset: 0.5, color: '#00d4ff' },
        { id: 's3', offset: 0.75, color: '#7a00ff' },
        { id: 's4', offset: 1, color: '#00ff88' },
      ],
    } as never);
  },
});
