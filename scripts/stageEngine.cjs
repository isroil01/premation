/**
 * Stage premation-engine for packaging (electron-builder `beforePack`).
 *
 * The C++ engine process is the app's only engine (docs/TS_ENGINE_REMOVAL.md);
 * it ships as an extraResource at <resources>/engine/, where
 * electron/engineSupervisor.ts `resolveEngineExecutable` looks in a packaged
 * app. This copies it — and what must travel beside it — from the preset build
 * directory into build/engine/ (git-ignored), which electron-builder.yml ships.
 *
 * A package WITHOUT the engine is refused: the hook throws and electron-builder
 * stops. (`PREMATION_PACKAGE_WITHOUT_ENGINE=1` allows a local rehearsal of
 * the installer on a machine that cannot build the engine; it says so loudly
 * and CI never sets it.)
 *
 * Per platform, from native/build/<preset>/engine:
 *   win32    premation-engine.exe + dxcompiler.dll + dxil.dll (Dawn loads DXC
 *            at runtime) — all required                  windows-clang-cl-engine
 *   darwin   premation-engine + premation-host-bridge.node (Electron main's
 *            IOSurface lookup for the viewport) — both required. The dmg's
 *            arch picks the build: arm64 → macos-clang-engine, x64 →
 *            macos-clang-engine-x64 (cross-built), universal → both, lipo'd.
 *   linux    premation-engine + any shared libraries beside it (*.so*), and
 *            premation-host-bridge.node when built (dmabuf viewport; optional:
 *            the route-A copy works without it)    linux-clang-engine
 *
 *   node scripts/stageEngine.cjs [platform] [arch]   stage by hand (manual check)
 */

'use strict';

const { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** electron-builder's Arch enum (builder-util): ia32 0, x64 1, armv7l 2, arm64 3, universal 4. */
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function archName(arch) {
  if (typeof arch === 'number') return ARCH_NAMES[arch] ?? String(arch);
  return arch || process.arch;
}

/** The preset directories to stage from, for one platform + arch. */
function presetsFor(platform, arch) {
  if (platform === 'win32') return ['windows-clang-cl-engine'];
  if (platform === 'darwin') {
    const a = archName(arch);
    if (a === 'universal') return ['macos-clang-engine', 'macos-clang-engine-x64'];
    return [a === 'x64' ? 'macos-clang-engine-x64' : 'macos-clang-engine'];
  }
  return ['linux-clang-engine'];
}

/** The files to stage from `dir` ({ f, required }). Linux adds whatever .so files sit beside the engine. */
function filesFor(platform, dir) {
  if (platform === 'win32') return ['premation-engine.exe', 'dxcompiler.dll', 'dxil.dll'].map((f) => ({ f, required: true }));
  if (platform === 'darwin') return ['premation-engine', 'premation-host-bridge.node'].map((f) => ({ f, required: true }));
  const libs = existsSync(dir) ? readdirSync(dir).filter((f) => /\.so(\.\d+)*$/.test(f)) : [];
  // The host bridge is optional on Linux: without it the viewport takes the route-A copy.
  return [{ f: 'premation-engine', required: true }, { f: 'premation-host-bridge.node', required: false }, ...libs.map((f) => ({ f, required: false }))];
}

class EngineMissingError extends Error {}

/** `root`: the repository (tests stage a fake one). Returns the staged file names. */
function stageEngine(platform = process.platform, arch = process.arch, env = process.env, root = ROOT) {
  const OUT = path.join(root, 'build', 'engine');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const presets = presetsFor(platform, arch);
  const dirs = presets.map((p) => path.join(root, 'native', 'build', p, 'engine'));
  const missing = [];
  for (const dir of dirs) {
    for (const { f, required } of filesFor(platform, dir)) {
      if (required && !existsSync(path.join(dir, f))) missing.push(path.relative(root, path.join(dir, f)));
    }
  }
  if (missing.length > 0) {
    const how = presets.map((p) => `cmake --preset ${p} && cmake --build --preset ${p}   (in native/)`).join('\n  ');
    const message = `[stageEngine] the C++ engine is not built — missing:\n  ${missing.join('\n  ')}\nBuild it first:\n  ${how}`;
    // The rehearsal escape hatch never applies to a CI / release build: there a
    // missing engine is always a failed package, whatever the environment says.
    const ci = (Boolean(env.CI) && env.CI !== 'false') || Boolean(env.GITHUB_ACTIONS);
    if (env.PREMATION_PACKAGE_WITHOUT_ENGINE === '1' && ci) {
      throw new EngineMissingError(`${message}\n[stageEngine] PREMATION_PACKAGE_WITHOUT_ENGINE is ignored in CI (CI / GITHUB_ACTIONS set): a release never ships without the engine.`);
    }
    if (env.PREMATION_PACKAGE_WITHOUT_ENGINE === '1') {
      console.warn(`${message}\n[stageEngine] PREMATION_PACKAGE_WITHOUT_ENGINE=1: packaging WITHOUT the engine — this app cannot run.`);
      return [];
    }
    throw new EngineMissingError(message);
  }

  const staged = [];
  if (dirs.length === 2) {
    // A universal dmg: one fat binary per file (arm64 + x86_64).
    for (const { f } of filesFor(platform, dirs[0])) {
      execFileSync('lipo', ['-create', path.join(dirs[0], f), path.join(dirs[1], f), '-output', path.join(OUT, f)]);
      staged.push(f);
    }
  } else {
    for (const { f } of filesFor(platform, dirs[0])) {
      const from = path.join(dirs[0], f);
      if (!existsSync(from)) continue;  // an optional Linux library
      copyFileSync(from, path.join(OUT, f));
      staged.push(f);
    }
  }
  if (platform !== 'win32') chmodSync(path.join(OUT, 'premation-engine'), 0o755);  // artifacts drop the mode bits
  console.log(`[stageEngine] ${platform}/${archName(arch)}: staged ${staged.join(', ')} from ${presets.join(' + ')} → build/engine`);
  return staged;
}

/** electron-builder `beforePack` hook: called once per platform + arch being packaged. */
module.exports = async function beforePack(context) {
  const platform = context && context.electronPlatformName ? context.electronPlatformName : process.platform;
  const arch = context && context.arch !== undefined ? context.arch : process.arch;
  stageEngine(platform, arch);
};
module.exports.stageEngine = stageEngine;
module.exports.presetsFor = presetsFor;
module.exports.filesFor = filesFor;
module.exports.EngineMissingError = EngineMissingError;

if (require.main === module) {
  try {
    stageEngine(process.argv[2] || process.platform, process.argv[3] || process.arch);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
