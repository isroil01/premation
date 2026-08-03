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
 * REGISTERED as of the F10/F12 fix. (Was parked; see the history below.)
 *
 * This is the scene that proves Alpha Add does the one thing it exists for:
 * two 50%-alpha rectangles sharing a strip. Under standard alpha
 * (as + ad − as·ad) two 50% coverages resolve to 75% (191), leaving the join
 * visibly lighter than solid; Alpha Add sums them to 100% (255).
 *
 * The rectangles OVERLAP by 10px rather than merely touching. As first written
 * they abutted exactly at x=150, which leaves no pixel where both layers
 * contribute — so there was nothing for Alpha Add to sum, and the scene
 * measured 128 across the field with a coverage dip to 108 at the join. It
 * would have rendered, looked plausible, and certified nothing. That went
 * unnoticed because F10 meant the scene could never be run at all; fixing the
 * determinism bug is what made the scene's own defect visible.
 *
 * 255 is the load-bearing number: two 50% coverages can only reach full opacity
 * by ADDITION. Standard alpha cannot exceed 191 here, so the value alone
 * distinguishes the two composite rules without needing a control render.
 *
 * Demonstrating that requires a TRANSPARENT comp, because over an opaque
 * background the read-back alpha is 255 everywhere and the scene would render,
 * look plausible, and certify nothing.
 *
 * On a transparent comp this scene used to trip the determinism gate on both
 * backends, which is what F10 recorded and why it sat here unregistered. The
 * cause was never Alpha Add: `EffectPass` blitted the scene target onto the
 * surface with source-over while `ClearPass` cleared the scene target instead
 * of the surface, so any partial alpha in the final composite accumulated
 * against the previous frame. Fixed by making that blit replace rather than
 * blend — see EffectPass.ts.
 */
export const alphaAddSeamScene: Scene = defineScene({
  id: 'blend-alpha-add-seam',
  description: 'Alpha Add closes the seam where two 50%-alpha rectangles abut.',
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
    // Spans 140..260, so it overlaps the left rect's 30..150 across 140..150.
    graph.addNode(node('r', {
      kind: 'shape',
      position: { x: 200, y: 110 },
      transform: { width: 120, height: 140 },
      style: { fill: '#ffffff', opacity: 50 },
    }));
    graph.setBlendMode('r', 'alpha-add');
  },
});

/**
 * The Matte family (M8c). Registered as of the F10/F12 fix.
 *
 * These four were the scenes that widened F10 into F12: they use an OPAQUE comp
 * (#101014) and still failed the determinism gate, because the transparency was
 * produced by the blend itself rather than supplied by the comp. That ruled out
 * "transparent comp" as the trigger and pointed at partial alpha in the final
 * composite, which is what led to the EffectPass source-over blit.
 *
 * They are a strong regression test for that fix precisely because the two
 * variants stress different amounts of it: the Alpha modes leave partial alpha
 * only on the ellipse's anti-aliased rim (~1250 px), while the Luma modes scale
 * the whole interior by the matte's brightness and so leave ~25 700 px partial.
 * A partial fix that only settled the rim would still fail the Luma pair.
 *
 * The generator is kept separate from MODES for a second reason that still
 * holds: an ordinary blend is judged on the colour INSIDE the ellipse, whereas
 * a stencil is judged on what survives OUTSIDE it.
 */
const MATTE_MODES = ['stencil-alpha', 'stencil-luma', 'silhouette-alpha', 'silhouette-luma'] as const;

function matteScene(mode: string): Scene {
  return defineScene({
    id: `blend-${mode}`,
    description: `Matte mode "${mode}": an ellipse mattes the gradient beneath it.`,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: 'expect-pass',
    build(graph) {
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
      // The matte layer. Its fill is a mid grey on purpose: Stencil Alpha keeps
      // the backdrop at full strength inside it (alpha 1), while Stencil Luma
      // scales by its brightness — so the two are only distinguishable when the
      // matte is neither black nor white.
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

/** Registered via registry.ts alongside `blendModeScenes`. */
export const matteModeScenes: Scene[] = MATTE_MODES.map(matteScene);

export const blendModeScenes: Scene[] = MODES.map(blendScene);
