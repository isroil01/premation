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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileExpression } from '@motion/animation';
import pluginHost from './PluginHost';

const SRC = join(__dirname, '..', '..');
const ROOT = join(SRC, '..');

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const readRoot = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

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
    'layout/Plugins/ConsentSheet.tsx',
    'layout/Plugins/PluginDetailTab.tsx',
    'layout/Plugins/useDiskInstall.tsx',
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
    // Note this holds for the URL-loaded shell too: the sandbox flag decides the
    // frame's origin, not where the document came from.
    const src = read('layout/Plugins/PluginPanel.tsx');
    expect(/sandbox="allow-scripts"/.test(src)).toBe(true);
    expect(/allow-same-origin/.test(code(src))).toBe(false);
  });

  it('the panel is NOT delivered by srcdoc', () => {
    // Regression guard with a specific history. `srcdoc` looks like the obvious
    // way to render panel markup, and it silently makes the entire panel
    // feature inert: a srcdoc document inherits the embedder's CSP, this app
    // ships `script-src 'self'` with no `'unsafe-inline'`, and a panel IS
    // inline script. Panels rendered and did nothing — no error, no clue.
    const src = code(read('layout/Plugins/PluginPanel.tsx'));
    expect(/srcDoc/i.test(src)).toBe(false);
  });

  it('the panel shell keeps its own policy tighter than the app for everything but inline script', () => {
    const shell = readFileSync(join(ROOT, 'public', 'plugin-panel.html'), 'utf8');
    const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(shell)?.[1] ?? '';
    expect(meta).toContain("default-src 'none'");
    // The point of the shell is inline script. Everything a panel could use to
    // reach the network must still be off — otherwise loading it from a real
    // URL would have bought scripting at the price of exfiltration.
    expect(meta).toContain("connect-src 'none'");
    expect(meta).not.toMatch(/script-src[^;]*https?:/);
  });

  it('a plugin granted net:fetch does NOT get a panel that can reach its hosts', () => {
    /*
      The obvious-looking change this exists to refuse.

      `net:fetch` gives a plugin a network path, and the natural next thought is
      to widen the panel's `connect-src` to the hosts it declared, so its UI can
      fetch directly instead of routing through the worker. That would hand the
      capability to the wrong realm. Every `net.fetch` call is checked three
      times — against `METHOD_PERMISSIONS`, against what the user actually
      granted, and against that plugin's own manifest — and the request is made
      by the HOST, which counts bytes, caps redirects and refuses private
      addresses. A panel with a real `connect-src` bypasses all of it: it is
      inline script from the package with nothing between it and the socket.

      So the shell's policy stays fixed. It is a static file with no
      interpolation, and no code assembles a policy from a manifest.
    */
    const shell = readFileSync(join(ROOT, 'public', 'plugin-panel.html'), 'utf8');
    // A static file: no template holes for a host list to be substituted into.
    expect(shell).not.toMatch(/\$\{|__[A-Z_]+__|%[A-Z_]+%/);

    // And nowhere in the frame path does a policy get assembled, or a declared
    // host get read. Either one appearing here is the start of that change.
    for (const rel of ['layout/Plugins/PluginPanel.tsx', 'core/plugins/PluginHost.ts']) {
      const src = code(read(rel));
      expect({ rel, buildsPolicy: /connect-src|Content-Security-Policy/i.test(src) })
        .toEqual({ rel, buildsPolicy: false });
      expect({ rel, readsDeclaredHosts: /contributes\.net/.test(src) })
        .toEqual({ rel, readsDeclaredHosts: false });
    }
  });
});

