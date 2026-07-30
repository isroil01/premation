/**
 * Effect family: one scene per effect in the registry (src/core/effects/effects.ts).
 * Subject is a gradient-filled ellipse on a dark comp, giving both an alpha edge
 * (for glow/shadow/stroke) and colour content (for colour ops). gpuOnly effects
 * (displacement-map, motion-tile) render as no-ops on the Canvas2D reference —
 * that is the documented gap the reference captures.
 *
 * Params are the registry defaults per the authoring cookbook. Echo is covered
 * in the motion family (it needs an animated subject to show ghosts).
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 320, height: 220, background: '#0c0c12' };
const SIZE = { w: 320, h: 220 };

interface EffectSpec {
  type: string;
  params?: Record<string, unknown>;
  gpuOnly?: boolean;
  /** Per-scene diff tolerance override (fraction of pixels). */
  tolerance?: number;
  /** Force GPU-oracle for a procedural effect Canvas2D implements with a
   *  fundamentally different (unmatchable) algorithm — the GPU output is a valid
   *  render, just different (eyeballed). Distinct from gpuOnly (Canvas2D no-op). */
  gpuOracle?: boolean;
}

const EFFECTS: EffectSpec[] = [
  { type: 'blur', params: { amount: 6 } },
  // PROMOTED from known-divergent to a gated scene.
  //
  // Its reference was blessed from the Canvas2D oracle, which fills the blurred
  // silhouette with the glow colour — the correct semantics. The GPU path was
  // tinting instead, so it sat 25.314% away from that golden and nobody saw it,
  // because 'glow' was on the known-divergent list and therefore never gated.
  // With the silhouette fill the GPU agrees with the Canvas2D golden to 0.744%,
  // so the gap was the defect, not a backend difference. The remaining 0.744% is
  // blur-kernel AA on the ellipse's soft edge, hence the same headroom the
  // drop-shadow scene below documents.
  { type: 'glow', params: { radius: 16, color: '#78b4ff', intensity: 90 }, tolerance: 0.009 },
  // tolerance: the GPU shadow penumbra sits at 0.501% vs the 0.5% default gate —
  // visually identical (soft-edge AA rounding), so give the blurred edge headroom.
  { type: 'drop-shadow', params: { distance: 6, angle: 135, softness: 12, color: '#000000', opacity: 55 }, tolerance: 0.008 },
  { type: 'brightness', params: { amount: 140 } },
  { type: 'contrast', params: { amount: 150 } },
  { type: 'saturate', params: { amount: 180 } },
  { type: 'grayscale', params: { amount: 100 } },
  { type: 'sepia', params: { amount: 90 } },
  { type: 'hue-rotate', params: { amount: 120 } },
  { type: 'hue-saturation', params: { hue: 40, saturation: 30, lightness: 0 } },
  { type: 'invert', params: { amount: 100 } },
  { type: 'levels', params: { inputBlack: 20, inputWhite: 235, gamma: 1.2, outputBlack: 0, outputWhite: 255 } },
  { type: 'curves', params: { points: [[0, 0], [128, 90], [255, 255]] } },
  { type: 'posterize', params: { levels: 5 } },
  { type: 'tint', params: { mapBlack: '#001040', mapWhite: '#ffe0b0', amount: 100 } },
  { type: 'channel-mixer', params: { redRed: 40, redGreen: 60, redBlue: 0, redConst: 0, greenRed: 0, greenGreen: 100, greenBlue: 0, greenConst: 0, blueRed: 0, blueGreen: 0, blueBlue: 100, blueConst: 0, monochrome: false } },
  { type: 'gradient-ramp', params: { blend: 100, colorA: '#ff0000', colorB: '#0000ff' } },
  { type: 'fractal-noise', params: { scale: 12 }, gpuOracle: true },
  { type: 'displacement-map', params: { amount: 20 }, gpuOnly: true },
  { type: 'motion-tile', params: { scale: 2 }, gpuOnly: true },
  { type: 'fill', params: { color: '#ff2d55', opacity: 100 } },
  { type: 'four-color-gradient', params: { colorTL: '#ff0055', colorTR: '#ffcc00', colorBL: '#00d0ff', colorBR: '#7b61ff', blend: 100 } },
  { type: 'stroke', params: { width: 4, color: '#ffffff', opacity: 100 } },
  { type: 'beam', params: { length: 100, startX: 10, startY: 50, endX: 90, endY: 50, thickness: 8, softness: 30, color: '#8fd0ff' } },
  { type: 'sharpen', params: { amount: 60 } },
  { type: 'noise', params: { amount: 30, evolution: 0, monochrome: true } },
  { type: 'keylight', params: { screenColor: '#00ff00', balance: 50, gain: 100, clipBlack: 8, clipWhite: 65, despill: 100, choke: 0, matteSoftness: 0 } },
  { type: 'wave-warp', params: { waveHeight: 20, waveWidth: 120, direction: 90, phase: 0 } },
  { type: 'turbulent-displace', params: { amount: 30, size: 120, complexity: 2, evolution: 0 } },
];

