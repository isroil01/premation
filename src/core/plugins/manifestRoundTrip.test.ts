/**
 * ★ Parsing a manifest must be idempotent.
 *
 * `parseManifest(parseManifest(x).manifest)` has to equal `parseManifest(x)`,
 * and this is not a tidiness property. The installed-plugin index stores the
 * NORMALISED manifest, and `pluginStore`'s `normaliseManifest` runs it back
 * through `parseManifest` on every boot — dropping the record if it comes back
 * null. So an asymmetry between what the parser EMITS and what it ACCEPTS is
 * not a cosmetic inconsistency. It is every installed plugin vanishing at the
 * next launch, with no error anywhere, and the user reinstalling them by hand.
 *
 * That is exactly what shipped. Two emit/accept asymmetries, between them
 * covering every plugin that does not request network access:
 *
 *   • `emptyContributes()` writes `net: null` for "asks for no network", and
 *     the gate tested `!== undefined`. Below API 4 that read as "declares net,
 *     needs API 4"; at API 4 `parseNet(null)` read as "must be an object".
 *   • `parseManifest` always writes a `contributes` block, including for an
 *     API-1 manifest that never had one — and the API-1 gate refused any
 *     `contributes` at all, so it refused the app's own writing.
 *
 * The store's own tests could not catch this: they seed `localStorage` with
 * hand-written RAW records, which is the one input that parses once and is
 * never seen again. The bug lives strictly on the second parse.
 */

import { parseManifest } from './manifest';
import type { PluginManifest } from './manifest';

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'studio.acme.thing',
    name: 'Thing',
    version: '1.0.0',
    description: 'A plugin that does a thing.',
    apiVersion: 4,
    main: 'main.js',
    permissions: ['scene:read'],
    ...over,
  };
}

/**
 * One parse, then a parse of the result — through JSON, because that is the
 * shape the record survives in.
 */
function roundTrip(raw: unknown): { first: PluginManifest; second: PluginManifest } {
  const first = parseManifest(raw);
  expect(first.errors).toEqual([]);
  expect(first.manifest).not.toBeNull();

  const stored = JSON.parse(JSON.stringify(first.manifest)) as unknown;
  const second = parseManifest(stored);
  // The messages, not just the null — a failure here should say WHY on the
  // first run rather than after someone adds a console.log.
  expect(second.errors).toEqual([]);
  expect(second.manifest).not.toBeNull();
  return { first: first.manifest!, second: second.manifest! };
}

describe('a normalised manifest re-parses to itself', () => {
  // Every apiVersion, because the two asymmetries hit different ones: API 1 on
  // the `contributes` gate, 2 and 3 on "net requires API 4", and 4 on
  // `parseNet(null)`. A single version would have missed at least one.
  for (const apiVersion of [1, 2, 3, 4]) {
    it(`apiVersion ${apiVersion}, declaring nothing`, () => {
      const { first, second } = roundTrip(base({ apiVersion }));
      expect(second).toEqual(first);
    });
  }

  it('an API 1 package with a bare "panel" string', () => {
    // The legacy panel is normalised INTO `contributes.panels`, so the second
    // parse sees a shape the first never did.
    const { first, second } = roundTrip(base({ apiVersion: 1, panel: 'panel.html' }));
    expect(first.contributes.panels).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('commands, panels and activation events', () => {
    const { first, second } = roundTrip(base({
      apiVersion: 2,
      contributes: {
        commands: [{ id: 'do-thing', label: 'Do Thing', needsSelection: true }],
        panels: [{ id: 'main', title: 'Thing', entry: 'panel.html', placement: 'shared' }],
      },
      activationEvents: ['onCommand:do-thing', 'onPanel:main'],
    }));
    expect(second).toEqual(first);
    // Not vacuous: the referenced ids have to survive, or `parseActivationEvents`
    // would reject events pointing at contributions that came back empty.
    expect(second.activationEvents).toEqual(['onCommand:do-thing', 'onPanel:main']);
  });

  it('a declared net block, which is the one case that already worked', () => {
    const { first, second } = roundTrip(base({
      permissions: ['scene:read', 'net:fetch'],
      contributes: { net: { hosts: ['api.example.com'] } },
    }));
    expect(second).toEqual(first);
    expect(second.contributes.net?.hosts).toEqual(['api.example.com']);
  });

  it('survives a third parse — the third boot, not just the second', () => {
    const { second } = roundTrip(base({ apiVersion: 3 }));
    const third = parseManifest(JSON.parse(JSON.stringify(second)) as unknown);
    expect(third.errors).toEqual([]);
    expect(third.manifest).toEqual(second);
  });
});

describe('the version gates still refuse what they are for', () => {
  // Relaxing "the block exists" to "the block declares something" must not
  // relax the gate itself, or the fix above would have bought back-compat by
  // deleting the check.
  it('refuses a NON-EMPTY contributes block under apiVersion 1', () => {
    const r = parseManifest(base({
      apiVersion: 1,
      contributes: { commands: [{ id: 'do-thing', label: 'Do Thing' }] },
    }));
    expect(r.manifest).toBeNull();
    expect(r.errors.join(' ')).toContain('"apiVersion": 2');
  });

  it('refuses a real net block under apiVersion 3', () => {
    const r = parseManifest(base({
      apiVersion: 3,
      permissions: ['scene:read', 'net:fetch'],
      contributes: { net: { hosts: ['api.example.com'] } },
    }));
    expect(r.manifest).toBeNull();
    expect(r.errors.join(' ')).toContain('"apiVersion": 4');
  });

  it('still refuses a malformed net block at apiVersion 4', () => {
    const r = parseManifest(base({
      permissions: ['scene:read', 'net:fetch'],
      contributes: { net: { hosts: [] } },
    }));
    expect(r.manifest).toBeNull();
  });

  it('still refuses a net block declared without the permission', () => {
    const r = parseManifest(base({
      contributes: { net: { hosts: ['api.example.com'] } },
    }));
    expect(r.manifest).toBeNull();
  });
});
