/**
 * The multi-pass sample: a separable Gaussian blur, as a two-pass effect.
 *
 * ── Why a blur specifically ──────────────────────────────────────────────────
 *
 * It is the smallest honest demonstration of what multi-pass buys, and it is
 * the effect whose absence made the single-pass API narrower than it sounded. A
 * Gaussian blur of radius r over a full kernel is r² samples per pixel; done
 * separably — horizontal, then vertical — it is 2r. At r = 16 that is 1,024
 * samples against 32. Not a micro-optimisation: the single-pass version is
 * unusable at any radius people actually want, which is why "you can write one
 * shader" did not mean "you can write a blur".
 *
 * It also exercises the three things a chain adds and nothing else does:
 * `texelSize` from the host pass block (a blur that hardcodes a resolution is
 * wrong on every composition but the author's), the pass ordering, and the
 * ping-ponged targets the plugin never sees.
 *
 * ── Why it lives beside the starter template ─────────────────────────────────
 *
 * Same reason as `starterPlugin.ts`: far more authors will copy a working
 * package than will read the reference. Whatever shape this file has is the
 * shape multi-pass plugins in the wild will have — so the weights are computed
 * rather than pasted from a table, the loop bound is a literal (the validator
 * requires one), and the radius is a real animatable parameter rather than a
 * constant, because those are the three things an author would otherwise get
 * wrong on their first attempt.
 */

import { zipSync, strToU8 } from 'fflate';
import { MANIFEST_VERSION } from '@core/plugins/manifest';

/**
 * The kernel, as WGSL shared by both passes.
 *
 * ── The two constraints that shape this, both from the validator ─────────────
 *
 * 1. **The loop bound must be a literal.** `for (var i = 0; i <= radius; i++)`
 *    is refused — `radius` is a uniform, so its value is unknown at validation
 *    time and the iteration count cannot be bounded. So the loop runs to a
 *    fixed `MAX_R` and multiplies each tap by a mask that is zero past the
 *    live radius. Every iteration executes; the ones beyond the radius
 *    contribute nothing. That is also how a GPU would have run it anyway —
 *    divergent branches in a fragment shader do not save the work.
 *
 * 2. **≤ 256 iterations, ≤ 3 nesting.** 32 taps each side is well inside it,
 *    and 32 is a wider blur than most compositions need at 1080p.
 *
 * The Gaussian weight is computed rather than tabulated so the radius can be
 * animated: a lookup table would have to be regenerated per radius on the CPU,
 * which is a per-frame message to a worker — the one thing an effect may not do.
 *
 * `sigma = radius / 2` is the usual working choice: the kernel is ~2σ each
 * side, which captures about 95% of the curve. Guarded against radius 0, where
 * the shader must degenerate to a copy rather than divide by zero.
 */
const KERNEL = (axis: 'x' | 'y'): string => /* wgsl */ `
// 32 taps each side. Written as a bare literal in the loop below, NOT as a
// \`const\`: the validator reads the loop header with a regex rather than
// parsing WGSL, so it accepts a numeric literal and nothing else — including a
// \`const\` that WGSL itself would resolve at compile time. That is stricter
// than it strictly needs to be, and deliberately so; the alternative is a
// hand-written WGSL front end fed hostile input, which is a worse liability
// than the thing it would protect. Keep the 32s in sync if you change them.

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let radius = clamp(params.radius, 0.0, 32.0);

  // Radius 0 is a copy, not a divide by zero. An effect at its default must
  // never be the one that produces NaN.
  if (radius < 0.5) {
    return textureSample(src, samp, uv);
  }

  let sigma = max(radius * 0.5, 0.0001);
  let twoSigmaSq = 2.0 * sigma * sigma;

  // One texel along this pass's axis. From the host pass block, so it is
  // correct at whatever scale the host allocated this pass's target — a blur
  // that hardcoded a resolution would be the wrong width on every composition
  // but the one it was written on.
  let step = vec2<f32>(${axis === 'x' ? 'params.texelSize.x, 0.0' : '0.0, params.texelSize.y'});

  var sum = textureSample(src, samp, uv);
  var total = 1.0;

  // Literal bound, masked contribution. See the note above: a uniform bound is
  // refused by the validator, and masking costs nothing a GPU was not already
  // paying for.
  for (var i : i32 = 1; i <= 32; i = i + 1) {
    let fi = f32(i);
    let live = select(0.0, 1.0, fi <= radius);
    let w = exp(-(fi * fi) / twoSigmaSq) * live;

    sum = sum + textureSample(src, samp, uv + step * fi) * w;
    sum = sum + textureSample(src, samp, uv - step * fi) * w;
    total = total + w * 2.0;
  }

  return sum / total;
}`;

