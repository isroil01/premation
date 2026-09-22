/**
 * Every path this client names must exist on motion-back.
 *
 * The two repositories never import each other. On 2026-09-06 an audit found
 * five routes this client had been calling for weeks that the backend did not
 * have — the billing panel's cancel and resume, and the video, speech and 3D
 * generation tools — each failing at runtime as a generic error and passing
 * every test in both repositories. This is the gate that was missing.
 *
 * `__fixtures__/backend-routes.txt` is motion-back's `openapi/routes.txt`,
 * generated there by `npm run openapi` and verified fresh by its CI. Refresh
 * the copy here whenever the backend's routes change:
 *
 *   cp ../motion-back/openapi/routes.txt src/core/api/__fixtures__/backend-routes.txt
 *
 * Paths are compared with every parameter segment collapsed, and query strings
 * dropped, so `/projects/${id}/autosave` matches `/api/projects/{id}/autosave`.
 * Methods are not compared: the client builds them at call sites in ways a
 * regex cannot pair with the path reliably, and a wrong method on a real path
 * is the kind of mistake the type of the response catches.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Source files that name backend paths. Add to this list, never work around it. */
const CLIENT_SOURCES = [
  'src/core/api/client.ts',
  'src/core/api/cache.ts',
  'src/core/plugins/registry.ts',
  'src/layout/Motion/MotionPresetsPanel.tsx',
];

const ROOTS = /^\/(auth|projects|assets|render|ai|billing|sync|plugins|publishers|health|announcements|lessons|blog|waitlist|v1|admin|analytics)(\/|$|\?|\$)/;

const root = join(__dirname, '..', '..', '..');

function normalize(path: string): string {
  return path
    .replace(/\$\{query\([^)]*\)\}/g, '') // `${query({...})}` suffixes
    .replace(/\$\{[^}]*\}/g, '{}') // every other interpolation is a parameter
    .replace(/\{[^}]*\}/g, '{}') // OpenAPI `{id}`
    .replace(/\?.*$/, '') // query strings
    .replace(/\/$/, '');
}

function backendPaths(): Set<string> {
  const text = readFileSync(join(__dirname, '__fixtures__', 'backend-routes.txt'), 'utf8');
  const out = new Set<string>();
  // Tolerate CRLF: git's autocrlf rewrites the fixture on a Windows checkout.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [, path] = line.split(' ');
    if (path) out.add(normalize(path.replace(/^\/api/, '')));
  }
  return out;
}

function clientPaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of CLIENT_SOURCES) {
    const src = readFileSync(join(root, file), 'utf8');
    // A path literal: a quote or backtick, a slash, one of the API roots.
    const re = /[`'"](\/[a-z0-9][^`'"\s]*)[`'"]/gi;
    for (const m of src.matchAll(re)) {
      const raw = m[1];
      if (!raw || !ROOTS.test(raw)) continue;
      // Documentation strings, not calls.
      if (raw.includes('<') || raw.includes('...') || raw.includes(' ')) continue;
      const path = normalize(raw);
      const files = found.get(path) ?? [];
      if (!files.includes(file)) files.push(file);
      found.set(path, files);
    }
  }
  return found;
}

describe('backend route contract', () => {
  const backend = backendPaths();
  const client = clientPaths();

  it('found a meaningful number of paths on both sides', () => {
    expect(backend.size).toBeGreaterThan(100);
    expect(client.size).toBeGreaterThan(40);
  });

  it('names only paths motion-back serves', () => {
    const missing = [...client.entries()]
      .filter(([path]) => !backend.has(path))
      .map(([path, files]) => `${path}  (${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('includes the routes that were missing on 2026-09-06, so the gate is known to bite', () => {
    for (const path of ['/billing/cancel', '/billing/resume', '/ai/video', '/ai/speech', '/ai/3d']) {
      expect(client.has(path)).toBe(true);
      expect(backend.has(path)).toBe(true);
    }
  });
});
