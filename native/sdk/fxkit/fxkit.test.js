/**
 * fxkit (native/sdk/fxkit/fxkit.mjs): the sample's committed gen/ is up to date with its
 * fx/*.fx, the kit's swizzle tables match the generator, and a kernel outside the WGSL subset
 * is refused with the reason. The GPU-vs-CPU parity of what it generates is
 * engine_plugins_gpu_tests "[fxkit]".
 */
/* global describe, it, expect */

const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const KIT = path.join(__dirname, 'fxkit.mjs');
const SAMPLE = path.join(__dirname, '..', 'samples', 'fxkit');

const run = (...args) => spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8' });

describe('fxkit', () => {
  it('the sample gen/ and the kit swizzles are up to date', () => {
    const r = run(SAMPLE, '--check');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('generates the plugin id, version and an integer expand as a float literal', () => {
    const gen = readFileSync(path.join(SAMPLE, 'gen', 'fx_gen.hpp'), 'utf8');
    expect(gen).toContain('#define FXK_PLUGIN_ID "com.premation.sample.fxkit"');
    expect(gen).toContain('#define FXK_VERSION_MAJOR 1');
    expect(gen).toContain('static_cast<float>(prm.amount) + 2.0F');
  });

  it('refuses a kernel outside the WGSL subset, and names the file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fxkit-'));
    try {
      cpSync(SAMPLE, dir, { recursive: true });
      const fx = path.join(dir, 'fx', 'chroma_split.fx');
      writeFileSync(fx, readFileSync(fx, 'utf8').replace('let a = max(max(r.a, g.a), b.a);', 'let a = r.a > 0.5 ? 1.0 : 0.0;'));
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/chroma_split: no ternaries/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
