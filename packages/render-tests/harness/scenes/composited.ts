/**
 * Compositing family: track mattes, masks, adjustment layers, layer styles.
 * These exercise the multi-layer composite paths (matte pairing, mask geometry,
 * adjustment-below, GPU layer styles). Soft-edge scenes (`mask-feather`,
 * `layer-styles`) gate against WebGL2 goldens after the CSS-sigma blur kernel
 * exit — see `blur-hard-edge` and `cssBlurKernel.test.ts`.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { rectangleMask, ellipseMask } from '@core/effects/mask';

const COMP = { width: 320, height: 220, background: '#0c0c12' };
const SIZE = { w: 320, h: 220 };

function scene(
  id: string,
  description: string,
  build: Scene['build'],
  frames: number[] = [0],
  gpuParity: Scene['gpuParity'] = 'expect-pass',
  divergence?: Scene['divergence'],
): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames, gpuParity, divergence, build });
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

/**
 * M6 — an effect scoped to a mask region.
 *
 * The subject is a comp-filling gradient carrying ONE mask path in mode `none`
 * (geometry, not a cut — see mask.ts) covering the left half, and a strong
 * hue-rotate scoped to it.
 *
 * What the image must show, and what a golden alone would not tell you:
 *   • the LEFT half is hue-shifted, the RIGHT half is not — the scope works;
 *   • the layer's ALPHA is uniform across BOTH halves — the effect mask decided
 *     where the effect applies and did NOT cut the layer. That is the invariant
 *     separating an effect mask from a second layer mask, and it is the thing
 *     most likely to regress silently, because a cut layer over a dark comp
 *     still looks like a plausible picture.
 */
function effectScopedMaskScene(): Scene {
  return scene(
    'effect-scoped-mask',
    'Hue-rotate scoped to a left-half mask; layer alpha must stay uniform.',
    (graph) => {
      gradientContent(graph, 'm');
      graph.setMask('m', {
        paths: [{ ...rectangleMask(160, 220), id: 'scope', mode: 'none', points: rectangleMask(160, 220).points.map((pt) => ({ ...pt, x: pt.x - 80 })) }],
      });
      graph.setEffects('m', [
        { id: 'fx', type: 'hue-rotate', params: { amount: 160 }, maskId: 'scope' },
      ]);
    },
  );
}

export const compositedScenes: Scene[] = [
  effectScopedMaskScene(),

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
  /**
   * Soft mask edge. Was `known-divergent` while the GPU blur kernel used
   * σ = r/2 (tighter than CSS). Kernel reconciled to CSS semantics (σ = r,
   * ±2.5σ) — see `cssBlurKernel.test.ts` + `blur-hard-edge`. Reference is
   * GPU-blessed; gated as expect-pass.
   */
  scene('mask-feather', 'Feathered ellipse mask.', (graph) => {
    gradientContent(graph, 'm');
    graph.setMask('m', { paths: [{ ...ellipseMask(200, 150), mode: 'add', feather: 28 }] });
  }),
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

  /**
   * Adjustment ABOVE a track-matte pair.
   *
   * Paint order (back→front): matted gradient → ellipse matte source →
   * hue-rotate adjustment. The grade must see the ALREADY-MATTED composite
   * (ellipse-shaped gradient, hue-shifted). Regressions that this catches:
   *   • adjustment samples before the matte combine → full-frame grade, no cut;
   *   • matte source is graded as content → wrong silhouette colour;
   *   • adjustment skips the matted layer → ellipse of ungraded gradient.
   */
  defineScene({
    id: 'adjustment-over-matte',
    description: 'Hue-rotate adjustment over an alpha-matted gradient (ellipse cut).',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    gpuParity: 'expect-pass',
    build(graph) {
      gradientContent(graph, 'matted');
      graph.addNode(node('src', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 200, height: 160, shapeType: 'ellipse' },
        style: { fill: '#ffffff' },
      }));
      graph.setMatte('matted', 'alpha');
      graph.addNode(node('adj', { kind: 'shape', style: { opacity: 100 } }));
      graph.setSolid('adj', true);
      graph.setAdjustment('adj', true);
      graph.setEffects('adj', [{ id: 'a1', type: 'hue-rotate', params: { amount: 140 } }]);
    },
  }),

  /**
   * Preserve Underlying Transparency (AE's "T" switch).
   *
   * Comp is TRANSPARENT so holes in the backdrop really have ad=0. An opaque
   * clear makes Multiply look "clipped" without PUT (dark×source ≈ invisible),
   * which is why this scene must not sit on a solid background plate.
   *
   * Magenta rect over a cyan ellipse: with PUT the rect is source-atop the
   * ellipse's coverage — corners stay empty. Without PUT the rect paints them.
   */
  defineScene({
    id: 'preserve-transparency',
    description: 'Preserve Underlying Transparency: magenta rect clipped to cyan ellipse alpha.',
    size: SIZE,
    comp: { ...COMP, background: '#000000', transparent: true },
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    gpuParity: 'expect-pass',
    build(graph) {
      graph.addNode(node('base', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 200, height: 160, shapeType: 'ellipse' },
        style: { fill: '#1ec8ff' },
      }));
      graph.addNode(node('top', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 280, height: 180, shapeType: 'rect' },
        style: { fill: '#ff2d55' },
      }));
      graph.setFxKey('top', 'preserveTransparency', true);
    },
  }),

  /**
   * Multiply AND Preserve Transparency — the composed state users want.
   * Transparent comp so Multiply alone would leave BRIGHT blue in the corners
   * (source over empty alpha); PUT must clear those corners.
   */
  defineScene({
    id: 'preserve-transparency-multiply',
    description: 'Multiply + Preserve Transparency: blend only inside underlying coverage.',
    size: SIZE,
    comp: { ...COMP, background: '#000000', transparent: true },
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    gpuParity: 'expect-pass',
    build(graph) {
      graph.addNode(node('base', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 200, height: 160, shapeType: 'ellipse' },
        style: { fill: '#ffffff' },
      }));
      graph.addNode(node('top', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 280, height: 180, shapeType: 'rect' },
        style: { fill: '#4060ff' },
      }));
      graph.setBlendMode('top', 'multiply');
      graph.setFxKey('top', 'preserveTransparency', true);
    },
  }),

  /**
   * Drop shadow + outer glow. Same blur-kernel exit as `mask-feather` —
   * GPU CSS-sigma kernel proven; reference re-blessed from WebGL2.
   */
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
  }),

  /**
   * Hard-edge blur isolation — the comparison `mask-feather` / `layer-styles`
   * used to demand before exiting known-divergent. One opaque rect, one blur,
   * no feathered sources or stacked styles. Soft ramp must come only from the
   * CSS-sigma GPU kernel (`packages/renderer` cssBlurKernel.test.ts).
   */
  defineScene({
    id: 'blur-hard-edge',
    description: 'Gaussian blur on a hard-edged rect — kernel isolation, no soft source.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    gpuParity: 'expect-pass',
    build(graph) {
      graph.addNode(node('s', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 140, height: 100, shapeType: 'rect' },
        style: { fill: '#ffffff' },
      }));
      graph.setEffects('s', [{ id: 'b', type: 'blur', params: { amount: 12 } }]);
    },
  }),
];
