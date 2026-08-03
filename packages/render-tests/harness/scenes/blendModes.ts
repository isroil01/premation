/**
 * Blend-mode family: one scene per LayerBlendMode (32 total, per
 * src/core/effects/blendMode.ts). A colourful gradient base with a
 * mid-tone ellipse on top carrying the blend mode — chosen so every mode
 * produces a visibly distinct composite.
 *
 * The base gradient runs blue → red → yellow and the ellipse is a desaturated
 * mid-tone, which matters for the M1 modes specifically: Vivid Light, Hard Mix
 * and the Classic (unclamped) variants only separate from their modern
 * counterparts where a channel is driven past 0 or 1, and a mid-tone source over
 * a saturated backdrop is what drives them there. A grey-on-grey scene would
 * render several of these identically and certify nothing.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 320, height: 220, background: '#101014' };
const SIZE = { w: 320, h: 220 };

// All 30, in menu order (blendMode.ts BLEND_MODES). 'normal' is the default.
const MODES = [
  'normal',
  // Subtractive
  'darken', 'multiply', 'color-burn', 'classic-color-burn', 'linear-burn', 'darker-color',
  // Additive
  'add', 'lighten', 'screen', 'color-dodge', 'classic-color-dodge', 'linear-dodge', 'lighter-color',
  // Complex
  'overlay', 'soft-light', 'hard-light', 'linear-light', 'vivid-light', 'pin-light', 'hard-mix',
  // Difference
  'difference', 'classic-difference', 'exclusion', 'subtract', 'divide',
  // HSL
  'hue', 'saturation', 'color', 'luminosity',
  // Utility — these write alpha. The ellipse scene shows they composite; the
  // property that MATTERS for Alpha Add (seam closure) needs its own scene,
  // below, because a single opaque ellipse has no seam to close.
  'alpha-add', 'luminescent-premul',
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
    // Measured, not assumed. scripts/analyze-gap.mjs classifies every differing
    // pixel in all thirteen of these as SUB-PIXEL COVERAGE, and decomposing by
    // geometry agrees: of ~1000 differing pixels the ellipse's interior
    // contributes 0 and the area outside it 0 — they sit entirely on the rim,
    // and the centre pixel matches the reference exactly.
    divergence: {
      why:
        'The subject is an ellipse, and the two engines resolve its rim differently: the GPU '
        + 'evaluates an analytic SDF per fragment, the deleted Canvas2D reference used a scanline '
        + 'rasterizer with its own coverage rule. The blend maths is NOT implicated — the ellipse '
        + 'interior and the background are pixel-identical in every mode, including `normal`, and '
        + 'the shared gradient base scores 0 differing pixels on its own scene '
        + '(`linear-gradient-fill`). Only the ~1000 rim pixels disagree, by an amount that stays '
        + 'inside the range the reference itself spans across that rim.',
      wouldMatchWhen:
        'The references are re-blessed from the GPU engine. Canvas2D was deleted, so these '
        + 'reference PNGs are frozen output of an engine that no longer ships; the coverage rule '
        + 'they encode cannot be matched, only replaced. Blessing must wait until each scene is '
        + 'verified correct on its own terms — a golden blessed over a defect certifies it.',
      proof: 'packages/render-tests/scripts/analyze-gap.mjs — reports coverage-only, 0 flat-region pixels',
    },
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

/**
 * NOT SHIPPED — see F10. Kept as source, deliberately not registered.
 *
 * This is the scene that would prove Alpha Add does the one thing it exists for:
 * two 50%-alpha rectangles abutting along a shared edge. Under standard alpha
 * (as + ad − as·ad) two touching 50% edges resolve to 75%, leaving a visible
 * seam down the join; Alpha Add sums them and closes it to 100%.
 *
 * Demonstrating that requires a TRANSPARENT comp, because over an opaque
 * background the read-back alpha is 255 everywhere and the scene would render,
 * look plausible, and certify nothing.
 *
 * And on a transparent comp the existing determinism gate fires:
 *
 *   blend-alpha-add-seam#0 [webgl2] double-render bytes differ
 *   blend-alpha-add-seam#0 [webgpu] double-render bytes differ
 *
 * That is NOT Alpha Add — swapping the mode to `multiply` reproduces it exactly.
 * Any advanced-blend mode over a transparent comp renders non-deterministically
 * on both backends. Registering this scene would put a flaky test in the gate,
 * and blessing it would bless one arbitrary sample of a non-deterministic
 * output. Both are worse than the coverage gap.
 *
 * Re-register it once F10 is fixed; the scene itself is believed correct.
 */
export const alphaAddSeamPending: Scene = defineScene({
  id: 'blend-alpha-add-seam',
  description: 'Alpha Add closes the seam where two 50%-alpha rectangles abut. (Pending F10.)',
  size: SIZE,
  comp: { width: 320, height: 220, background: '#101014', transparent: true },
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  build(graph) {
    graph.addNode(node('l', {
      kind: 'shape',
      position: { x: 90, y: 110 },
      transform: { width: 120, height: 140 },
      style: { fill: '#ffffff', opacity: 50 },
    }));
    graph.addNode(node('r', {
      kind: 'shape',
      position: { x: 210, y: 110 },
      transform: { width: 120, height: 140 },
      style: { fill: '#ffffff', opacity: 50 },
    }));
    graph.setBlendMode('r', 'alpha-add');
  },
});

export const blendModeScenes: Scene[] = MODES.map(blendScene);
