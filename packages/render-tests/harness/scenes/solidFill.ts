/**
 * Scene: a composition-filling rectangle with a flat solid fill.
 *
 * Measures shape edge-coverage parity. The interior matches the Canvas2D
 * reference exactly, but the two engines currently disagree on the ~1px
 * antialiased comp-edge (Canvas2D blends the rect edge against the dark comp
 * background; the GPU covers full pixels). Flagged 'known-divergent' so the
 * suite tracks — but does not yet gate on — that edge gap until it is closed.
 */

import { defineScene, shapeNode } from '../sceneKit';

export default defineScene({
  id: 'solid-fill',
  description: 'Comp-filling rectangle, flat solid fill (#3a7bd5) — shape edge-coverage probe.',
  size: { w: 320, h: 200 },
  comp: { width: 320, height: 200, background: '#101014' },
  fps: 30,
  frames: [0],
  build(graph) {
    graph.addNode(shapeNode('bg', { fill: '#3a7bd5' }));
    graph.setSolid('bg', true); // fills + centres to the comp
  },
});
