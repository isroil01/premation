/**
 * Regenerates tests/data/audio_parity.bin — the TypeScript reference mixes the
 * E2 parity gate (test_audio_parity.cpp) checks the C++ mixer against.
 *
 * Bundles gen_audio_parity_entry.ts (the REAL src/core/audio/audioMixdown.ts,
 * with the scene reader and decode cache stubbed) with the repo's esbuild and
 * runs it in Electron's renderer, i.e. in Chromium's OfflineAudioContext —
 * the Web Audio implementation the editor's export actually renders with.
 *
 *     node native/engine/tests/gen_audio_parity.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const require = createRequire(join(root, 'package.json'));
const esbuild = require('esbuild');
const electron = require('electron'); // the binary's path

const work = mkdtempSync(join(tmpdir(), 'premation-audio-parity-'));
const audioDir = join(root, 'src', 'core', 'audio');

// Stub the two inputs of mixdownBuffer; everything else is the real code.
const stubs = {
  name: 'parity-stubs',
  setup(build) {
    build.onResolve({ filter: /^\.\/(audioScene|AudioEngine)$/ }, (args) => {
      if (!args.importer.startsWith(audioDir) || !args.importer.endsWith('audioMixdown.ts')) return undefined;
      return { path: args.path, namespace: 'parity-stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'parity-stub' }, (args) => ({
      loader: 'ts',
      contents: args.path.endsWith('audioScene')
        ? 'export const readAudioLayers = () => (globalThis as any).__parityLayers;'
        : 'export const audioEngine = { load: async () => null, decodedBuffer: (id: string) => (globalThis as any).__parityBuffers[id] };',
    }));
  },
};

await esbuild.build({
  entryPoints: [join(here, 'gen_audio_parity_entry.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'AudioParity',
  outfile: join(work, 'bundle.js'),
  tsconfig: join(root, 'tsconfig.json'),
  plugins: [stubs],
  logLevel: 'error',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.wgsl': 'text', '.glsl': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

writeFileSync(join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="bundle.js"></script>');
const outFile = join(work, 'audio_parity.bin');
writeFileSync(
  join(work, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(${JSON.stringify(join(work, 'index.html'))});
    const b64 = await win.webContents.executeJavaScript('AudioParity.run()');
    fs.writeFileSync(${JSON.stringify(outFile)}, Buffer.from(b64, 'base64'));
    console.log('chromium ' + process.versions.chrome + ', electron ' + process.versions.electron);
  } catch (e) {
    console.error(String(e && e.stack || e));
    process.exitCode = 1;
  }
  app.quit();
});
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, [join(work, 'main.cjs')], { stdio: 'inherit', env, timeout: 120000 });
if (r.status !== 0 || !existsSync(outFile)) {
  console.error('electron run failed', r.status, r.error ?? '');
  process.exit(1);
}
const dataDir = join(here, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir);
const bytes = readFileSync(outFile);
writeFileSync(join(dataDir, 'audio_parity.bin'), bytes);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${join(dataDir, 'audio_parity.bin')} (${bytes.length} bytes)`);
