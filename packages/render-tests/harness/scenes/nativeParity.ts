/**
 * Native-parity scenes (docs/NATIVE_CORE_PLAN.md D2/D3): paths no committed
 * golden covers, rendered by the TS WebGPU renderer and by the C++ render graph
 * from the SAME exported FrameScene and compared byte for byte by the `native`
 * backend gate.
 *
 *   native-float32-*     the 32-bpc project depth (rgba32float intermediates, no
 *                        MSAA): over-range light that must survive an add, a
 *                        blur and a glow and clip only at the display encode;
 *                        and the banding case — a subtle gradient through 20
 *                        stacked 5 % layers.
 *   native-overlays-*    the viewport grid / subdivisions / proportional grid in
 *                        each grid style (OverlayPass).
 *   native-viewer-lut-*  a 3D and a 1D viewer LUT on the final blit (scene-blit-lut).
 *
 * All `fidelityOnly`: there is no reference PNG — WebGL2 has no 32-bpc blend,
 * and overlays / the viewer LUT are viewport chrome, never exported. The gate is
 * C++ vs TS on the same machine.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 160, height: 120, background: '#000000' };
const SIZE = { w: 160, h: 120 };

type G = Parameters<Scene['build']>[0];

function rect(graph: G, id: string, x: number, y: number, w: number, h: number, fill: string, opacity = 100): void {
  graph.addNode(node(id, {
    kind: 'shape',
    position: { x, y },
    transform: { width: w, height: h, shapeType: 'rect' },
    style: { fill, opacity },
  }));
}

function gradientBase(graph: G): void {
  graph.addNode(node('base', { kind: 'shape', style: { fill: '#000' } }));
  graph.setSolid('base', true);
  graph.setFill('base', {
    type: 'linear',
    angle: 30,
    stops: [
      { id: 'a', offset: 0, color: '#203060' },
      { id: 'b', offset: 0.5, color: '#c04070' },
      { id: 'c', offset: 1, color: '#f0d060' },
    ],
  } as never);
}

/** A 3D .cube: a warm grade (r·1.1 + 0.05, g, b·0.8), size 2 (trilinear between corners). */
function warmCube(): string {
  const lines = ['TITLE "native-parity warm"', 'LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) {
    for (let g = 0; g < 2; g++) {
      for (let r = 0; r < 2; r++) lines.push(`${Math.min(1, r * 1.1 + 0.05).toFixed(6)} ${g.toFixed(6)} ${(b * 0.8).toFixed(6)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A 1D .cube: a contrast curve, 5 entries. */
function contrastCube1d(): string {
  const ys = [0, 0.15, 0.5, 0.85, 1];
  return `TITLE "native-parity contrast"\nLUT_1D_SIZE ${ys.length}\n${ys.map((y) => `${y} ${y} ${y}`).join('\n')}\n`;
}

const hdr = defineScene({
  id: 'native-float32-hdr',
  description: '32 bpc: three white squares ADDED (3.0), blurred, then multiplied by a dark grey — over-range light survives and clips only at output.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  fidelityOnly: true,
  nativeSetup: { bitDepth: 32 },
  build(graph) {
    rect(graph, 'a', 70, 60, 70, 60, '#ffffff');
    rect(graph, 'b', 90, 60, 70, 60, '#ffffff');
    graph.setBlendMode('b', 'add');
    rect(graph, 'c', 80, 70, 60, 40, '#ffffff');
    graph.setBlendMode('c', 'add');
    graph.setEffects('c', [{ id: 'fx', type: 'blur', params: { amount: 6 } }] as never);
    // 3.0 × (#303030 → linear 0.03) ≈ 0.09: visible only if the 3.0 was kept.
    rect(graph, 'dim', 80, 60, 160, 120, '#303030');
    graph.setBlendMode('dim', 'multiply');
  },
});

const effects32 = defineScene({
  id: 'native-float32-effects',
  description: '32 bpc: glow, drop shadow and screen/overlay blends on a gradient — the float32 path through the effect chain and the backdrop combine.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  fidelityOnly: true,
  nativeSetup: { bitDepth: 32 },
  build(graph) {
    gradientBase(graph);
    graph.addNode(node('orb', {
      kind: 'shape',
      position: { x: 60, y: 60 },
      transform: { width: 60, height: 60, shapeType: 'ellipse' },
      style: { fill: '#ffe0a0' },
    }));
    graph.setBlendMode('orb', 'screen');
    graph.setEffects('orb', [{ id: 'fx', type: 'glow', params: { radius: 12, color: '#78b4ff', intensity: 90 } }] as never);
    rect(graph, 'card', 110, 64, 50, 50, '#6f8fa8');
    graph.setBlendMode('card', 'overlay');
    graph.setEffects('card', [{ id: 'fx', type: 'drop-shadow', params: { distance: 6, angle: 135, softness: 10, color: '#000000', opacity: 60 } }] as never);
  },
});

const banding = defineScene({
  id: 'native-float32-banding',
  description: '32 bpc: a subtle 4-level gradient through 20 stacked 5 % layers — no banding from intermediate rounding.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  fidelityOnly: true,
  nativeSetup: { bitDepth: 32 },
  build(graph) {
    for (let i = 0; i < 20; i++) {
      const id = `band${i}`;
      graph.addNode(node(id, { kind: 'shape', style: { fill: '#000', opacity: 5 } }));
      graph.setSolid(id, true);
      graph.setFill(id, {
        type: 'linear',
        angle: 0,
        stops: [
          { id: 'a', offset: 0, color: '#2a2a2a' },
          { id: 'b', offset: 1, color: '#2e2e2e' },
        ],
      } as never);
    }
  },
});

function overlayScene(id: string, gridStyle: 'lines' | 'dashed' | 'dots'): Scene {
  return defineScene({
    id,
    description: `Viewport overlays: grid (${gridStyle}, 4 subdivisions) + a 3×3 proportional grid over a gradient.`,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    fidelityOnly: true,
    nativeSetup: {
      overlays: {
        grid: true,
        gridSpacing: 40,
        gridSubdivisions: 4,
        gridStyle,
        gridColor: '#ff5050c0',
        proportionalGrid: true,
        proportionalColumns: 3,
        proportionalRows: 3,
      },
    },
    build: gradientBase,
  });
}

function viewerLutScene(id: string, cube: string, what: string): Scene {
  return defineScene({
    id,
    description: `Viewer LUT (${what}) on the final blit, after the display transform.`,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    fidelityOnly: true,
    nativeSetup: { viewerLutCube: cube },
    build: gradientBase,
  });
}

export const nativeParityScenes: Scene[] = [
  hdr,
  effects32,
  banding,
  overlayScene('native-overlays-lines', 'lines'),
  overlayScene('native-overlays-dashed', 'dashed'),
  overlayScene('native-overlays-dots', 'dots'),
  viewerLutScene('native-viewer-lut-3d', warmCube(), '3D, size 2'),
  viewerLutScene('native-viewer-lut-1d', contrastCube1d(), '1D, 5 entries'),
];
