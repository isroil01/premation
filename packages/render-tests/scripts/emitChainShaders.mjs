/**
 * Compose the sample plugin's shaders using the APP's own code, and write them
 * to JSON for the GPU probe.
 *
 * The probe runs in Electron and cannot import TypeScript, so the alternative
 * was to retype the composed WGSL inside it. That would have made the probe
 * test its own copy — and the specific bug this whole exercise uncovered was a
 * feature that was composed correctly and never executed, which a hand-copy is
 * blind to by construction.
 *
 * So: bundle `blurSamplePlugin` + `parseManifest` + `composeEffectShader` with
 * esbuild, run the bundle, print what the host would hand the driver.
 */

import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: emitChainShaders.mjs <output.json>');
  process.exit(1);
}

/**
 * An entry point that pulls the real manifest through the real parser.
 *
 * `parseManifest` matters as much as `composeEffectShader` here: it is what
 * turns the declared `passes` into the structure the composer walks, and it is
 * where the not-yet-renderable values are refused. Going straight to the
 * composer would skip the gate and could compose something that cannot install.
 */
const ENTRY = `
import { parseManifest } from '${'@core/plugins/manifest'}';
import { composeEffectShader } from '${'@core/plugins/effectSchema'}';
import { BLUR_SAMPLE_MANIFEST } from '${'@/layout/Plugins/blurSamplePlugin'}';

const { manifest, errors } = parseManifest(BLUR_SAMPLE_MANIFEST);
if (!manifest) throw new Error('sample manifest did not validate: ' + errors.join('; '));
const effect = manifest.contributes.effects[0];
if (!effect) throw new Error('sample manifest declares no effect');

const count = effect.passes ? effect.passes.length : 1;
const passes = [];
for (let i = 0; i < count; i++) {
  const composed = composeEffectShader(effect, i);
  passes.push({
    index: i,
    name: effect.passes ? effect.passes[i].name : 'only',
    wgsl: composed.wgsl,
  });
}
const layout = composeEffectShader(effect, 0).layout;

/*
  A second chain, for the origin binding.

  Its last pass returns \`origin\` UNCHANGED, which makes the check decisive:
  the output must come back identical to the chain's input. If binding 4 were
  wired to the previous pass's output — the plausible wrong answer, since that
  is what \`src\` already is — the result would be the blurred image instead,
  and the difference is not subtle.

  Built as a contribution rather than a manifest so the shader can be exactly
  that one line. It still goes through \`composeEffectShader\`, which is what
  emits the \`@binding(4) var origin\` declaration under test.
*/
const passthroughOrigin =
  '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {'
  + '  return textureSample(origin, samp, uv);'
  + '}';
const blurPass = effect.passes[0].wgsl;

const originEffect = {
  id: 'originCheck',
  label: 'Origin check',
  shader: blurPass,
  params: effect.params,
  passes: [
    { name: 'blur', wgsl: blurPass, scale: 1, reads: 'previous' },
    { name: 'restore', wgsl: passthroughOrigin, scale: 1, reads: 'both' },
  ],
};
const originPasses = originEffect.passes.map((p, i) => ({
  index: i,
  name: p.name,
  reads: p.reads,
  wgsl: composeEffectShader(originEffect, i).wgsl,
}));

globalThis.__RESULT__ = JSON.stringify({
  originPasses,
  effectId: effect.id,
  uniformBytes: layout.size,
  params: layout.layout,
  passes,
});
`;

const result = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'emit.ts', loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // Mirrors the app's tsconfig paths. Kept minimal on purpose — anything the
  // shader composition does not reach should fail loudly here rather than be
  // stubbed into silence.
  alias: {
    '@core': path.join(ROOT, 'src', 'core'),
    '@': path.join(ROOT, 'src'),
  },
  logLevel: 'silent',
});

const code = result.outputFiles[0].text;
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
await import(dataUrl);

const payload = globalThis.__RESULT__;
if (!payload) throw new Error('the bundle produced no result');
writeFileSync(OUT, payload);
void pathToFileURL;
