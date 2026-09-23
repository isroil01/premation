/**
 * Bench-only scenes (docs/NATIVE_CORE_PLAN.md D2): a heavy 1080p comp timed on
 * the TS WebGPU backend in the harness and on the C++ render graph from the
 * SAME exported FrameScene (`premation-render --bench`). Not golden scenes —
 * never in the manifest, rendered only when HARNESS_BENCH=1.
 */

import { defineScene, node, type Scene } from './sceneKit';

const W = 1920;
const H = 1080;

/** 160 layers: gradient shapes, blend modes that force the backdrop path, and
 *  blur / glow / drop-shadow chains — the per-layer offscreen work a real comp
 *  spends its GPU time on. */
export const benchHeavy: Scene = defineScene({
  id: 'bench-heavy-1080p',
  description: 'Bench: 160 layers at 1080p — gradients, advanced blends, blur/glow/shadow chains.',
  size: { w: W, h: H },
  comp: { width: W, height: H, background: '#0b0c10' },
  fps: 30,
  frames: [0],
  build(graph) {
    const blends = ['normal', 'screen', 'add', 'overlay', 'multiply', 'soft-light'];
    const fx = [
      [{ id: 'b', type: 'blur', params: { radius: 12 } }],
      [{ id: 'g', type: 'glow', params: { radius: 16, color: '#78b4ff', intensity: 90 } }],
      [{ id: 's', type: 'drop-shadow', params: { distance: 14, softness: 18, opacity: 70 } }],
    ];
    for (let i = 0; i < 160; i++) {
      const id = `l${i}`;
      const col = i % 16;
      const row = Math.floor(i / 16);
      graph.addNode(node(id, {
        kind: 'shape',
        position: { x: 70 + col * 118, y: 60 + row * 104 },
        rotation: (i * 17) % 90,
        transform: { width: 150, height: 110, shapeType: i % 3 === 0 ? 'ellipse' : 'rectangle', cornerRadius: 18 },
        style: { fill: '#000', opacity: 85 },
      }));
      graph.setFill(id, {
        type: 'linear',
        angle: (i * 37) % 360,
        stops: [
          { id: 'a', offset: 0, color: i % 2 ? '#2b3cff' : '#ff2d55' },
          { id: 'b', offset: 1, color: i % 3 ? '#ffd000' : '#19e6c1' },
        ],
      } as never);
      const blend = blends[i % blends.length]!;
      if (blend !== 'normal') graph.setBlendMode(id, blend);
      if (i % 8 === 0) graph.setEffects(id, fx[(i / 8) % fx.length] as never);
    }
  },
});

/** 1500 small plain layers: CPU-bound — per-layer engine overhead (snapshot,
 *  packing, draw submission), not fill rate. */
export const benchManyLayers: Scene = defineScene({
  id: 'bench-many-layers-1080p',
  description: 'Bench: 1500 plain shape layers at 1080p (per-layer overhead).',
  size: { w: W, h: H },
  comp: { width: W, height: H, background: '#0b0c10' },
  fps: 30,
  frames: [0],
  build(graph) {
    for (let i = 0; i < 1500; i++) {
      const id = `m${i}`;
      graph.addNode(node(id, {
        kind: 'shape',
        position: { x: 20 + (i % 50) * 38, y: 20 + Math.floor(i / 50) * 35 },
        rotation: (i * 13) % 60,
        transform: { width: 30, height: 26, shapeType: i % 2 ? 'ellipse' : 'rectangle' },
        style: { fill: i % 3 ? '#ff2d55' : '#19e6c1', opacity: 80 },
      }));
    }
  },
});

export const BENCH_SCENES: Scene[] = [benchHeavy, benchManyLayers];
