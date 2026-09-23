#!/usr/bin/env node
/**
 * `npm run native:<step>` — the CMake presets in native/, picked for this OS.
 *
 *   node scripts/native.mjs configure [--asan|--tsan|--engine|--preset NAME]
 *                                     (--engine: premation-engine + Dawn, docs/VIEWPORT_ROUTE.md)
 *   node scripts/native.mjs build     [same flags]
 *   node scripts/native.mjs test      [same flags]
 *   node scripts/native.mjs bench     runs the Google Benchmark binary
 *   node scripts/native.mjs tidy      run-clang-tidy over native/libs (needs a configured build)
 *   node scripts/native.mjs wasm      configure + build the Emscripten preset + smoke test
 *   node scripts/native.mjs napi      npm install + cmake-js compile in native/bindings/napi + smoke test
 *   node scripts/native.mjs golden    regenerate native/tests/golden_bezier.inc from the TypeScript
 *
 * Toolchain install per OS: native/README.md. Nothing here downloads anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = join(root, 'native');

const [step = 'help', ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(name);
  if (i === -1) return undefined;
  return rest[i + 1] ?? true;
}

function basePreset() {
  switch (process.platform) {
    case 'win32':
      return 'windows-clang-cl';
    case 'darwin':
      return 'macos-clang';
    default:
      return 'linux-clang';
  }
}

function preset() {
  const explicit = flag('--preset');
  if (typeof explicit === 'string') return explicit;
  const base = basePreset();
  if (rest.includes('--asan')) return `${base}-asan`;
  if (rest.includes('--tsan')) return `${base}-tsan`;
  if (rest.includes('--engine')) return `${base}-engine`;
  return base;
}

/**
 * Windows: clang-cl needs the MSVC CRT + Windows SDK headers and libs that only
 * a "Developer Prompt" puts in INCLUDE/LIB. Rather than require one, load that
 * environment ourselves (vswhere → vcvars64.bat) when it is missing, and put
 * the winget-installed LLVM/CMake/Ninja and a sibling vcpkg checkout on the
 * path. A shell that already has the environment is left alone.
 */
