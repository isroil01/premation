/**
 * Build the plugin test kit and validate it with the app's OWN parser.
 *
 *   node scripts/build-test-kit-plugin.mjs [outDir]
 *
 * ── Why a kit of several effects rather than one big one ─────────────────────
 *
 * Each effect exercises exactly one thing that was built recently, and each
 * looks unmistakably different when it works. If a single combined effect came
 * out wrong there would be no way to tell which feature failed; with four, the
 * one that misbehaves names itself.
 *
 *   blur       multi-pass chain, texelSize from the host pass block
 *   bloom      scale 0.25 downsampling + reads:"both" (composite vs origin)
 *   spotlight  a `point` parameter, packed as vec2 in composition pixels
 *   edges      a plain single-pass effect — the control. If THIS is broken the
 *              problem is not any of the new work.
 *
 * ── Validated here, not on the user's machine ────────────────────────────────
 *
 * The manifest goes through the real `parseManifest` (bundled out of the app
 * with esbuild) before the zip is written. Handing someone a package to test a
 * renderer, which then fails at the manifest gate, wastes their time on a
 * different bug than the one they were asked to look for.
 */

import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.argv[2] ?? path.join(ROOT, 'examples', 'plugins');

/* ── shaders ───────────────────────────────────────────────────────────────
   Every one obeys the validator: entry named `fs`, no @group/@binding/@vertex,
   no `while`, literal loop bounds, <=256 iterations, <=3 nesting.            */

/** A separable Gaussian tap loop along one axis. Shared by blur and bloom. */
const gauss = (axis, radiusExpr) => `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let r = clamp(${radiusExpr}, 0.0, 24.0);
  if (r < 0.5) { return textureSample(src, samp, uv); }
  let sigma = max(r * 0.5, 0.0001);
  let twoSigmaSq = 2.0 * sigma * sigma;
  let stepv = vec2<f32>(${axis === 'x' ? 'params.texelSize.x, 0.0' : '0.0, params.texelSize.y'});
  var sum = textureSample(src, samp, uv);
  var total = 1.0;
  for (var i : i32 = 1; i <= 24; i = i + 1) {
    let fi = f32(i);
    let live = select(0.0, 1.0, fi <= r);
    let w = exp(-(fi * fi) / twoSigmaSq) * live;
    sum = sum + textureSample(src, samp, uv + stepv * fi) * w;
    sum = sum + textureSample(src, samp, uv - stepv * fi) * w;
    total = total + w * 2.0;
  }
  return sum / total;
}`;

/** Keep only what is brighter than a threshold. Pass 0 of the bloom. */
const BRIGHT = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, uv);
  let lum = max(max(c.r, c.g), c.b);
  let k = smoothstep(params.threshold, params.threshold + 0.15, lum);
  return c * k;
}`;

/**
 * Add the blurred highlights back over the ORIGINAL.
 *
 * The one effect that cannot work without `reads: "both"`. If binding 4 were
 * wrong this would composite the blur over the blur, and the layer would read
 * as a soft smear with no sharp content anywhere — very obviously wrong.
 */
const COMPOSITE = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = textureSample(origin, samp, uv);
  let glow = textureSample(src, samp, uv);
  return base + glow * params.intensity;
}`;

/**
 * Brighten around a point.
 *
 * `uv / texelSize` is `uv * targetSize` — pixel coordinates in THIS PASS'S
 * TARGET, which on the 2D path is the composition, and on the 3D path is the
 * layer's padded quad. So "composition pixels" is true of a 2D layer and only
 * approximately true of a 3D one; the default below is centred for a 960×540
 * comp and will sit off-centre on a 1080p one. That is fine for what this
 * proves — moving the X/Y fields must move the bright spot. If the vec2 were
 * packed at the wrong offset it would not move at all, or would jump with the
 * Radius slider instead.
 */
const SPOTLIGHT = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, uv);
  let px = uv / max(params.texelSize, vec2<f32>(0.000001));
  let d = distance(px, params.centre);
  let f = 1.0 - smoothstep(0.0, max(params.radius, 1.0), d);
  return vec4<f32>(c.rgb * (1.0 + f * params.strength), c.a);
}`;

/** Single pass, no new machinery. The control. */
const EDGES = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = params.texelSize;
  let c = textureSample(src, samp, uv);
  let l = textureSample(src, samp, uv - vec2<f32>(t.x, 0.0));
  let r = textureSample(src, samp, uv + vec2<f32>(t.x, 0.0));
  let u = textureSample(src, samp, uv - vec2<f32>(0.0, t.y));
  let d = textureSample(src, samp, uv + vec2<f32>(0.0, t.y));
  let g = abs(r.rgb - l.rgb) + abs(d.rgb - u.rgb);
  let e = clamp(length(g) * params.gain, 0.0, 1.0);
  return vec4<f32>(mix(c.rgb, vec3<f32>(e), params.mix), c.a);
}`;

