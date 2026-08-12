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
  /*
    Bend. `gpuOnly` like its Distort neighbours above — it has no Canvas2D
    twin, so the reference captures a no-op and this scene gates the SHADER.

    Deliberately NOT the registry default, on two axes.

    140° rather than 60°, so all three regions of the map are in frame at once
    — the ramp-in, the arc, and the rigid rotation past Base. A sign flip in
    the inverse map then shows as a gross difference rather than a few percent
    at the border.

    And Top/Base dragged OFF the layer's centre line, which is the whole reason
    they are points: at rest they sit top-centre and bottom-centre, the bend
    line is exactly vertical, and both the off-centre placement and the aspect
    correction are unexercised. A diagonal, off-centre line gates them.

    Style 0 (Marilyn) is the one worth gating: its inverse is the cubic root,
    the only profile where an algebra error is not shared with the other two.
  */
  { type: 'bend', params: { amount: 140, style: 0, topX: -60, topY: 20, baseX: 40, baseY: -20 }, gpuOnly: true },
  /*
    Perspective family — all `gpuOnly`, so the reference captures a no-op and
    these scenes gate the shaders.

    Bevel Alpha is aimed at the subject's ELLIPSE edge (the alpha boundary) and
    Bevel Edges at the comp's rectangular frame, which is the entire difference
    between them — two scenes that looked alike would gate one behaviour twice.
    Thickness is exaggerated over the 4px default so the chamfer is more than
    an antialiasing ring.

    Spotlight's From is dragged OFF-FRAME entirely, aiming diagonally across
    the subject with a tight cone. At rest the lamp sits on the top edge aiming
    straight down, which exercises neither the off-frame placement nor the
    aspect correction — and with a wide centred cone most of the frame is lit,
    so a sign error in the angular term barely moves a pixel.
  */
  { type: 'bevel-alpha', params: { thickness: 12, lightAngle: -135, lightColor: '#ffffff', intensity: 120 }, gpuOnly: true },
  { type: 'bevel-edges', params: { thickness: 16, lightAngle: -135, lightColor: '#ffe0b0', intensity: 120 }, gpuOnly: true },
  { type: 'spotlight', params: { fromX: -90, fromY: -40, toX: 40, toY: 30, coneAngle: 50, edgeSoftness: 35, lightColor: '#ffffff', intensity: 220, ambient: 10 }, gpuOnly: true },
  /*
    Sphere and Cylinder are rotated OFF their identity pose on purpose. At
    rotation 0 the equirectangular lookup is symmetric about the centre, so a
    sign error in the inverse rotation — the one thing most likely to be wrong,
    since the shader rotates the normal backwards — produces a picture
    identical to the correct one. Rotating all three axes makes it asymmetric,
    and the non-square comp (320×220) means the silhouette is only circular if
    the aspect correction is applied.
  */
  { type: 'sphere', params: { radius: 95, rotateX: 25, rotateY: 35, rotateZ: 20, shading: 80, lightColor: '#ffffff' }, gpuOnly: true },
  { type: 'cylinder', params: { radius: 95, rotation: 40, shading: 80, lightColor: '#ffffff' }, gpuOnly: true },
  /*
    Arithmetic. Difference against a mid grey rather than Add against black:
    Add with the default 0,0,0 is the IDENTITY, so the scene would gate
    nothing. Difference also exercises the unpremultiply/repremultiply round
    trip at the ellipse's soft edge, where a premultiplied operand would show
    as a dark rim.
  */
  { type: 'arithmetic', params: { operator: 3, red: 128, green: 64, blue: 200, clip: true }, gpuOnly: true },
  { type: 'fill', params: { color: '#ff2d55', opacity: 100 } },
  { type: 'four-color-gradient', params: { colorTL: '#ff0055', colorTR: '#ffcc00', colorBL: '#00d0ff', colorBR: '#7b61ff', blend: 100 } },
  { type: 'stroke', params: { width: 4, color: '#ffffff', opacity: 100 } },
  { type: 'beam', params: { length: 100, startX: 10, startY: 50, endX: 90, endY: 50, thickness: 8, softness: 30, color: '#8fd0ff' } },
  /*
    Re-blessed when the 2D route stopped carrying its own copy of the effect
    switch — see "One effects chain, not two" in CompositionPass.

    Sharpen is `c * 5 - neighbourSum`, so just inside the ellipse's edge, where
    the neighbours one texel out are nearly transparent, it overshoots far past
    the layer's own alpha. That is a premultiplied colour with `rgb > a`, which
    is not a valid one.

    The old direct-to-scene-target draw let the overshoot through: it landed in
    the scene buffer where the opaque background had already brought alpha to 1,
    and the surface blit clamped it against 1 rather than against the layer's
    coverage — so a 12%-transparent pixel came out brighter than a fully opaque
    one could be. Compositing through the chain clamps it against the LAYER's
    alpha (`unpremultiplyingSample`: `min(rgb/a, 1) · a`), which is the
    invariant, and is what a matted or 3D copy of this same layer already did.

    ~1.5% of pixels, all in that one-texel ring, all in whichever channel was
    over range — the other two are bit-identical in every sample checked.
  */
  { type: 'sharpen', params: { amount: 60 } },
  { type: 'noise', params: { amount: 30, evolution: 0, monochrome: true } },
  { type: 'keylight', params: { screenColor: '#00ff00', balance: 50, gain: 100, clipBlack: 8, clipWhite: 65, despill: 100, choke: 0, matteSoftness: 0 } },
  { type: 'wave-warp', params: { waveHeight: 20, waveWidth: 120, direction: 90, phase: 0 } },
  { type: 'turbulent-displace', params: { amount: 30, size: 120, complexity: 2, evolution: 0 } },
  // ── Colour, round two ──────────────────────────────────────────────
  // Lumetri is a LUT effect, so it renders on BOTH backends with no bake and
  // must agree exactly — same class as levels/curves above. The temperature and
  // tint values are deliberately non-zero: they are the only two controls that
  // differ PER CHANNEL, so a scene with them at zero would pass even if the
  // per-channel table collapsed back to a single shared one.
  { type: 'lumetri', params: { exposure: 0.6, contrast: 30, highlights: -40, shadows: 45, whites: 0, blacks: -20, temperature: 55, tint: -25 } },
  // Both of these force the CPU bake, whose result both backends then composite,
  // so they are expect-pass rather than gpuOnly.
  //
  // The subject is a blue→orange gradient, so 'reds' (range 0) genuinely selects
  // part of the frame and leaves the rest alone — with a range that matched
  // nothing the scene would render identically to no effect at all and would
  // still pass, which is precisely the dead-scene failure this suite has had
  // before.
  { type: 'selective-color', params: { range: 0, cyan: -60, magenta: 30, yellow: 45, black: 20, absolute: true } },
  { type: 'shadow-highlight', params: { shadowAmount: 70, highlightAmount: 40, radius: 24, tonalWidth: 55 } },
  // ── Distort, round two ─────────────────────────────────────────────
  // All four force the CPU bake, so both backends composite the same baked
  // result and these are expect-pass.
  //
  // The centres are OFFSET from the layer centre, so a non-zero offset is what
  // proves the offset resolution is wired — a scene centred at 0,0 would render
  // identically whether the app resolved the offset or ignored it.
  { type: 'bulge', params: { centerX: -30, centerY: 10, radius: 90, height: 70 } },
  { type: 'twirl', params: { centerX: 20, centerY: -15, radius: 100, angle: 160 } },
  { type: 'spherize', params: { centerX: 0, centerY: 0, radius: 95, amount: 80 } },
  // Asymmetric offsets on all four corners: a symmetric pin would still be an
  // affine map, and would pass even if the projective solve collapsed to one.
  { type: 'corner-pin', params: { topLeftX: 40, topLeftY: 18, topRightX: -25, topRightY: 35, bottomRightX: -12, bottomRightY: -30, bottomLeftX: 30, bottomLeftY: -10 } },
  // ── Generate + Noise, round two ────────────────────────────────────
  // All six force the CPU bake, so both backends composite the same baked
  // result and these are expect-pass.
  //
  // Non-zero anchors on the two lattice generators: the anchor is modular, so a
  // scene at 0 would render identically whether the offset were wired or
  // dropped entirely.
  { type: 'checkerboard', params: { width: 28, height: 22, anchorX: 9, anchorY: 5, colorA: '#101828', colorB: '#f5c451', opacity: 100 } },
  { type: 'grid', params: { width: 34, height: 26, anchorX: 7, anchorY: 11, thickness: 3, color: '#7fe7ff', opacity: 100 } },
  // Crystalline ON, so the scene exercises the F2−F1 branch. With it off this
  // would render the blob field and pass even if `membrane` were ignored.
  { type: 'cell-pattern', params: { size: 34, evolution: 2.5, contrast: 140, membrane: true, invert: false } },
  { type: 'turbulent-noise', params: { scale: 60, complexity: 4, evolution: 1.5, contrast: 150, brightness: 10, invert: false } },
  // Grain on the gradient subject: its response varies across the ellipse, so
  // the golden captures the luminance dependence and not just "some noise".
  { type: 'add-grain', params: { intensity: 80, size: 2, saturation: 0, seed: 3 } },
  // `median` is deliberately NOT here — it needs a noisy subject to do anything
  // at all. See `medianDenoiseScene` below.
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

