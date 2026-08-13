/**
 * What `api.request` will and will not send.
 *
 * This is the reason the bridge takes a PATH rather than a URL, so the
 * rejection table is the security property, not an input-validation nicety. A
 * hole here turns `api.request` back into what it replaced: a relay that any
 * code in the renderer can point anywhere, with the user's bearer attached.
 *
 * The scheme-relative and backslash cases are the ones that get missed. `//x`
 * is an absolute URL wearing a path's clothes, and `/\x` is normalised INTO it
 * by WHATWG parsers — so a validator that only checks `startsWith('/')` waves
 * both straight through.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveApiUrl, apiBaseUrl } from './apiBase';

const BASE = 'http://localhost:4000/api';

describe('paths that are allowed', () => {
  it.each([
    ['/projects', 'http://localhost:4000/api/projects'],
    ['/projects/abc-123', 'http://localhost:4000/api/projects/abc-123'],
    ['/projects?limit=20&offset=40', 'http://localhost:4000/api/projects?limit=20&offset=40'],
    // A dot inside a segment is not traversal. Refusing this would break real
    // filenames for the sake of a check that has nothing to do with them.
    ['/files/my..name.png', 'http://localhost:4000/api/files/my..name.png'],
    ['/sync/p1/chunks/deadbeef', 'http://localhost:4000/api/sync/p1/chunks/deadbeef'],
  ])('%s', (path, expected) => {
    expect(resolveApiUrl(path, BASE)).toEqual({ ok: true, url: expected });
  });
});

describe('paths that are refused', () => {
  it.each([
    // Absolute, of any scheme. `file:` matters most — main can reach the disk.
    ['http://evil.test/steal', 'absolute-url'],
    ['https://evil.test/steal', 'absolute-url'],
    ['file:///etc/passwd', 'absolute-url'],
    ['data:text/html,x', 'absolute-url'],
    // Absolute in disguise. `new URL('//evil.test', base)` resolves to
    // `http://evil.test` — the single most-missed case in path validators.
    ['//evil.test/steal', 'scheme-relative'],
    ['//localhost:4000/api/../../x', 'scheme-relative'],
    // Normalised INTO scheme-relative by WHATWG parsers.
    ['/\\evil.test/steal', 'backslash'],
    ['\\\\evil.test\\steal', 'backslash'],
    // Climbing out of /api onto sibling routes, or off the app entirely.
    ['/../admin', 'traversal'],
    ['/projects/../../secret', 'traversal'],
    ['/%2e%2e/admin', 'traversal'],
    // Not a path at all.
    ['projects', 'empty'],
    ['', 'empty'],
  ])('%s → %s', (path, reason) => {
    expect(resolveApiUrl(path, BASE)).toEqual({ ok: false, reason });
  });

  it.each([
    [undefined], [null], [42], [{}], [['/projects']],
  ])('refuses a non-string (%p)', (path) => {
    expect(resolveApiUrl(path, BASE)).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('refuses a path that resolves onto a sibling of the base', () => {
    // The backstop, tested on its own: whatever the shape checks miss, the
    // result must still sit under `/api`.
    expect(resolveApiUrl('/../uploads/x', BASE)).toEqual({ ok: false, reason: 'traversal' });
    // And a base whose prefix merely shares characters is not the same prefix.
    expect(resolveApiUrl('/x', 'http://localhost:4000/api')).toEqual({
      ok: true,
      url: 'http://localhost:4000/api/x',
    });
  });
});

describe('the base URL is main s to decide', () => {
  const original = process.env.MOTION_BACKEND_ORIGIN;
  afterEach(() => {
    if (original === undefined) delete process.env.MOTION_BACKEND_ORIGIN;
    else process.env.MOTION_BACKEND_ORIGIN = original;
  });

  it('defaults to the local backend', () => {
    delete process.env.MOTION_BACKEND_ORIGIN;
    delete process.env.MOTION_BACKEND_PORT;
    expect(apiBaseUrl()).toBe('http://localhost:4000/api');
  });

  it('takes a deployed origin from the environment, never from a request', () => {
    // Note where this comes from: the process environment, which the renderer
    // cannot set. A base URL the renderer could supply is a base URL a
    // compromised renderer could point at its own server, and every request
    // after that would arrive there with a valid bearer.
    process.env.MOTION_BACKEND_ORIGIN = 'https://api.premation.app/';
    expect(apiBaseUrl()).toBe('https://api.premation.app/api');
  });
});

/**
 * ★ The packaged app must not talk to localhost.
 *
 * This is the 0.3.1 regression, and the shape is worth naming because it
 * recurs: `MOTION_BACKEND_ORIGIN` was the ONLY source main had, and nothing
 * anywhere set it — not the release workflow, not electron-builder, not main.
 * It appeared in this repo solely in the suite above, which passes by setting
 * the variable itself and therefore proved only that the READER worked.
 *
 * So every packaged build resolved to http://localhost:4000 on the end user's
 * machine. Desktop sign-in routes through main by design (tokens must not enter
 * the renderer) and every other call goes through `api.request`, which is also
 * main — so the whole backend was unreachable, and "login is broken" was merely
 * the first thing anyone tried.
 *
 * `VITE_BACKEND_ORIGIN` looked like the answer and is not: it reaches the
 * renderer bundle and the CSP built from it, neither of which main can read.
 * What these tests now hold is that the value ARRIVES, not just that a reader
 * can parse it.
 */