const MANIFEST = {
  id: 'studio.premation.test-kit',
  name: 'Effect Test Kit',
  version: '1.0.0',
  description:
    'Four effects, each exercising one part of the effect pipeline: multi-pass chains, '
    + 'downsampled passes, compositing against the original, and a point parameter.',
  author: 'Premation',
  apiVersion: 5,
  main: 'main.js',
  // An effect-only plugin is inert on the WebGL2 tier — it renders its input
  // unchanged — so refusing the install there beats looking healthy and doing
  // nothing to every layer it is applied to.
  requires: ['webgpu'],
  permissions: [],
  contributes: {
    effects: [
      {
        id: 'edges',
        label: '0 · Edges (control)',
        params: {
          gain: { type: 'number', label: 'Gain', default: 6, min: 0, max: 40 },
          mix: { type: 'number', label: 'Mix', default: 1, min: 0, max: 1, step: 0.01 },
        },
        shader: EDGES,
      },
      {
        id: 'blur',
        label: '1 · Blur (multi-pass)',
        params: {
          radius: { type: 'number', label: 'Radius', default: 8, min: 0, max: 24, step: 1 },
        },
        spread: { param: 'radius', factor: 2.5 },
        passes: [
          { name: 'horizontal', wgsl: gauss('x', 'params.radius') },
          { name: 'vertical', wgsl: gauss('y', 'params.radius'), reads: 'previous' },
        ],
      },
      {
        id: 'bloom',
        label: '2 · Bloom (¼ scale + origin)',
        params: {
          threshold: { type: 'number', label: 'Threshold', default: 0.6, min: 0, max: 1, step: 0.01 },
          radius: { type: 'number', label: 'Radius', default: 10, min: 0, max: 24, step: 1 },
          intensity: { type: 'number', label: 'Intensity', default: 1, min: 0, max: 4, step: 0.05 },
        },
        spread: { param: 'radius', factor: 4 },
        passes: [
          { name: 'bright', wgsl: BRIGHT },
          { name: 'blurH', wgsl: gauss('x', 'params.radius'), scale: 0.25, reads: 'previous' },
          { name: 'blurV', wgsl: gauss('y', 'params.radius'), scale: 0.25, reads: 'previous' },
          { name: 'composite', wgsl: COMPOSITE, reads: 'both' },
        ],
      },
      {
        id: 'spotlight',
        label: '3 · Spotlight (point param)',
        params: {
          centre: { type: 'point', label: 'Centre', default: { x: 480, y: 270 } },
          radius: { type: 'number', label: 'Radius', default: 240, min: 1, max: 4000 },
          strength: { type: 'number', label: 'Strength', default: 1.2, min: 0, max: 4, step: 0.05 },
        },
        shader: SPOTLIGHT,
      },
    ],
  },
};

const MAIN = `/**
 * Nothing runs at runtime. Every effect here is DATA: the host read it out of
 * plugin.json, generated the bindings and the vertex stage, compiled one
 * pipeline per pass, and draws them. None of that involves this file — which is
 * why these effects keep working with this worker stopped, and in a project
 * opened by someone who never installed the plugin.
 */
export function activate() {}
`;

const README = `# Effect Test Kit

Four effects. Apply each to a layer with some contrast in it and check the
column on the right.

| Effect | What it proves | Looks broken if… |
|---|---|---|
| 0 · Edges | The ordinary single-pass path still works | nothing happens at all — then the problem is not the new work |
| 1 · Blur | A multi-pass chain runs BOTH passes, and \`texelSize\` arrived | it blurs in one axis only, or not at all |
| 2 · Bloom | Quarter-scale passes, and \`reads: "both"\` | the layer turns into a soft smear with no sharp content — that is the composite adding the blur to itself instead of to the original |
| 3 · Spotlight | A \`point\` parameter packs as a vec2, 8-byte aligned, at offset 96 | the bright spot does not move when you change Centre X/Y, or it jumps when you drag Radius instead |

The Centre default (480, 270) is centred for a 960×540 composition — on a
1080p one the spot starts in the upper left. That is expected: the coordinate
is in the effect target's pixels, which is the composition on a 2D layer.

Turn the Blur radius up to 20+ on a 3D layer to check the declared spread: the
blur should fade out smoothly rather than stopping at a hard rectangular edge.
Blur declares \`spread: radius × 2.5\` (50px at radius 20) and Bloom \`× 4\`.
`;

/* ── validate with the real parser, then write ─────────────────────────────── */

const ENTRY = `
import { parseManifest } from '@core/plugins/manifest';
globalThis.__CHECK__ = (m) => {
  const { manifest, errors } = parseManifest(m);
  return JSON.stringify({ ok: !!manifest, errors });
};
`;

const bundle = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'check.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
  alias: { '@core': path.join(ROOT, 'src', 'core'), '@': path.join(ROOT, 'src') },
  logLevel: 'silent',
});
await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const verdict = JSON.parse(globalThis.__CHECK__(MANIFEST));
if (!verdict.ok) {
  console.error('The test kit does NOT validate:\n  ' + verdict.errors.join('\n  '));
  process.exit(1);
}
console.log(`manifest validates — ${MANIFEST.contributes.effects.length} effects, no errors`);

mkdirSync(OUT_DIR, { recursive: true });
const zip = zipSync({
  'effect-test-kit/plugin.json': strToU8(`${JSON.stringify(MANIFEST, null, 2)}\n`),
  'effect-test-kit/main.js': strToU8(MAIN),
  'effect-test-kit/README.md': strToU8(README),
});
const out = path.join(OUT_DIR, 'effect-test-kit.zip');
writeFileSync(out, zip);
console.log(`wrote ${out} (${zip.length} bytes)`);
