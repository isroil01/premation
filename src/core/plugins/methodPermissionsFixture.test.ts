/**
 * `METHOD_PERMISSIONS` is mirrored in the registry, and must not drift.
 *
 * The editor uses this map as a GATE: every RPC is checked against it, and a
 * method absent from it is refused as unknown. The registry uses the same map
 * as a HEURISTIC: its publish-time scanner infers which permissions a package
 * actually uses by matching these method names in the package's source.
 *
 * Two different jobs, one table, two processes that cannot import each other.
 * Drift is quiet and asymmetric:
 *
 *   • A method added HERE and not there → the scanner sees a package calling it
 *     as using no permission, so a package that calls something it never asked
 *     for passes review unnoticed.
 *   • A method removed here and left there → the scanner reports a permission
 *     as unused when it is used, and sends a clean package to manual review.
 *     Publishers wait for nothing, and reviewers learn the flag means nothing.
 *
 * Neither shows up in either repo's own tests. Hence a byte-identical fixture
 * and a check on each side — the same shape `permissionStrings.test.ts` uses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_PERMISSIONS } from './protocol';
import { ALL_PERMISSIONS } from './manifest';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'methodPermissions.json'), 'utf8'),
) as { methodPermissions: Record<string, string> };

/**
 * Only the entries that HAVE a permission — the ones both sides must agree on.
 *
 * Typed explicitly: `Object.fromEntries` erases the narrowing the filter just
 * did, so without this the values are still `| null` and every consumer below
 * has to re-prove something the filter already guaranteed.
 */
const permissioned: Record<string, string> = Object.fromEntries(
  Object.entries(METHOD_PERMISSIONS).filter(
    (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null,
  ),
);

describe('the shared method→permission mapping', () => {
  it('matches the fixture exactly', () => {
    expect(permissioned).toEqual(fixture.methodPermissions);
  });

  it('maps only to permissions this host actually grants', () => {
    /*
      A method mapped to a permission that does not exist can never be granted,
      so the gate refuses it forever — and the refusal reads to the author as
      "the host is broken", because the consent screen never offered the
      permission they would have needed to say yes to.
    */
    const granted = new Set<string>(ALL_PERMISSIONS);
    const unknown = Object.entries(permissioned)
      .filter(([, p]) => !granted.has(p))
      .map(([method, p]) => `${method} → ${p}`);
    expect({ unknown }).toEqual({ unknown: [] });
  });

  it('omits methods that need no permission', () => {
    /*
      Deliberate. `ui.notify` and friends need no grant, so the two sides do not
      have to agree on them — and forcing them to would churn this fixture every
      time a convenience method is added, which is how a guard becomes something
      people update without reading.
    */
    const nullMethods = Object.entries(METHOD_PERMISSIONS)
      .filter(([, p]) => p === null)
      .map(([method]) => method);

    expect(nullMethods.length).toBeGreaterThan(0);
    for (const method of nullMethods) {
      expect(fixture.methodPermissions).not.toHaveProperty(method);
    }
  });
});
