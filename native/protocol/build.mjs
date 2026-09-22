#!/usr/bin/env node
/**
 * `npm run protocol:build` — configure, build and test native/protocol (the
 * generated engine API codec) with the same toolchain as `npm run native:*`.
 *
 *   node native/protocol/build.mjs            configure + build + test
 *   node native/protocol/build.mjs --bench    … then run the codec benchmark
 *   node native/protocol/build.mjs --preset NAME
 *
 * A separate CMake project from native/ (its own presets, no vcpkg packages),
 * so it never touches native/build or native/CMakeLists.txt. On Windows the
 * MSVC environment is loaded the same way scripts/native.mjs does it
 * (vswhere → vcvars64.bat) when the shell does not already have it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const preset =
  flag('--preset') ??
  (process.platform === 'win32' ? 'windows-clang-cl' : process.platform === 'darwin' ? 'macos-clang' : 'linux-clang');

function prepareWindowsEnv() {
  if (process.platform !== 'win32') return;
  const env = process.env;
  const addPath = (dir) => {
    if (dir && existsSync(dir) && !(env.PATH ?? '').toLowerCase().includes(dir.toLowerCase())) env.PATH = `${dir};${env.PATH ?? ''}`;
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
  addPath(join(env.ProgramFiles ?? 'C:/Program Files', 'CMake', 'bin'));
  addPath(join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages', 'Ninja-build.Ninja_Microsoft.Winget.Source_8wekyb3d8bbwe'));
  addPath(join(env.ProgramFiles ?? 'C:/Program Files', 'LLVM', 'bin'));
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n> ${[cmd, ...cmdArgs].join(' ')}`);
  const shell = process.platform === 'win32' && !isAbsolute(cmd);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell, cwd: here, ...opts });
  if (r.error) {
    console.error(`${cmd}: ${r.error.message}\nIs the toolchain installed? See native/README.md.`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

prepareWindowsEnv();
run('cmake', ['--preset', preset]);
run('cmake', ['--build', '--preset', preset]);
run('ctest', ['--preset', preset]);
if (args.includes('--bench')) {
  const exe = join(here, 'build', preset, process.platform === 'win32' ? 'protocol_bench.exe' : 'protocol_bench');
  run(exe, []);
}
