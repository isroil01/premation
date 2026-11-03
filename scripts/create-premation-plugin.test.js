/**
 * create-premation-plugin: each template writes a complete project (manifest, sources, tests, CI),
 * the fx template's project generates cleanly with the SDK's fxkit, and bad arguments are refused
 * without touching the disk. Building the projects against an installed SDK is a manual check
 * (docs/PLUGIN_SDK.md "Starting a plugin").
 */
/* global describe, it, expect, beforeEach, afterEach */

const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'create-premation-plugin.mjs');
const FXKIT = path.join(__dirname, '..', 'native', 'sdk', 'fxkit', 'fxkit.mjs');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('create-premation-plugin', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'create-plugin-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['effect', ['CMakeLists.txt', 'premation-plugin.json', 'src/glow_pro.cpp', 'tests/cases.json']],
    ['fx', ['CMakeLists.txt', 'fxkit.json', 'fx/glow_pro.fx', 'tests/cases.json']],
    ['command', ['CMakeLists.txt', 'premation-plugin.json', 'src/glow_pro.cpp']],
  ])('the %s template writes a whole project', (template, own) => {
    const dir = path.join(root, template);
    const r = run(dir, '--id', 'com.example.glow', '--name', 'Glow Pro', '--template', template, '--vendor', 'Example');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    for (const f of [...own, 'README.md', '.gitignore', '.github/workflows/build.yml']) expect(existsSync(path.join(dir, f))).toBe(true);
    const workflow = readFileSync(path.join(dir, '.github/workflows/build.yml'), 'utf8');
    expect(workflow).toContain('path: build/plugins/glow_pro/');
    expect(workflow.includes('test tests/cases.json')).toBe(template !== 'command');
    if (template !== 'fx') {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'premation-plugin.json'), 'utf8'));
      expect(manifest.id).toBe('com.example.glow');
      expect(manifest.binary['windows-x64']).toBe('glow_pro.dll');
    }
  });

  it('the fx project generates with the SDK fxkit, and its test case names the generated effect', () => {
    const dir = path.join(root, 'fx');
    expect(run(dir, '--id', 'com.example.vig', '--name', 'Vignette', '--template', 'fx').status).toBe(0);
    const gen = spawnSync(process.execPath, [FXKIT, dir], { encoding: 'utf8' });
    expect(gen.stderr).toBe('');
    expect(gen.status).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'premation-plugin.json'), 'utf8'));
    const cases = JSON.parse(readFileSync(path.join(dir, 'tests/cases.json'), 'utf8')).cases;
    expect(manifest.effects.map((e) => e.matchName)).toEqual(['com.example.vig.vignette']);
    expect(new Set(cases.map((c) => c.effect))).toEqual(new Set(['com.example.vig.vignette']));
  });

  it('refuses a bad id, an unknown template and a folder that is not empty', () => {
    expect(run(path.join(root, 'a'), '--id', 'Glow', '--name', 'Glow').status).toBe(2);
    expect(run(path.join(root, 'b'), '--id', 'com.x.y', '--name', 'Glow', '--template', 'shader').status).toBe(2);
    expect(existsSync(path.join(root, 'a'))).toBe(false);
    expect(run(path.join(root, 'c'), '--id', 'com.x.y', '--name', 'Glow').status).toBe(0);
    const again = run(path.join(root, 'c'), '--id', 'com.x.y', '--name', 'Glow');
    expect(again.status).toBe(1);
    expect(readdirSync(path.join(root, 'c')).length).toBeGreaterThan(0);
  });
});
