/**
 * Compositing family: track mattes, masks, adjustment layers, layer styles.
 * These exercise the multi-layer composite paths (matte pairing, mask geometry,
 * adjustment-below, CSS-filter layer styles).
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { rectangleMask, ellipseMask } from '@core/effects/mask';

const COMP = { width: 320, height: 220, background: '#0c0c12' };
const SIZE = { w: 320, h: 220 };

function scene(id: string, description: string, build: Scene['build'], frames: number[] = [0], gpuParity: Scene['gpuParity'] = 'expect-pass'): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames, gpuParity, build });
}

/** Comp-filling gradient content node (the thing being matted/masked). */
function gradientContent(graph: Parameters<Scene['build']>[0], id: string): void {
  graph.addNode(node(id, { kind: 'shape', style: { fill: '#000' } }));
  graph.setSolid(id, true);
  graph.setFill(id, {
    type: 'linear',
    angle: 45,
    stops: [
      { id: 'a', offset: 0, color: '#1030ff' },
      { id: 'b', offset: 0.5, color: '#ff2d55' },
      { id: 'c', offset: 1, color: '#ffd000' },
    ],
  } as never);
}

// ── Mattes: matted layer first (below), source next (above) ──────────
function matteScene(id: string, mode: string, description: string): Scene {
  return scene(id, description, (graph) => {
    gradientContent(graph, 'matted');
    graph.addNode(node('src', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 200, height: 160, shapeType: 'ellipse' },
      // A vertical white→black gradient so luma vs alpha differ visibly.
      style: { fill: '#ffffff' },
    }));
    graph.setFill('src', {
      type: 'linear',
      angle: 90,
      stops: [
        { id: 'a', offset: 0, color: '#ffffff' },
        { id: 'b', offset: 1, color: '#202020' },
      ],
    } as never);
    graph.setMatte('matted', mode);
  });
}

export const compositedScenes: Scene[] = [
  matteScene('matte-alpha', 'alpha', 'Alpha track matte (ellipse source over gradient).'),
  matteScene('matte-alpha-inv', 'alpha-inv', 'Inverted alpha track matte.'),
  matteScene('matte-luma', 'luma', 'Luma track matte (white→black gradient source).'),
  matteScene('matte-luma-inv', 'luma-inv', 'Inverted luma track matte.'),

  scene('mask-add', 'Rectangular mask, add mode.', (graph) => {
    gradientContent(graph, 'm');
    graph.setMask('m', { paths: [{ ...rectangleMask(200, 130), mode: 'add' }] });
  }),
  scene('mask-subtract', 'Rectangular mask, subtract mode.', (graph) => {
    gradientContent(graph, 'm');
    graph.setMask('m', { paths: [{ ...rectangleMask(200, 130), mode: 'subtract' }] });
  }),
  scene('mask-intersect', 'Two overlapping masks, intersect.', (graph) => {
    gradientContent(graph, 'm');
    graph.setMask('m', {
      paths: [
        { ...rectangleMask(220, 120), mode: 'add' },
        { ...ellipseMask(160, 200), mode: 'intersect' },
      ],
    });
  }),
  scene('mask-feather', 'Feathered ellipse mask.', (graph) => {
    gradientContent(graph, 'm');
    graph.setMask('m', { paths: [{ ...ellipseMask(200, 150), mode: 'add', feather: 28 }] });
  }, [0], 'known-divergent'),
  scene('mask-animated', 'Animated mask, sampled mid-interpolation (t=0.5).', (graph) => {
    gradientContent(graph, 'm');
    graph.setMaskAnim('m', [
      { t: 0, mask: { paths: [ellipseMask(120, 120)] } },
      { t: 1, mask: { paths: [ellipseMask(260, 200)] } },
    ]);
  }, [15]),

  scene('adjustment-hue-rotate', 'Adjustment layer (hue-rotate) over content below.', (graph) => {
    gradientContent(graph, 'content');
    graph.addNode(node('adj', { kind: 'shape', style: { opacity: 100 } }));
    graph.setSolid('adj', true);
    graph.setAdjustment('adj', true);
    graph.setEffects('adj', [{ id: 'a1', type: 'hue-rotate', params: { amount: 140 } }]);
  }),

  scene('layer-styles', 'Drop shadow + outer glow layer styles on a shape.', (graph) => {
    graph.addNode(node('s', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 170, height: 120, shapeType: 'rect', cornerRadius: 18 },
      style: { fill: '#ff8a3d' },
    }));
    graph.setLayerStyles('s', {
      dropShadow: { enabled: true, color: '#000000', opacity: 0.6, distance: 12, angle: 90, blur: 10 },
      outerGlow: { enabled: true, color: '#78b4ff', opacity: 0.9, size: 18 },
    });
  }, [0], 'known-divergent'),
];
