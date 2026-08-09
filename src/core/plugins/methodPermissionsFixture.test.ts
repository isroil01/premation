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
import { createHostApi } from './hostApi';
import { ALL_PERMISSIONS, HOST_API_VERSION } from './manifest';

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

describe('the table covers every method the host actually implements', () => {
  /**
   * A host API built with stub hooks. Nothing is invoked; only the KEYS matter.
   *
   * Constructed rather than read from a list, because a list would be a second
   * inventory of the implementation — the same drift, one layer along.
   */
  const implemented = new Set(
    Object.keys(createHostApi(
      {
        id: 'test.enumerate.methods',
        name: 'Enumerate',
        version: '1.0.0',
        description: 'Built for its key set.',
        apiVersion: HOST_API_VERSION,
        main: 'main.js',
        permissions: [],
        contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
        activationEvents: ['onStartup'],
      } as never,
      {
        registerCommand: () => {},
        openPanel: () => {},
        closePanel: () => {},
        warn: () => {},
      },
    )),
  );

  const declared = new Set(Object.keys(METHOD_PERMISSIONS));

  it('finds a host API worth checking', () => {
    // Guards the guard: a `createHostApi` that returned `{}` would make both
    // assertions below pass while proving nothing.
    expect(implemented.size).toBeGreaterThanOrEqual(30);
  });

  it('declares a permission for every implemented method', () => {
    /*
      The completeness half, and what makes the cross-repo checksum mean
      something.

      A handler added to `hostApi.ts` with no `METHOD_PERMISSIONS` entry is
      refused at runtime as an unknown method — safe, but silently broken and
      invisible in review: the author's plugin calls it and is told the method
      does not exist, while the fixture never changes, so the sibling
      repository's CI never learns the surface grew. Making the fixture
      unavoidable is the entire point of hashing it.
    */
    const undeclared = [...implemented].filter((m) => !declared.has(m));
    expect({ undeclared }).toEqual({ undeclared: [] });
  });

  it('implements every method it declares', () => {
    /*
      The other direction. A `METHOD_PERMISSIONS` entry with no handler is a
      method the gate waves through to nothing — and the registry's scanner
      treats the same table as evidence that a package uses a permission, so a
      publisher can be sent to manual review over a call that could never have
      done anything.
    */
    const unimplemented = [...declared].filter((m) => !implemented.has(m));
    expect({ unimplemented }).toEqual({ unimplemented: [] });
  });
});