describe('a packaged build reads the origin baked into its manifest', () => {
  const originalEnv = process.env.MOTION_BACKEND_ORIGIN;
  const pkgPath = join(__dirname, '..', 'package.json');
  const originalPkg = readFileSync(pkgPath, 'utf8');

  beforeEach(() => {
    delete process.env.MOTION_BACKEND_ORIGIN;
    delete process.env.MOTION_BACKEND_PORT;
  });

  afterEach(() => {
    // Byte-for-byte, not a re-serialisation: this is the repo's real manifest
    // and a reformat here would show up as a spurious diff.
    writeFileSync(pkgPath, originalPkg);
    if (originalEnv === undefined) delete process.env.MOTION_BACKEND_ORIGIN;
    else process.env.MOTION_BACKEND_ORIGIN = originalEnv;
  });

  /** Write `backendOrigin` the way `npm pkg set` does at package time. */
  function bake(origin: unknown): void {
    const pkg = JSON.parse(originalPkg) as Record<string, unknown>;
    if (origin === undefined) delete pkg.backendOrigin;
    else pkg.backendOrigin = origin;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  it('uses the baked origin when no environment variable is set', () => {
    bake('https://motion-back-production.up.railway.app');
    expect(apiBaseUrl()).toBe('https://motion-back-production.up.railway.app/api');
  });

  it('strips a trailing slash from the baked value', () => {
    bake('https://api.premation.app/');
    expect(apiBaseUrl()).toBe('https://api.premation.app/api');
  });

  it('lets the environment override the baked value', () => {
    // So a packaged build can be pointed at staging without rebuilding it.
    bake('https://motion-back-production.up.railway.app');
    process.env.MOTION_BACKEND_ORIGIN = 'https://staging.premation.app';
    expect(apiBaseUrl()).toBe('https://staging.premation.app/api');
  });

  it('falls back to localhost when nothing is baked — the dev run', () => {
    // The repo's own package.json carries no `backendOrigin`, so running from
    // source keeps talking to a local server.
    bake(undefined);
    expect(apiBaseUrl()).toBe('http://localhost:4000/api');
  });

  it('ignores a non-string baked value rather than coercing it', () => {
    bake({ url: 'https://evil.test' });
    expect(apiBaseUrl()).toBe('http://localhost:4000/api');
  });
});
