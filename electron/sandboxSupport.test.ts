/**
 * The renderer sandbox is on, and stays on.
 *
 * `sandbox: false` sat in this app for a long time behind a comment saying
 * WebGPU adapter creation required it. That kind of note is the most expensive
 * kind of comment: it is checked once, it justifies a real weakening, and then
 * it ossifies — nobody re-measures a claim that already has a reason attached.
 *
 * It was re-measured, and it was wrong. On **Electron 32.3.3 / Chromium 128**,
 * a `sandbox: true` renderer reports:
 *
 *     { hasGpu: true, adapter: true, device: true, webgl2: true }
 *
 * over `file://` (the packaged build's load path) AND `http://` (the dev
 * server's). The probe replicated the app's own GPU switches
 * (`ignore-gpu-blocklist`, `use-angle=default`, `enable-features=Vulkan` on
 * Windows) so the result is about the flag and not a differently-configured
 * process. Whatever was true when the comment was written, Chromium's GPU
 * sandboxing has moved.
 *
 * This file is what keeps that from silently reverting, and what tells the next
 * person how the claim was established rather than asking them to trust it.
 *
 * **Re-run the probe at the next Electron upgrade.** It is not run here — it
 * needs a real GPU and a real display, which CI does not have, and a test that
 * silently skips is worse than one that states its scope.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8');

/** Every `webPreferences` block in main. Derived, so a new window is covered. */
const webPreferenceBlocks = main.split('webPreferences:').slice(1);

describe('every renderer window is sandboxed', () => {
  it('found the window configurations', () => {
    // Floor assertion: a refactor that renamed or moved these would otherwise
    // empty the sweep and every check below would pass having read nothing.
    expect(webPreferenceBlocks.length).toBeGreaterThanOrEqual(3);
  });

  it('sets sandbox: true in every one of them', () => {
    const offenders = webPreferenceBlocks
      .map((block, i) => ({ i, block: block.slice(0, 900) }))
      .filter(({ block }) => !/sandbox:\s*true/.test(block))
      .map(({ i }) => i);
    expect(offenders).toEqual([]);
  });

  it('never sets sandbox: false anywhere', () => {
    expect(main).not.toMatch(/sandbox:\s*false/);
  });

  it('keeps context isolation on and node integration off alongside it', () => {
    // The sandbox is an addition to these, not a replacement for them: it
    // bounds what the process can DO, where they bound what it can ASK FOR.
    for (const block of webPreferenceBlocks.map((b) => b.slice(0, 900))) {
      expect(block).toMatch(/contextIsolation:\s*true/);
      expect(block).toMatch(/nodeIntegration:\s*false/);
    }
  });
});

describe('the preload can run under the sandbox', () => {
  it('imports nothing but the two sandbox-safe electron members', () => {
    // A sandboxed preload has no Node require. `contextBridge` and
    // `ipcRenderer` are provided; `node:path`, `node:fs` and friends are not,
    // and adding one would break the app at launch rather than at build.
    const imports = [...preload.matchAll(/^import\s+.*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imports).toEqual(['electron']);
    expect(preload).toMatch(/import\s*\{\s*contextBridge,\s*ipcRenderer\s*\}/);
  });

  it('uses no Node globals beyond the polyfilled process fields', () => {
    // A sandboxed preload gets a cut-down `process` with `platform`, `versions`
    // and a few others. `process.cwd`, `__dirname` and `require` are absent.
    expect(preload).not.toMatch(/\brequire\s*\(/);
    expect(preload).not.toMatch(/__dirname|__filename/);
    expect(preload).not.toMatch(/process\.(cwd|env|argv)\b/);
  });
});
