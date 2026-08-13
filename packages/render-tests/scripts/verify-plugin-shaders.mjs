/**
 * Compile every pass of every effect in a plugin package, on a real adapter.
 *
 *   node packages/render-tests/scripts/verify-plugin-shaders.mjs <plugin.zip>
 *
 * The package goes through the app's own `parseManifest` and
 * `composeEffectShader`, so what reaches the driver is byte-for-byte what the
 * editor would compile — not a hand-copy that can be right while the real thing
 * is wrong.
 *
 * Exists because a shipped sample whose WGSL does not compile fails in the most
 * expensive way available: the effect appears in the browser, applies to a
 * layer, and does nothing — which looks exactly like the host wiring being
 * broken, and sends whoever is testing after the wrong bug.
 */

import electronPath from 'electron';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESET = '\x1b[0m';
const red = (s) => `\x1b[31m${s}${RESET}`;
const green = (s) => `\x1b[32m${s}${RESET}`;
const yellow = (s) => `\x1b[33m${s}${RESET}`;
const dim = (s) => `\x1b[2m${s}${RESET}`;

const zipPath = process.argv[2];
if (!zipPath) {
  console.error('usage: verify-plugin-shaders.mjs <plugin.zip>');
  process.exit(1);
}

/** Read the package and compose every pass, using the app's own code. */
const ENTRY = `
import { readPluginZip } from '@core/plugins/pluginPackage';
import { parseManifest } from '@core/plugins/manifest';
import { composeEffectShader } from '@core/plugins/effectSchema';

globalThis.__COMPOSE__ = (bytes) => {
  const { pkg, errors } = readPluginZip(bytes);
  if (!pkg) throw new Error('package unreadable: ' + errors.join('; '));
  const { manifest, errors: mErrors } = parseManifest(JSON.parse(pkg.files['plugin.json']));
  if (!manifest) throw new Error('manifest invalid: ' + mErrors.join('; '));
  const out = [];
  for (const fx of manifest.contributes.effects) {
    const count = fx.passes ? fx.passes.length : 1;
    for (let i = 0; i < count; i++) {
      out.push({
        name: fx.id + (fx.passes ? '#' + fx.passes[i].name : ''),
        wgsl: composeEffectShader(fx, i).wgsl,
      });
    }
  }
  return JSON.stringify({ pluginId: manifest.id, shaders: out });
};
`;

const bundle = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'compose.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
  alias: { '@core': path.join(ROOT, 'src', 'core'), '@': path.join(ROOT, 'src') },
  logLevel: 'silent',
});
await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

let composed;
try {
  composed = JSON.parse(globalThis.__COMPOSE__(new Uint8Array(readFileSync(zipPath))));
} catch (err) {
  console.log(red(`FAILED before the GPU — ${err.message}`));
  process.exit(1);
}

const specPath = path.join(os.tmpdir(), 'motion-shader-compile-spec.json');
writeFileSync(specPath, JSON.stringify(composed.shaders));
console.log(dim(`  ${composed.pluginId}: ${composed.shaders.length} shader(s) to compile`));

const outcome = await new Promise((resolve, reject) => {
  const child = spawn(
    electronPath,
    [path.join(ROOT, 'packages', 'render-tests', 'electron', 'shaderCompileProbe.cjs'), specPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => process.stderr.write(dim(String(d))));
  child.on('error', reject);
  child.on('exit', (code) => {
    const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
    if (line) return resolve({ kind: 'ok', value: JSON.parse(line.slice(7)) });
    if (out.includes('SKIP:')) return resolve({ kind: 'skip' });
    const e = out.split('\n').find((l) => l.startsWith('ERROR:'));
    resolve({ kind: 'error', message: e ? e.slice(6) : `probe exited (${code}) silently` });
  });
});

if (outcome.kind === 'skip') {
  console.log(yellow('SKIPPED — no WebGPU adapter on this machine. Nothing was compiled.'));
  process.exit(0);
}
if (outcome.kind === 'error') {
  console.log(red(`FAILED — ${outcome.message}`));
  process.exit(1);
}

let errors = 0;
let warnings = 0;
console.log('');
for (const r of outcome.value) {
  const errs = r.messages.filter((m) => m.type === 'error');
  const warns = r.messages.filter((m) => m.type === 'warning');
  errors += errs.length;
  warnings += warns.length;
  const mark = errs.length ? red('✗') : warns.length ? yellow('!') : green('✓');
  console.log(`  ${mark} ${r.name}`);
  for (const m of [...errs, ...warns]) {
    console.log(`      ${m.type} line ${m.line}: ${m.text.split('\n')[0]}`);
  }
}
console.log('');

if (errors > 0) {
  console.log(red(`FAILED — ${errors} compilation error(s).`));
  console.log('  These effects would appear in the browser, apply to a layer, and draw');
  console.log('  nothing — which looks exactly like broken host wiring.');
  process.exit(1);
}
console.log(green(`PASSED — every shader compiles${warnings ? ` (${warnings} warning(s))` : ''}.`));
