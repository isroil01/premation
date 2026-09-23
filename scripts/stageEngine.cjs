/**
 * Stage premation-engine for packaging (electron-builder `beforePack`).
 *
 * The C++ engine process (NATIVE_CORE_PLAN C3) ships as an extraResource at
 * <resources>/engine/ — electron/engineSupervisor.ts `resolveEngineExecutable`
 * looks there in a packaged app. It is only there when it was BUILT
 * (`node scripts/native.mjs build --engine`, 16 min the first time for Dawn):
 * packaging must keep working without it, and the app then runs on the
 * TypeScript engine exactly as before (the process backend is behind a flag,
 * and a missing executable is a supervisor `fallback`).
 *
 * So this copies whatever exists into build/engine/ (git-ignored) and the
 * builder config picks up `premation-engine*` and `*.dll` from there — an empty
 * folder ships nothing. On Windows Dawn loads DXC at runtime, so
 * dxcompiler.dll + dxil.dll travel beside the executable.
 *
 *   node scripts/stageEngine.cjs          stage for this platform (manual check)
 */

'use strict';

const { copyFileSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'engine');

function presetFor(platform) {
  if (platform === 'win32') return 'windows-clang-cl-engine';
  if (platform === 'darwin') return 'macos-clang-engine';
  return 'linux-clang-engine';
}

function stageEngine(platform = process.platform) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const dir = path.join(ROOT, 'native', 'build', presetFor(platform), 'engine');
  const exe = platform === 'win32' ? 'premation-engine.exe' : 'premation-engine';
  if (!existsSync(path.join(dir, exe))) {
    console.log(`[stageEngine] ${exe} is not built (${path.relative(ROOT, dir)}); packaging without the C++ engine`);
    return [];
  }
  const files = platform === 'win32' ? [exe, 'dxcompiler.dll', 'dxil.dll'] : [exe];
  const staged = [];
  for (const f of files) {
    const from = path.join(dir, f);
    if (!existsSync(from)) {
      console.warn(`[stageEngine] ${f} missing beside ${exe}; the engine may not start on this machine`);
      continue;
    }
    copyFileSync(from, path.join(OUT, f));
    staged.push(f);
  }
  console.log(`[stageEngine] staged ${staged.join(', ')} → build/engine`);
  return staged;
}

/** electron-builder `beforePack` hook. */
module.exports = async function beforePack(context) {
  stageEngine(context && context.electronPlatformName ? context.electronPlatformName : process.platform);
};
module.exports.stageEngine = stageEngine;

if (require.main === module) stageEngine();