/**
 * Apply Color LUT, through the GPU strip lookup.
 *
 * ── Why this had to exist before the effect could be trusted ────────────────
 *
 * The effect moved from a Canvas2D per-pixel pass to a shader reading a LUT
 * packed as a strip texture, and the suite went green with no scene rendering
 * one — so nothing in the gate could tell a working lookup from a skipped one.
 * That is the hole the plugin effects sat in three times.
 *
 * ── The table is built to catch a TRANSPOSED strip ──────────────────────────
 *
 * A cube of edge N is uploaded as N slices of N×N side by side, and `.cube`
 * varies RED fastest. Pack it with red and blue swapped and the result is still
 * a plausible-looking grade — which is why this table is asymmetric in every
 * axis: red is squared, green mixes in blue, blue is inverted. Under a
 * transposition every one of those lands somewhere different.
 *
 * The subject is the family's blue→orange gradient ellipse, which sweeps two
 * channels at once, so a whole plane of the cube is exercised rather than a
 * line through it.
 */
const applyColorLutScene: Scene = defineScene({
  id: 'effect-apply-color-lut-gpu',
  description: 'Apply Color LUT via the GPU strip lookup — an asymmetric 5³ cube on a gradient ellipse.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  // GPU is the oracle: the Canvas2D pass still exists for baked layers, but it
  // is a different implementation and this scene gates the shader.
  // `cubeLutGpuParity.test.ts` is what holds the two to the same answer.
  oracle: 'gpu',
  build(graph) {
    const n = 5;
    const data: number[] = [];
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          const rf = r / (n - 1);
          const gf = g / (n - 1);
          const bf = b / (n - 1);
          data.push(rf * rf, gf * 0.5 + bf * 0.25, 1 - bf);
        }
      }
    }
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
    graph.setEffects('subj', [{
      id: 'fx',
      type: 'apply-color-lut',
      params: {
        intensity: 100,
        lut: {
          size: n,
          size1d: 0,
          data,
          domainMin: [0, 0, 0],
          domainMax: [1, 1, 1],
          title: 'render-test asymmetric',
        },
      },
    }]);
  },
});

