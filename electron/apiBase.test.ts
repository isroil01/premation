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
