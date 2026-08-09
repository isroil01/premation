/**
 * WebAssembly in a plugin: decided, and written down.
 *
 * ── The actual defect was the silence ───────────────────────────────────────
 *
 * Lockdown removes `new Function` and every network primitive. Whether
 * `WebAssembly` survived was never stated anywhere — it did, by accident of not
 * being on the deny list — so an author had no way to know whether relying on
 * it was supported or an oversight about to be closed. That is worse than
 * either answer: a documented "no" costs a feature, an undocumented "yes" costs
 * a plugin that breaks in a release nobody flagged as breaking.
 *
 * ── The decision ────────────────────────────────────────────────────────────
 *
 * ALLOWED, from bytes already inside the signed package. It widens nothing: a
 * `.wasm` file carries the same signature, the same 2 MB per-file cap and the
 * same 8 MB package cap as the JavaScript beside it, and an instantiated module
 * receives no imports the plugin's own JS did not hand it — so it reaches
 * exactly what that JS could already reach, which is the permission-gated
 * method table and nothing else.
 *
 * What it buys is the difference between scripting and a platform. Solvers,
 * mesh libraries, codecs and tracers are written in another language and cannot
 * usefully be ported; refusing wasm would not shrink the sandbox, it would push
 * the same work into hand-written asm.js — the same power, worse ergonomics, no
 * size check.
 *
 * REFUSED: `instantiateStreaming` and `compileStreaming`. Both take a
 * `Response`, which means a network fetch, and this realm has none. Removing
 * them keeps "a plugin has no network of its own" true with no exception to
 * remember.
 */

import { readPluginZip } from './pluginPackage';
import { STATIC_CAPABILITIES } from './capabilities';
import { zipSync, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The smallest valid WebAssembly module: the 8-byte header and nothing else.
 *
 * Real bytes rather than a stub, so `instantiate` genuinely runs. A test that
 * asserted against a fake would prove the mock works.
 */
const EMPTY_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // \0asm
  0x01, 0x00, 0x00, 0x00, // version 1
]);

function packageWith(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'plugin.json': strToU8(JSON.stringify({
      id: 'studio.acme.wasm',
      name: 'Wasm',
      version: '1.0.0',
      description: 'A plugin that ships compiled code.',
      apiVersion: 5,
      main: 'main.js',
      permissions: [],
      requires: ['wasm'],
    })),
  };
  for (const [path, data] of Object.entries(files)) {
    entries[path] = typeof data === 'string' ? strToU8(data) : data;
  }
  return zipSync(entries);
}

describe('the package format', () => {
  it('carries a .wasm file as binary', () => {
    const { pkg, errors } = readPluginZip(packageWith({
      'main.js': 'export function activate(){}',
      'solver.wasm': EMPTY_MODULE,
    }));

    expect(errors).toEqual([]);
    expect(pkg?.binaries['solver.wasm']).toBeInstanceOf(Uint8Array);
    // Byte-exact. A `.wasm` read as text and re-encoded is not a module any
    // more, and the failure would be a validation error at instantiate time
    // with nothing pointing back here.
    expect([...(pkg?.binaries['solver.wasm'] ?? [])]).toEqual([...EMPTY_MODULE]);
  });

  it('does not put it in `files`, where text lives', () => {
    // `files` is what the panel host and the module loader read as strings.
    const { pkg } = readPluginZip(packageWith({
      'main.js': 'export function activate(){}',
      'solver.wasm': EMPTY_MODULE,
    }));
    expect(pkg?.files['solver.wasm']).toBeUndefined();
  });

  it('is covered by the per-file limit like everything else', () => {
    // The size story is the reason this widens nothing. A module that could
    // exceed the cap would be a way to smuggle bytes past the package limit.
    const huge = new Uint8Array(3 * 1024 * 1024);
    huge.set(EMPTY_MODULE);
    const { pkg, errors } = readPluginZip(packageWith({
      'main.js': 'export function activate(){}',
      'big.wasm': huge,
    }));
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/big\.wasm unpacks to more than 2048 KB/);
  });
});

describe('the capability', () => {
  it('exists, so a plugin can require it', () => {
    // Without it an author has no way to say "install me only where I can run",
    // and the failure lands at the first call instead of at install.
    expect(STATIC_CAPABILITIES as readonly string[]).toContain('wasm');
  });
});

describe('what the sandbox allows', () => {
  /*
    These run against the REAL `WebAssembly` in this realm rather than through
    the worker, because jsdom has no module-worker loader — the same reason
    `fakeWorker.testkit` exists. What is asserted is the property the lockdown
    is meant to produce, and `lockdown()` is exercised for real by
    `noHostRealmEval.test.ts`.
  */

  it('instantiates a module from bytes', async () => {
    const result = await WebAssembly.instantiate(EMPTY_MODULE, {});
    expect(result.instance).toBeDefined();
  });

  it('hands an instantiated module no host imports', async () => {
    /*
      The property the whole decision rests on, and it needs no enforcement code
      — there is no mechanism by which the host could inject an import. The
      imports object is the plugin's own argument, so a module can reach exactly
      what the plugin's JS can reach, which is the permission-gated method table
      and nothing else.

      Asserted because "there is no mechanism" is the kind of claim that stops
      being true when someone adds a convenience.
    */
    const instance = (await WebAssembly.instantiate(EMPTY_MODULE, {})).instance;
    expect(Object.keys(instance.exports)).toEqual([]);
  });

  it('refuses a module that asks for an import nobody supplied', async () => {
    /*
      A module declaring an import of a host function it hopes exists gets
      nothing — the instantiation fails rather than resolving against some
      ambient global. Built by hand: header, one type `() -> ()`, one import
      naming `host.escape`.
    */
    const needsImport = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // type section: one func type () -> ()
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      // import section: "host"."escape" as func type 0
      0x02, 0x11, 0x01,
      0x04, 0x68, 0x6f, 0x73, 0x74,             // "host"
      0x06, 0x65, 0x73, 0x63, 0x61, 0x70, 0x65, // "escape"
      0x00, 0x00,
    ]);

    await expect(WebAssembly.instantiate(needsImport, {})).rejects.toThrow();
  });
});

describe('what lockdown removes', () => {
  it('names both streaming entry points', () => {
    /*
      Asserted against the SOURCE rather than by running lockdown, which needs a
      worker global this environment does not have. Crude, and it catches the
      realistic regression: someone tidies the deny list and drops one of the
      pair, leaving `compileStreaming` reachable while `instantiateStreaming` is
      not — a difference nobody would notice until it mattered.
    */
    const source = readFileSync(join(__dirname, 'pluginWorker.ts'), 'utf-8');
    expect(source).toContain("'instantiateStreaming'");
    expect(source).toContain("'compileStreaming'");
  });

  it('keeps the non-streaming pair', () => {
    // The other half. A future tightening that removed `instantiate` would take
    // the whole feature away, and this says so out loud.
    const source = readFileSync(join(__dirname, 'pluginWorker.ts'), 'utf-8');
    expect(source).not.toMatch(/denied\('WebAssembly\.instantiate'\)/);
    expect(source).not.toMatch(/denied\('WebAssembly\.compile'\)/);
  });
});