/**
 * Compound Blur, on a subject that can actually SHOW a blur.
 *
 * ── The dead-scene trap this is built around ────────────────────────────────
 *
 * The family's standard subject is a smooth gradient ellipse, and blurring a
 * smooth gradient returns very nearly the same gradient. A golden of that would
 * pass whether the effect ran, no-oped, or was deleted — the same worthless
 * scene Median produced for the same reason, one effect further down this file.
 *
 * So the subject is a CHECKERBOARD: the highest spatial frequency available
 * here, where any blur is unmissable. Checkerboard is a CPU-baked generator and
 * Compound Blur is `gpuOnly`, so the stack also exercises the documented
 * pass-through — `extractSpatialEffects(layer, true)` carries GPU-only effects
 * past a bake that would otherwise drop them.
 *
 * ── Why the map is a gradient, and why that is the assertion ────────────────
 *
 * The map is a full-comp black→white horizontal ramp, so the SAME frame holds
 * every radius from zero to maximum. That is what makes the golden meaningful:
 * a compound blur that ignored its map and applied one uniform radius would
 * differ from this picture across most of the frame, and so would one that
 * inverted the ramp. A single-radius scene could not distinguish either.
 *
 * `oracle: 'gpu'` because there is no Canvas2D form — the effect reads a second
 * layer's pixels, which the bake chain has no way to resolve.
 */
