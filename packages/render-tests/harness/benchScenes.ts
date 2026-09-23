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

/**
 * E3 raster bench (scripts/bench-raster.mjs): text / vector rasterisation time,
 * TS (Canvas2D in the harness) vs C++ (premation-raster --bench) on the same
 * raster sources. Every frame re-rasterises every layer: the animator offset /
 * trim offset is keyframed, so each frame's rasters are new cache misses.
 */
const RB_FRAMES = Array.from({ length: 30 }, (_, i) => i + 1);

/** 200 text layers, 16 characters each, with a per-character animator
 *  (position, scale, rotation, opacity through a moving triangle selector). */
export const benchText200: Scene = defineScene({
  id: 'bench-raster-text-200',
  description: 'Raster bench: 200 animated text layers with per-character animators.',
  size: { w: W, h: H },
  comp: { width: W, height: H, background: '#0b0c10' },
  fps: 30,
  frames: RB_FRAMES,
  build(graph, anim) {
    for (let i = 0; i < 200; i++) {
      const id = `t${i}`;
      graph.addNode(node(id, {
        kind: 'text',
        position: { x: 120 + (i % 8) * 230, y: 30 + Math.floor(i / 8) * 42 },
        components: [{
          id: `${id}_c`,
          type: 'Text',
          props: {
            content: 'Premation motion', fontSize: 26, opacity: 100, fontFamily: 'Arial', align: 'center',
            fill: i % 2 ? '#f4f4f8' : '#ffd166',
            __animators: [{
              id: 'a1', basedOn: 'characters', shape: 'triangle', start: 0, end: 40, offset: 0,
              x: 0, y: -14, scale: 130, rotation: 18, opacity: 60, tracking: 0, skew: 0, mode: 'range', wiggleFreq: 2,
            }],
          },
        }],
      }));
      anim.setKeyframe(id, 'ta.0.offset', 0, -40 + i * 0.05);
      anim.setKeyframe(id, 'ta.0.offset', 1, 100 + i * 0.05);
    }
  },
});

/** 1000 filled + stroked shapes whose trim offset animates, so every frame
 *  re-cuts (and re-rasterises) every path. */
export const benchPaths1000: Scene = defineScene({
  id: 'bench-raster-paths-1000',
  description: 'Raster bench: 1000 animated trimmed paths (fill + round-join stroke).',
  size: { w: W, h: H },
  comp: { width: W, height: H, background: '#0b0c10' },
  fps: 30,
  frames: RB_FRAMES,
  build(graph, anim) {
    for (let i = 0; i < 1000; i++) {
      const id = `p${i}`;
      graph.addNode(node(id, {
        kind: 'shape',
        position: { x: 30 + (i % 40) * 47, y: 30 + Math.floor(i / 40) * 42 },
        rotation: (i * 11) % 90,
        transform: { width: 38, height: 30, shapeType: i % 2 ? 'ellipse' : 'rectangle', cornerRadius: 6 },
        style: { fill: i % 3 ? '#2b3cff' : '#19e6c1', opacity: 90 },
      }));
      graph.setStroke(id, { enabled: true, color: '#ffd166', width: 3, opacity: 1, align: 'center', dash: [], cap: 'round', join: 'round' } as never);
      graph.setTrimPath(id, { start: 0, end: 70, offset: 0 });
      anim.setKeyframe(id, `pathop.trimop_${id}.offset`, 0, i * 0.01);
      anim.setKeyframe(id, `pathop.trimop_${id}.offset`, 1, 100 + i * 0.01);
    }
  },
});

export const RASTER_BENCH_SCENES: Scene[] = [benchText200, benchPaths1000];