function prepareWindowsEnv() {
  if (process.platform !== 'win32') return;
  const env = process.env;
  const addPath = (dir) => {
    if (dir && existsSync(dir) && !(env.PATH ?? '').toLowerCase().includes(dir.toLowerCase())) {
      env.PATH = `${dir};${env.PATH ?? ''}`;
    }
  };
  if (!env.INCLUDE) {
    const vswhere = join(env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (existsSync(vswhere)) {
      const q = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
      const vsRoot = (q.stdout ?? '').trim().split(/\r?\n/)[0];
      const vcvars = vsRoot ? join(vsRoot, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat') : '';
      if (vcvars && existsSync(vcvars)) {
        const dump = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${vcvars}" >nul && set`], { encoding: 'utf8', windowsVerbatimArguments: true });
        for (const line of (dump.stdout ?? '').split(/\r?\n/)) {
          const eq = line.indexOf('=');
          if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
        }
      }
    }
  }
  // After vcvars (which rewrites PATH), make sure our clang, not MSVC's bundled one, comes first.
  addPath(join(env.ProgramFiles ?? 'C:/Program Files', 'CMake', 'bin'));
  const winget = join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages', 'Ninja-build.Ninja_Microsoft.Winget.Source_8wekyb3d8bbwe');
  addPath(winget);
  addPath(join(env.ProgramFiles ?? 'C:/Program Files', 'LLVM', 'bin'));
  if (!env.VCPKG_ROOT) {
    const sibling = resolve(root, '..', 'vcpkg');
    if (existsSync(join(sibling, 'vcpkg.exe'))) env.VCPKG_ROOT = sibling;
  }
}

prepareWindowsEnv();

function run(cmd, args, opts = {}) {
  const shown = [cmd, ...args].join(' ');
  console.log(`\n> ${shown}${opts.cwd ? `   (in ${opts.cwd})` : ''}`);
  // Windows needs a shell to resolve npm/npx/cmake `.cmd` shims, but a shell
  // splits an absolute path with spaces ("C:\Program Files\nodejs\node.exe").
  const shell = process.platform === 'win32' && !isAbsolute(cmd);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell, ...opts });
  if (r.error) {
    console.error(`${cmd}: ${r.error.message}\nIs the toolchain installed? See native/README.md.`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function buildDir(p) {
  return join(nativeDir, 'build', p);
}

switch (step) {
  case 'configure':
    run('cmake', ['--preset', preset()], { cwd: nativeDir });
    break;
  case 'build':
    run('cmake', ['--build', '--preset', preset()], { cwd: nativeDir });
    break;
  case 'test':
    run('ctest', ['--preset', preset()], { cwd: nativeDir });
    break;
  case 'bench': {
    const exe = join(buildDir(preset()), 'bench', process.platform === 'win32' ? 'motion_bench.exe' : 'motion_bench');
    if (!existsSync(exe)) {
      console.error(`${exe} not found — run native:configure and native:build first (MOTION_BUILD_BENCH=ON).`);
      process.exit(1);
    }
    run(exe, ['--benchmark_min_time=0.5s', ...rest.filter((a) => a.startsWith('--benchmark'))]);
    break;
  }
  case 'tidy': {
    const db = buildDir(preset());
    if (!existsSync(join(db, 'compile_commands.json'))) {
      console.error(`${db}/compile_commands.json not found — run native:configure first.`);
      process.exit(1);
    }
    // Only the library sources are tidy-gated (tests/bench/bindings are macro-heavy third-party surfaces).
    // An engine preset (--engine) also gates the render graph, media, raster, audio and the scene builder
    // (engine/src/render_graph, engine/src/media, engine/src/raster, engine/src/audio, engine/src/scene —
    // each with its own .clang-tidy).
    const files = rest.includes('--engine')
      ? '.*[/\\\\]native[/\\\\](libs|engine[/\\\\]src[/\\\\](render_graph|media|raster|audio|scene))[/\\\\].*'
      : '.*[/\\\\]native[/\\\\]libs[/\\\\].*';
    run('run-clang-tidy', ['-p', db, '-quiet', files]);
    break;
  }
  case 'wasm': {
    if (!process.env.EMSDK) {
      console.error('EMSDK is not set — activate emsdk first (see native/README.md).');
      process.exit(1);
    }
    run('cmake', ['--preset', 'wasm'], { cwd: nativeDir });
    run('cmake', ['--build', '--preset', 'wasm'], { cwd: nativeDir });
    run(process.execPath, [join(nativeDir, 'bindings', 'wasm', 'smoke.mjs')]);
    break;
  }
  case 'napi': {
    const dir = join(nativeDir, 'bindings', 'napi');
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir });
    const args = ['cmake-js', 'compile'];
    if (process.platform === 'win32') {
      // llvm-rc explicitly: under npx, node_modules/.bin/rc (an npm package)
      // shadows the resource compiler — the same fix as native.yml.
      args.push('-G', 'Ninja', '--CDCMAKE_C_COMPILER=clang-cl', '--CDCMAKE_CXX_COMPILER=clang-cl', '--CDCMAKE_RC_COMPILER=llvm-rc');
    }
    run('npx', args, {
      cwd: dir,
      env: process.platform === 'win32' ? process.env : { CC: 'clang', CXX: 'clang++', ...process.env },
    });
    run(process.execPath, [join(dir, 'smoke.cjs')]);
    break;
  }
  case 'golden':
    run(process.execPath, [join(nativeDir, 'tests', 'gen_golden.ts')]);
    break;
  default:
    console.log('usage: node scripts/native.mjs configure|build|test|bench|tidy|wasm|napi|golden [--asan|--tsan|--preset NAME]');
    process.exit(step === 'help' ? 0 : 1);
}