const compoundBlurScene: Scene = defineScene({
  id: 'effect-compound-blur',
  description: 'Compound Blur: a checkerboard blurred by a gradient map — sharp at one edge, soft at the other.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  oracle: 'gpu',
  build(graph) {
    // The map, drawn FIRST so it sits behind and cannot occlude the subject.
    // It stays visible: an invisible layer never reaches the renderable list,
    // and the effect would silently fall back to self-blurring.
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
        { id: 'a', offset: 0, color: '#000000' },
        { id: 'b', offset: 1, color: '#ffffff' },
      ],
    } as never);

    graph.addNode(node('subj', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 260, height: 170, shapeType: 'rect' },
      style: { fill: '#101828' },
    }));
    graph.setEffects('subj', [
      // Fine checks: small enough that a 24px blur flattens them completely at
      // the bright end, large enough to survive intact at the dark end.
      { id: 'cb', type: 'checkerboard', params: { width: 10, height: 10, anchorX: 0, anchorY: 0, colorA: '#101828', colorB: '#f5c451', opacity: 100 } },
      { id: 'fx', type: 'compound-blur', params: { maxBlur: 30, blurLayerId: 'map', invert: 0 } },
    ]);
  },
});

/**
 * Median, on a subject that actually has something to denoise.
 *
 * ── Why this scene exists separately ────────────────────────────────────────
 *
 * Median first went in as an ordinary entry in EFFECTS, and its blessed
 * reference came back visually IDENTICAL to the ungraded gradient ellipse. That
 * is correct behaviour — a rank filter over a smooth gradient has no outliers to
 * discard — and it makes for a worthless golden: the scene would have passed
 * whether the filter ran, no-oped, or was deleted. A dead scene of exactly the
 * F15 kind, produced not by a broken call this time but by testing a denoiser on
 * material with no noise in it.
 *
 * Stacking Add Grain BEFORE Median gives the filter real speckle to remove, so
 * the golden records the removal. Break the median and the grain survives, which
 * moves a large fraction of the frame's pixels — a failure the diff cannot miss.
 *
 * The stack order is the test: these two are the only effects on the layer, and
 * reversing them would grain the smoothed image instead of smoothing the grained
 * one, which is a visibly different picture.
 */
const medianDenoiseScene: Scene = defineScene({
  id: 'effect-median-denoise',
  description: 'Median removing Add Grain speckle from a gradient ellipse (grain applied first).',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
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
    graph.setEffects('subj', [
      { id: 'grain', type: 'add-grain', params: { intensity: 90, size: 1, saturation: 0, seed: 7 } },
      { id: 'med', type: 'median', params: { radius: 3 } },
    ]);
  },
});


/**
 * Vegas, on a contour that a bounding box could not fake.
 *
 * ── Why this scene is NOT an entry in EFFECTS ─────────────────────────────
 *
 * Every other effect here is measured on the family's gradient ellipse. For
 * Vegas that would be the Median mistake in a new costume: an ellipse's alpha
 * boundary is smooth and convex, so lights running along it look exactly like
 * lights running along ANY smooth closed curve — including the one a
 * bounding-box shortcut would draw. The scene would pass whether the contour
 * came from marching squares or from `layer.width`/`layer.height`, which is
 * precisely the shortcut this effect was deferred rather than ship.
 *
 * A five-pointed STAR cannot be faked. Its outline has ten alternating vertices
 * and five deep concavities, so a correct render puts lights INSIDE the notches
 * and around the spike tips; a box, an ellipse, or a convex hull all put them
 * somewhere visibly else. The perimeter is roughly 2.4x the width of the
 * bounding box, so even the SPACING between lights is wrong under any of those.
 *
 * The parameters are chosen to make that legible rather than to look pretty:
 * 10 segments at 45% of their slot puts two lights on most spikes, so a wrong
 * arc length shows as wrong COUNT per spike and not merely as a shifted phase.
 * Hardness is 100 so the frame records geometry rather than a blur kernel.
 */