/**
 * The same rules, applied to the expression evaluator.
 *
 * The suite above guards the sandbox: plugin code runs in a Worker, never in
 * the host realm. But `animation.setExpression` is a hole in the shape of that
 * guard — it lets a plugin holding `animation:write` write arbitrary SOURCE
 * TEXT into the document, which the evaluator then runs, in the host realm,
 * every frame. If that evaluator ever compiles with `new Function`, the entire
 * Worker sandbox is decorative: a plugin reaches the renderer's realm through
 * the document instead of through its own module, and the renderer holds the
 * account JWT and the user's plaintext AI provider keys in localStorage.
 *
 * It does not today — `exprLang.ts` is a parser and a tree-walking interpreter,
 * written that way deliberately after `new Function` was found to be refused by
 * the app's CSP. That is precisely why it needs a guard: the reason it is safe
 * lives in a comment, and "just use new Function, it's simpler" is a plausible
 * refactor for someone who has not read it.
 *
 * The second suite is behavioural rather than textual, because the interpreter
 * has its own way of failing open: an expression escapes through the prototype
 * chain (`value.constructor.constructor('...')()` is the classic) without any
 * banned token appearing in evaluator source at all.
 */
describe('no host-realm evaluation of expression source', () => {
  /**
   * Derived from the directories, not hand-listed.
   *
   * A hand-written list covers the files someone remembered on the day they
   * wrote it. The failure this guard exists for is a NEW evaluator file, or a
   * rewrite that moves compilation somewhere else — exactly the cases a static
   * list misses silently.
   */
  function evaluatorFiles(): string[] {
    const out: string[] = [];
    for (const dir of ['packages/animation/src', 'src/core/animation']) {
      for (const f of readdirSync(join(ROOT, dir))) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts') || !/expr/i.test(f)) continue;
        out.push(`${dir}/${f}`);
      }
    }
    // Not named for expressions, but it is what compiles, stores, snapshots
    // and restores them — the evaluator's actual host.
    out.push('packages/animation/src/AnimationEngine.ts');
    return out;
  }

  const EXPR_FILES = evaluatorFiles();

  it('the sweep actually found the evaluator', () => {
    // Without this, a rename that empties the sweep turns every `it.each`
    // below into zero test cases, and the suite goes green by covering
    // nothing. A derived subject list needs a floor.
    expect(EXPR_FILES).toEqual(
      expect.arrayContaining([
        'packages/animation/src/exprLang.ts',
        'packages/animation/src/expressions.ts',
      ]),
    );
  });

  it.each(EXPR_FILES)('%s contains no new Function / eval', (rel) => {
    const src = code(readRoot(rel));
    expect({ file: rel, newFunction: /new\s+Function\s*\(/.test(src) }).toEqual({ file: rel, newFunction: false });
    expect({ file: rel, evalCall: /[^.\w]eval\s*\(/.test(src) }).toEqual({ file: rel, evalCall: false });
  });

  it.each(EXPR_FILES)('%s never dynamically imports a non-literal specifier', (rel) => {
    const src = code(readRoot(rel));
    const dynamic = [...src.matchAll(/[^.\w]import\s*\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    const nonLiteral = dynamic.filter((arg) => !/^['"][^'"]+['"]$/.test(arg));
    expect({ file: rel, nonLiteralImports: nonLiteral }).toEqual({ file: rel, nonLiteralImports: [] });
  });

  it('an expression cannot climb the prototype chain back into the realm', () => {
    // The escape that needs no banned token in evaluator source. Each of these
    // is a real published sandbox break against naive interpreters.
    const escapes = [
      'value.constructor',
      'value.__proto__',
      'value["constructor"]',
      'Math.constructor',
      'wiggle.constructor',
      'time.constructor.constructor',
      '[].constructor',
      '"".constructor',
    ];
    for (const src of escapes) {
      const { value, error } = compileExpression(src).run({ time: 0, value: 1 });
      // Refused, and refused LOUDLY — a silent null would read to the user as
      // a broken expression rather than a blocked one.
      expect({ src, value, blocked: error !== null }).toEqual({ src, value: null, blocked: true });
    }
  });

  it('an expression reaches no host global', () => {
    // The scope is a closed set of bound names. Anything not bound must be an
    // error, not `undefined` — `undefined` is how a leak stays quiet.
    for (const src of ['globalThis', 'window', 'self', 'fetch', 'localStorage', 'process', 'require']) {
      const { value, error } = compileExpression(src).run({ time: 0, value: 1 });
      expect({ src, value, blocked: error !== null }).toEqual({ src, value: null, blocked: true });
    }
  });
});
