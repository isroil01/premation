/**
 * stageEngine (electron-builder beforePack): a package without the C++ engine
 * is refused; each platform + arch stages exactly what must ship beside it.
 */
/* global describe, it, expect, beforeEach, afterEach, jest */

const { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageEngine, presetsFor, EngineMissingError } = require('./stageEngine.cjs');

describe('stageEngine', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'stage-engine-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const built = (preset, files) => {
    const dir = path.join(root, 'native', 'build', preset, 'engine');
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(path.join(dir, f), 'x');
  };
  const staged = () => readdirSync(path.join(root, 'build', 'engine')).sort();
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => {});

  it('picks the preset per platform and dmg arch', () => {
    expect(presetsFor('win32', 1)).toEqual(['windows-clang-cl-engine']);
    expect(presetsFor('darwin', 3)).toEqual(['macos-clang-engine']);
    expect(presetsFor('darwin', 1)).toEqual(['macos-clang-engine-x64']);
    expect(presetsFor('darwin', 'arm64')).toEqual(['macos-clang-engine']);
    expect(presetsFor('darwin', 4)).toEqual(['macos-clang-engine', 'macos-clang-engine-x64']);
    expect(presetsFor('linux', 1)).toEqual(['linux-clang-engine']);
  });

  it('refuses to package without the engine, naming what is missing', () => {
    expect(() => stageEngine('win32', 1, {}, root)).toThrow(EngineMissingError);
    built('windows-clang-cl-engine', ['premation-engine.exe']);
    expect(() => stageEngine('win32', 1, {}, root)).toThrow(/dxcompiler\.dll[\s\S]*dxil\.dll/);
    built('macos-clang-engine', ['premation-engine']);
    expect(() => stageEngine('darwin', 3, {}, root)).toThrow(/premation-host-bridge\.node/);
  });

  it('packages without it only when told to, and says so', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(stageEngine('darwin', 3, { PREMATION_PACKAGE_WITHOUT_ENGINE: '1' }, root)).toEqual([]);
    expect(warn.mock.calls[0][0]).toMatch(/cannot run/);
    warn.mockRestore();
  });

  it('stages Windows with DXC, macOS with the host bridge, Linux with its shared libraries', () => {
    const log = quiet();
    built('windows-clang-cl-engine', ['premation-engine.exe', 'dxcompiler.dll', 'dxil.dll', 'premation-render.exe']);
    stageEngine('win32', 1, {}, root);
    expect(staged()).toEqual(['dxcompiler.dll', 'dxil.dll', 'premation-engine.exe']);

    built('macos-clang-engine-x64', ['premation-engine', 'premation-host-bridge.node', 'engine_tests']);
    stageEngine('darwin', 1, {}, root);
    expect(staged()).toEqual(['premation-engine', 'premation-host-bridge.node']);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(root, 'build', 'engine', 'premation-engine')).mode & 0o111).not.toBe(0);
    }

    built('linux-clang-engine', ['premation-engine', 'libvulkan.so.1', 'libfoo.so', 'notes.txt']);
    stageEngine('linux', 1, {}, root);
    expect(staged()).toEqual(['libfoo.so', 'libvulkan.so.1', 'premation-engine']);
    log.mockRestore();
  });
});