const vegasContourScene: Scene = defineScene({
  id: 'effect-vegas-contour',
  description: 'Vegas running lights along a STAR’s alpha contour — concave, so a bounding box cannot fake it.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  build(graph) {
    // 5-pointed star, outer radius 90, inner 38, first spike straight up.
    const points = Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 === 0 ? 90 : 38;
      const a = (-90 + i * 36) * (Math.PI / 180);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      return { x, y, inX: x, inY: y, outX: x, outY: y };
    });
    graph.addNode(node('star', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      style: { fill: '#1d2740' },
      components: [{ id: 'star_g', type: 'Geometry', props: { points } }],
    }));
    graph.setEffects('star', [
      {
        id: 'veg',
        type: 'vegas',
        params: {
          segments: 10, length: 45, rotation: 0, width: 7,
          hardness: 100, threshold: 128, color: '#ffd166', opacity: 100,
        },
      },
    ]);
  },
});


/**
 * Bezier Warp, on a subject where a wrong inverse map is VISIBLE.
 *
 * ── Why this is not an entry in EFFECTS ───────────────────────────────────
 *
 * The family's subject is a gradient-filled ellipse, and a warped smooth
 * gradient is still a smooth gradient. Every distort effect already in the list
 * gets away with it because their goldens at least move the silhouette — but a
 * warp's whole content is WHERE each pixel came from, and on smooth material
 * almost any inverse map produces a plausible frame. That is the Median mistake
 * (a denoiser on material with no noise) and the Vegas one (a contour effect on
 * a shape with no interesting contour), a third time.
 *
 * A CHECKERBOARD is the subject that cannot be faked. Its cell edges are
 * straight and evenly spaced by construction, so any error in the map shows as
 * cells landing in the wrong place or with the wrong curvature, rather than as
 * a differently-shaded blur. It is generated by an effect already in the
 * registry, stacked BEFORE the warp, so the pattern is what gets bent.
 *
 * The deformation is one edge only — the top handles pulled down by 45 — which
 * makes the expected result arithmetic rather than an impression: the patch
 * bows by 3k/4 = 33.75px at its midpoint and by nothing at its corners. The
 * accompanying deadness check counts exactly that (see the commit).
 */
/**
 * Optics Compensation, on a checkerboard for the reason Bezier Warp uses one.
 *
 * A lens warp is a change to STRAIGHT LINES, and the family's gradient ellipse
 * has none — it would bow imperceptibly and the golden would pass whether the
 * warp ran or not. That is the dead-scene shape this suite keeps producing, so
 * the pattern is stacked under the effect and the bend is what gets recorded.
 *
 * Field of view 90° so the corners move by tens of pixels, and `reverse` left
 * OFF so the outward branch is the one under test — the solved quadratic, which
 * is the half that is easy to get wrong. The first implementation used
 * `r·(1 + k·r²)` there, which reads like the opposite of the division model and
 * is not its inverse; `opticsCompensation.test.ts` pins that arithmetic, and
 * this pins that the arithmetic reaches pixels.
 */
/**
 * Mesh Warp, moving ONE interior vertex.
 *
 * The whole claim of an interior lattice is that it can dent the middle while
 * the frame edges stay pinned — the thing Bezier Warp, which only bends the
 * boundary, cannot do. So the scene moves exactly one interior vertex and
 * records both halves of that: a visible pull where the vertex is, and edges
 * that have not moved.
 *
 * A checkerboard again, for the reason Bezier Warp and Optics Compensation use
 * one: a warp is a change to straight lines, and the family's gradient ellipse
 * has none. The failure this guards is the transposed lattice — sixteen
 * vertices read from a flat parameter list is an index calculation, and getting
 * row and column the wrong way round yields a perfectly plausible warp with the
 * wrong vertex moved.
 */
/**
 * Liquify — one brush pushing, twirling and pinching at once.
 *
 * All three controls together on purpose. Each is applied to the same sample
 * point in sequence, so a scene exercising one at a time would not record that
 * they COMPOSE — and the order they compose in (push first, then rotate and
 * scale about the centre) is the part that could quietly change.
 *
 * The brush is deliberately smaller than the layer and offset from its middle,
 * so the frame carries both halves of the claim: a deformed neighbourhood, and
 * a checkerboard that is still perfectly regular everywhere else. A centred
 * brush filling the layer would record the warp and lose the containment.
 */