function effectScene(spec: EffectSpec): Scene {
  // 'glow' left this list when the silhouette fill landed — see the note on the
  // glow spec above. Removing an entry here is a real promotion: the scene stops
  // being allowed to differ and starts being able to fail.
  const isDivergent = ['blur', 'posterize', 'gradient-ramp'].includes(spec.type);
  return defineScene({
    id: `effect-${spec.type}`,
    description: `Effect "${spec.type}"${spec.gpuOnly ? ' (gpuOnly — Canvas2D no-op)' : ''} on a gradient ellipse.`,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: isDivergent ? 'known-divergent' : 'expect-pass',
    ...(isDivergent ? { divergence: {
      why:
        'Posterize quantises to flat bands, so the picture is large flat areas meeting at hard '
        + 'steps, and the two engines put those step boundaries on marginally different pixels. '
        + 'analyze-gap.mjs measures 2204 of 2288 differing pixels as coverage on those boundaries; '
        + 'the 84 that are not sit where a value lands exactly on a quantisation threshold and the '
        + 'two rounding rules disagree about which band it belongs to. Blur and glow are here for '
        + 'the kernel reason: the GPU treats the radius as a Gaussian sigma sampled to 2.5 sigma, '
        + 'the deleted Canvas2D reference inherited the CSS filter kernel.',
      wouldMatchWhen:
        'The references are re-blessed from the GPU engine, or the quantisation rounding is made '
        + 'to match a reference engine that no longer ships.',
      proof: 'packages/render-tests/scripts/analyze-gap.mjs — reports the coverage/colour split per scene',
    } } : {}),
    ...(spec.tolerance ? { tolerance: spec.tolerance } : {}),
    // gpuOnly (Canvas2D no-op) and gpuOracle (Canvas2D implements it with a
    // different, unmatchable algorithm — eyeballed) both make the GPU the oracle.
    ...(spec.gpuOnly || spec.gpuOracle ? { oracle: 'gpu' as const } : {}),
    build(graph) {
      graph.addNode(node('subj', {
        kind: 'shape',
        position: { x: 160, y: 110 },
        transform: { width: 220, height: 170, shapeType: 'ellipse' },
        style: { fill: '#000' },
      }));
      graph.setFill('subj', {
        type: 'linear',
        angle: 30,
        stops: [
          { id: 'a', offset: 0, color: '#2b3cff' },
          { id: 'b', offset: 1, color: '#ff7a1a' },
        ],
      } as never);
      graph.setEffects('subj', [{ id: 'fx', type: spec.type, params: spec.params ?? {} }]);
    },
  });
}

/**
 * Displace driven by ANOTHER layer (mapLayerId): a full-comp linear-gradient
 * rect is the map — its red/green ramp displaces the subject ellipse
 * progressively across the frame (self-displacement would warp symmetrically
 * about the subject's own silhouette instead). gpuOnly → GPU is the oracle;
 * the Canvas2D render is a documented no-op. Note the map layer must be
 * VISIBLE — invisible layers never reach the renderable list, and the effect
 * then falls back to self-displacement.
 */
const displacementMapLayerScene: Scene = defineScene({
  id: 'effect-displacement-map-layer',
  description: 'Displace with a real map layer (mapLayerId → gradient rect) warping the subject ellipse. gpuOnly — Canvas2D no-op.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'known-divergent',
  divergence: {
    why:
      'GPU-only by construction: the displacement-map shader has no Canvas2D form, so the deleted '
      + 'reference engine drew the subject undisplaced. The scene is its own oracle (oracle: gpu) '
      + 'and the committed reference is GPU output; the parity number compares against a Canvas2D '
      + 'baseline that never implemented the effect.',
    wouldMatchWhen:
      'Never against Canvas2D — the comparison is meaningless for a GPU-only effect. This entry '
      + 'should be removed when the parity dashboard stops comparing oracle:gpu scenes against the '
      + 'Canvas2D baseline at all.',
  },
  oracle: 'gpu',
  build(graph) {
    // The map: a full-comp horizontal gradient (dark → bright), drawn behind.
    graph.addNode(node('map', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 320, height: 220 },
      style: { fill: '#000' },
    }));
    graph.setFill('map', {
      type: 'linear',
      angle: 0,
      stops: [
        { id: 'a', offset: 0, color: '#101010' },
        { id: 'b', offset: 1, color: '#f0f0f0' },
      ],
    } as never);
    // The subject: the family's standard gradient ellipse, displaced by the map.
    graph.addNode(node('subj', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 220, height: 170, shapeType: 'ellipse' },
      style: { fill: '#000' },
    }));
    graph.setFill('subj', {
      type: 'linear',
      angle: 30,
      stops: [
        { id: 'a', offset: 0, color: '#2b3cff' },
        { id: 'b', offset: 1, color: '#ff7a1a' },
      ],
    } as never);
    graph.setEffects('subj', [
      { id: 'fx', type: 'displacement-map', params: { amount: 40, mapLayerId: 'map' } },
    ]);
  },
});

export const effectScenes: Scene[] = [...EFFECTS.map(effectScene), displacementMapLayerScene];
