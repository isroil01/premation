/**
 * No plugin code may be evaluated in the host realm.
 *
 * There used to be a "Load External Plugin Script (.js)" file picker in the
 * Plugins modal that passed the chosen file's text to `new Function`, with live
 * `defaultSceneGraph` / `defaultAnimation` handles bound in. Host-realm
 * execution is not merely scene access — it is everything the page can do, and
 * this page holds the account bearer JWT and the user's plaintext AI provider
 * keys, both in localStorage.
 *
 * Installing plugins is now supported again, so the guard can no longer be
 * "there is no file picker". It is the thing that actually mattered all along:
 * a picked package is DATA in the host realm, and its code is only ever
 * executed inside a Worker. This test reads the source, because the failure
 * mode being prevented is someone reintroducing the capability — under any name
 * — rather than a specific method returning something.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pluginHost from './PluginHost';

const SRC = join(__dirname, '..', '..');

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Strip block and line comments so the prose explaining the ban does not
 *  itself trip the ban. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no host-realm evaluation of plugin code', () => {
  /** Every file that runs in the HOST realm and touches plugin packages. */
  const HOST_FILES = [
    'core/plugins/PluginHost.ts',
    'core/plugins/hostApi.ts',
    'core/plugins/pluginPackage.ts',
    'core/plugins/manifest.ts',
    'core/plugins/spawnPluginWorker.ts',
    'layout/Plugins/PluginsModal.tsx',
    'layout/Plugins/PluginPanel.tsx',
  ];

  it.each(HOST_FILES)('%s contains no new Function / eval', (rel) => {
    const src = code(read(rel));
    expect({ file: rel, newFunction: /new\s+Function\s*\(/.test(src) }).toEqual({ file: rel, newFunction: false });
    expect({ file: rel, evalCall: /[^.\w]eval\s*\(/.test(src) }).toEqual({ file: rel, evalCall: false });
  });

  it.each(HOST_FILES)('%s never dynamically imports a package file', (rel) => {
    const src = code(read(rel));
    // `import(...)` of anything but a static string literal is the same
    // capability wearing a hat — a blob/data URL built from plugin source.
    const dynamic = [...src.matchAll(/[^.\w]import\s*\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    const nonLiteral = dynamic.filter((arg) => !/^['"][^'"]+['"]$/.test(arg));
    expect({ file: rel, nonLiteralImports: nonLiteral }).toEqual({ file: rel, nonLiteralImports: [] });
  });

  it('the plugin host exposes no way to install code from a string', () => {
    const host = pluginHost as unknown as Record<string, unknown>;
    for (const name of ['installFromSource', 'installFromString', 'loadScript', 'evalPlugin']) {
      expect({ name, present: typeof host[name] === 'function' }).toEqual({ name, present: false });
    }
  });

  it('the host runs plugin code only by handing it to a Worker', () => {
    // The sandbox is a real Worker, built from OUR module URL…
    expect(/new Worker\(\s*new URL\('\.\/pluginWorker\.ts'/.test(code(read('core/plugins/spawnPluginWorker.ts')))).toBe(true);
    // …and the plugin's own source only ever crosses as boot DATA.
    expect(/k: 'boot'[\s\S]{0,200}code/.test(code(read('core/plugins/PluginHost.ts')))).toBe(true);
  });

  it('the worker locks the network down before importing plugin code', () => {
    // Order matters and is easy to break in a refactor: importing first would
    // give the plugin a live `fetch` for the length of its module evaluation.
    const src = read('core/plugins/pluginWorker.ts');
    const lockAt = src.indexOf('lockdown();');
    const importAt = src.search(/await import\(/);
    expect(lockAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(importAt);
    for (const global of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB']) {
      expect({ global, denied: src.includes(`'${global}'`) }).toEqual({ global, denied: true });
    }
  });

  it('a plugin panel frame is sandboxed without allow-same-origin', () => {
    // `allow-same-origin` would hand the frame this document's origin, and with
    // it localStorage — the exact thing the whole sandbox exists to prevent.
    const src = read('layout/Plugins/PluginPanel.tsx');
    expect(/sandbox="allow-scripts"/.test(src)).toBe(true);
    expect(/allow-same-origin/.test(code(src))).toBe(false);
  });
});