const liquifyScene: Scene = defineScene({
  id: 'effect-liquify',
  description: 'Liquify: one offset brush pushing, twirling and pinching a checkerboard — the rest untouched.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  build(graph) {
    graph.addNode(node('liq', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 240, height: 160, shapeType: 'rect' },
      style: { fill: '#1b2436' },
    }));
    graph.setEffects('liq', [
      { id: 'chk', type: 'checkerboard', params: {
        width: 20, height: 20, anchorX: 0, anchorY: 0,
        colorA: '#12304f', colorB: '#ffd166', opacity: 100,
      } },
      { id: 'lq', type: 'liquify', params: {
        centerX: -40, centerY: -20, brushSize: 55,
        pushX: 18, pushY: 10, twirl: 70, pinch: 25,
      } },
    ]);
  },
});

const meshWarpScene: Scene = defineScene({
  id: 'effect-mesh-warp',
  description: 'Mesh Warp pulling one interior vertex of a checkerboard — edges pinned.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  build(graph) {
    graph.addNode(node('mesh', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 240, height: 160, shapeType: 'rect' },
      style: { fill: '#1b2436' },
    }));
    graph.setEffects('mesh', [
      { id: 'chk', type: 'checkerboard', params: {
        width: 20, height: 20, anchorX: 0, anchorY: 0,
        colorA: '#12304f', colorB: '#ffd166', opacity: 100,
      } },
      // Vertex (1,1) of the 4×4 lattice — interior, and ASYMMETRIC in both
      // axes so a row/column swap moves the picture somewhere else entirely.
      { id: 'mw', type: 'mesh-warp', params: { v5X: 34, v5Y: -20 } },
    ]);
  },
});

const opticsCompensationScene: Scene = defineScene({
  id: 'effect-optics-compensation',
  description: 'Optics Compensation at 90° FOV bending a checkerboard — corners pulled, centre fixed.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  build(graph) {
    graph.addNode(node('lens', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 240, height: 160, shapeType: 'rect' },
      style: { fill: '#1b2436' },
    }));
    graph.setEffects('lens', [
      { id: 'chk', type: 'checkerboard', params: {
        width: 20, height: 20, anchorX: 0, anchorY: 0,
        colorA: '#12304f', colorB: '#ffd166', opacity: 100,
      } },
      { id: 'oc', type: 'optics-compensation', params: {
        fieldOfView: 90, reverse: 0, centerX: 0, centerY: 0,
      } },
    ]);
  },
});

const bezierWarpGridScene: Scene = defineScene({
  id: 'effect-bezier-warp-grid',
  description: 'Bezier Warp bending a checkerboard: top edge bowed down 3k/4, corners pinned.',
  size: SIZE,
  comp: COMP,
  fps: 30,
  frames: [0],
  gpuParity: 'expect-pass',
  build(graph) {
    graph.addNode(node('grid', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 240, height: 160, shapeType: 'rect' },
      style: { fill: '#1b2436' },
    }));
    graph.setEffects('grid', [
      // The test pattern. `source-atop`, so it fills the rect's own alpha.
      { id: 'chk', type: 'checkerboard', params: {
        width: 20, height: 20, anchorX: 0, anchorY: 0,
        colorA: '#12304f', colorB: '#ffd166', opacity: 100,
      } },
      // Both top tangent handles down by 45. Everything else at rest, so the
      // left, right and bottom edges must stay exactly straight — which is half
      // of what the frame records.
      { id: 'bw', type: 'bezier-warp', params: { top1Y: 45, top2Y: 45 } },
    ]);
  },
});

export const effectScenes: Scene[] = [
  ...EFFECTS.map(effectScene),
  displacementMapLayerScene,
  applyColorLutScene,
  compoundBlurScene,
  medianDenoiseScene,
  vegasContourScene,
  liquifyScene,
  meshWarpScene,
  opticsCompensationScene,
  bezierWarpGridScene,
];