const MANIFEST = {
  id: 'com.example.separable-blur',
  name: 'Separable Blur',
  version: '1.0.0',
  description:
    'Multi-pass sample — a Gaussian blur split into a horizontal and a vertical pass. '
    + 'Read the comments in plugin.json and main.js.',
  author: 'Your name',
  apiVersion: MANIFEST_VERSION,
  main: 'main.js',
  /*
    `requires`, and this is the case the capability system exists for.

    An effect-only plugin on the WebGL2 tier is not degraded, it is INERT: a
    plugin effect renders its input unchanged there. Declaring `webgpu` refuses
    the install with a reason, which is a far better outcome than a plugin that
    appears healthy in the list and does nothing to any layer the user applies
    it to.
  */
  requires: ['effects.multipass', 'webgpu'],
  permissions: [],
  contributes: {
    effects: [
      {
        id: 'gaussian',
        label: 'Gaussian Blur',
        params: {
          radius: { type: 'number', label: 'Radius', default: 8, min: 0, max: 32, step: 1 },
        },
        /*
          Two passes, both at full scale.

          Cost 1 + 1 = 2, inside the budget of 3. Half scale would be cheaper
          (0.25 each) and is the right choice for a large-radius background
          blur, where the resample hides the loss — but at small radii it is
          visible as softness the author did not ask for, and a sample that
          demonstrates a subtle artefact is a sample that teaches one.

          The horizontal pass reads the layer; the vertical reads the
          horizontal's output. Neither names a target: the host allocates them,
          ping-pongs them, and sequences the draws.
        */
        passes: [
          { name: 'horizontal', wgsl: KERNEL('x') },
          { name: 'vertical', wgsl: KERNEL('y'), reads: 'previous' },
        ],
      },
    ],
  },
  /*
    Omitted, which means `['onStartup']`.

    An effect is data — the host reads it from the manifest, compiles it and
    draws it whether or not any of this plugin's JavaScript ever runs — so this
    plugin has no reason to start a worker at all. There is currently no way to
    say that: `activationEvents: []` normalises to `['onStartup']` too, because
    empty and absent both read as "no opinion" and the safe reading of no
    opinion is the API-1 behaviour. So it is left out rather than written as an
    empty array that looks like it means something it does not.

    The cost is one idle worker. Noted in the test as a known gap.
  */
};

const MAIN = /* js */ `/**
 * A multi-pass effect plugin has nothing to do at runtime.
 *
 * The effect is DATA: the host read it out of plugin.json, generated the
 * bindings and the vertex stage, compiled one pipeline per pass, and now runs
 * them. None of that involves this file, which is the point — an effect keeps
 * drawing with this worker stopped, and keeps drawing in a project opened by
 * someone who never installed the plugin.
 *
 * \`activate\` exists because the package format requires an entry module. Add
 * commands here if the plugin grows some.
 */
export function activate(motion) {
  // Nothing. See above.
}
`;

const README = `# Separable Blur

A two-pass Gaussian blur, as a multi-pass effect sample.

## What to look at

**\`plugin.json\`** — the \`passes\` array. Two passes, each with its own WGSL.
The host allocates the intermediate target, ping-pongs it, and runs them in
order. A plugin never sees a render target.

**\`params.texelSize\`** — one over the target's dimensions, supplied by the
host in the pass block. A blur has to know how far a pixel is, and the answer
differs per pass when passes render at different scales. Hardcoding a
resolution is the mistake this field exists to prevent.

## The two rules that shape the kernel

- **The loop bound must be a literal.** A uniform bound cannot be verified, so
  the loop runs to a fixed 32 and masks taps past the live radius to zero.
- **Radius 0 must be a copy.** Otherwise \`sigma\` is 0 and the weights are NaN,
  which shows as a black layer at the parameter's lowest setting.

## Cost

Each pass at \`scale: 1\` costs 1; the chain costs 2, against a budget of 3.
Drop the passes to \`scale: 0.5\` (0.25 each) for a large-radius background blur
where the resample is invisible.
`;

/** The sample package, as zip bytes. */
export function buildBlurSamplePlugin(): Uint8Array {
  return zipSync({
    'plugin.json': strToU8(JSON.stringify(MANIFEST, null, 2)),
    'main.js': strToU8(MAIN),
    'README.md': strToU8(README),
  });
}

/** Exported for the test, which parses this manifest through the real parser. */
export const BLUR_SAMPLE_MANIFEST = MANIFEST;
