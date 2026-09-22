#!/usr/bin/env node
/**
 * `npm run native:<step>` — the CMake presets in native/, picked for this OS.
 *
 *   node scripts/native.mjs configure [--asan|--tsan|--preset NAME]
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
import { dirname, join, resolve } from 'node:path';
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
  return base;
}

function run(cmd, args, opts = {}) {
  const shown = [cmd, ...args].join(' ');
  console.log(`\n> ${shown}${opts.cwd ? `   (in ${opts.cwd})` : ''}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
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
    run('run-clang-tidy', ['-p', db, '-quiet', '.*[/\\\\]native[/\\\\]libs[/\\\\].*']);
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
      args.push('-G', 'Ninja', '--CDCMAKE_C_COMPILER=clang-cl', '--CDCMAKE_CXX_COMPILER=clang-cl');
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
