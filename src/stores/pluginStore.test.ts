/**
 * What happens to an install that was written by an older build.
 *
 * Two migrations meet in this file, and both are the kind that fail silently
 * and late:
 *
 *  1. **Manifest normalisation.** A record persisted by an API-1 build has a
 *     `panel: "panel.html"` string and NO `contributes` / `activationEvents` at
 *     all. Every consumer added in API 2 reads `manifest.contributes.commands`
 *     directly — deliberately, because a key that is sometimes absent and
 *     sometimes empty is two representations of one state. So an unnormalised
 *     record does not degrade, it throws, at boot, before the editor has
 *     rendered. The user's plugins do not "stop working"; the app does.
 *
 *  2. **Payload relocation.** Package bytes moved from `localStorage` to
 *     IndexedDB. A half-finished move is the dangerous state: an index rewritten
 *     without its payload, before the payload was safely elsewhere, is a plugin
 *     whose code exists nowhere.
 *
 * A malformed record is DROPPED rather than repaired, in both cases. A
 * half-understood record handed to the sandbox loader is exactly the input the
 * shape check exists to refuse.
 */

import { usePluginStore, STORE_KEY } from './pluginStore';
import { PluginDatabase } from '@core/services/PluginDatabase';
import { parseManifest } from '@core/plugins/manifest';

/**
 * An in-memory stand-in for the package database.
 *
 * jsdom has no IndexedDB, and the real `PluginDatabase` swallows that and
 * returns `null` — which would make every assertion below pass vacuously while
 * testing nothing. The subject here is the STORE's migration logic, not
 * IndexedDB's own correctness, so a double is the honest instrument rather than
 * a shortcut.
 *
 * It models the INDEX store as well as the packages, because the index lives in
 * the database now too. The pair-writes are modelled as genuinely
 * all-or-nothing, which is what the real transaction gives: a double that wrote
 * one and then the other would let a torn write pass here and fail in a browser.
 */
jest.mock('@core/services/PluginDatabase', () => {
  const rows = new Map<string, unknown>();
  /** `undefined` means "no index record", which is NOT the same as `[]`. */
  let index: unknown;
  return {
    PluginDatabase: {
      get: jest.fn(async (id: string) => rows.get(id) ?? null),
      put: jest.fn(async (id: string, payload: unknown) => { rows.set(id, payload); return true; }),
      remove: jest.fn(async (id: string) => { rows.delete(id); }),
      keys: jest.fn(async () => [...rows.keys()]),
      getIndex: jest.fn(async () => index ?? null),
      putIndex: jest.fn(async (next: unknown) => { index = next; return true; }),
      putPackageAndIndex: jest.fn(async (id: string, payload: unknown, next: unknown) => {
        rows.set(id, payload); index = next; return true;
      }),
      removePackageAndIndex: jest.fn(async (id: string, next: unknown) => {
        rows.delete(id); index = next; return true;
      }),
      /** Test-only. Not on the real object; see the cast at the call site. */
      _reset: () => { rows.clear(); index = undefined; },
    },
  };
});

/** A record exactly as an API-1 build would have written it. */
function legacyRecord(id = 'com.legacy.a'): unknown {
  return {
    manifest: {
      id,
      name: 'Legacy',
      version: '1.0.0',
      description: 'Installed before API 2 existed.',
      apiVersion: 1,
      main: 'main.js',
      panel: 'panel.html',
      permissions: ['scene:read'],
    },
    files: {
      'main.js': 'export function activate() {}',
      'panel.html': '<p>panel</p>',
    },
    granted: ['scene:read'],
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
  };
}

/** Reload the store from whatever is currently in localStorage. */
async function reload(): Promise<void> {
  await usePluginStore.getState().rehydrateFromStorage();
}

beforeEach(() => {
  localStorage.clear();
  // `hydrated` is reset too. Leaving it set would let a later test inherit a
  // previous one's hydration and assert against a state it never established —
  // the classic way a suite passes in order and fails alone.
  usePluginStore.setState({ plugins: [], hydrated: false, lastHydration: null });
  // The whole database, not two known ids. The index is a single record that
  // every test writes, so leaving it behind makes the second test in the file
  // read the first one's install list and skip the migration entirely.
  (PluginDatabase as unknown as { _reset(): void })._reset();
});

describe('manifest normalisation on load', () => {
  it('gives an API 1 record the contributes block every consumer reads', async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();

    const entry = usePluginStore.getState().get('com.legacy.a');
    // Without this, `registerContributions` reads `.commands` off undefined and
    // throws during `pluginHost.configure()` — i.e. at boot.
    expect(entry?.manifest.contributes).toEqual({
      commands: [],
      // Normalised placement too — a stored API-1 record is re-parsed on load,
      // so it comes back with the field every consumer now reads.
      panels: [{ id: 'main', title: 'Legacy', entry: 'panel.html', placement: 'shared' }],
      // The reserved keys are present-and-empty too. Every sub-key exists after
      // normalisation, so no consumer needs a `?? []`.
      layerKinds: [],
      effects: [],
      // `net` is present as `null`, which is the same discipline stated
      // differently: no network at all is a real state and gets a real value.
      // The empty list is NOT its zero — "reach nowhere" is refused at parse
      // rather than normalised into "no access".
      net: null,
    });
  });

  it('gives it activationEvents, defaulting to the API 1 behaviour', async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();
    // An API-1 plugin was always started at launch, and normalising it to
    // anything else would silently change when the user's plugins run.
    expect(usePluginStore.getState().get('com.legacy.a')?.manifest.activationEvents)
      .toEqual(['onStartup']);
  });

  it('normalises through the real validator rather than a second code path', async () => {
    // The legacy `panel` string is gone afterwards, because normalisation is
    // `parseManifest` itself. A hand-rolled migration here would be a second
    // definition of the manifest format, free to drift from the first.
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();
    const manifest = usePluginStore.getState().get('com.legacy.a')!.manifest as unknown as Record<string, unknown>;
    expect(manifest.panel).toBeUndefined();
  });

  it('leaves an already-normalised API 2 record alone', async () => {
    const modern = {
      ...(legacyRecord('com.modern.a') as Record<string, unknown>),
      manifest: {
        id: 'com.modern.a',
        name: 'Modern',
        version: '1.0.0',
        description: 'Already API 2.',
        apiVersion: 2,
        main: 'main.js',
        permissions: [],
        contributes: {
          commands: [{ id: 'go', label: 'Go' }],
          panels: [],
          layerKinds: [],
          effects: [],
        },
        activationEvents: ['onCommand:go'],
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([modern]));
    await reload();

    const entry = usePluginStore.getState().get('com.modern.a');
    expect(entry?.manifest.contributes.commands).toEqual([{ id: 'go', label: 'Go' }]);
    expect(entry?.manifest.activationEvents).toEqual(['onCommand:go']);
  });

  it('drops a record whose manifest no longer validates', async () => {
    // Dropped, not repaired. This survived a reload, an app upgrade and
    // possibly a hand-edited localStorage; guessing at what it meant is how a
    // half-understood record reaches the sandbox loader.
    const broken = legacyRecord() as Record<string, unknown>;
    (broken.manifest as Record<string, unknown>).id = 'NOT REVERSE DNS';
    localStorage.setItem(STORE_KEY, JSON.stringify([broken]));
    await reload();
    expect(usePluginStore.getState().plugins).toEqual([]);
  });

  it('drops a structurally malformed record without taking the good ones with it', async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([
      { nonsense: true },
      null,
      legacyRecord(),
    ]));
    await reload();
    // One bad row must not cost the user every plugin they installed.
    expect(usePluginStore.getState().plugins.map((p) => p.manifest.id)).toEqual(['com.legacy.a']);
  });

  it('survives localStorage holding something that is not JSON at all', async () => {
    localStorage.setItem(STORE_KEY, 'not json {{{');
    await reload();
    expect(usePluginStore.getState().plugins).toEqual([]);
  });
});

describe('payload relocation to IndexedDB', () => {
  it('moves a legacy record s files into the database', async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();
    await usePluginStore.getState().hydrate();

    const payload = await PluginDatabase.get('com.legacy.a');
    expect(payload?.files['main.js']).toBe('export function activate() {}');
  });

  it('rewrites the index WITHOUT the payload once it is safely moved', async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();
    await usePluginStore.getState().hydrate();

    const stored = (await PluginDatabase.getIndex()) as Array<Record<string, unknown>>;
    // The whole point of the move: package bytes must stop sharing an origin
    // quota with the account JWT and the user's plaintext AI provider keys.
    expect(stored[0]!.files).toBeUndefined();
    expect(stored[0]!.binaries).toBeUndefined();
    // …and the manifest is still there, because that is what boot reads.
    expect((stored[0]!.manifest as { id: string }).id).toBe('com.legacy.a');
  });

  it('clears the legacy localStorage key once the index is verified in the database', async () => {
    // The index followed the payloads out of `localStorage`, so that key is now
    // a migration source and nothing else. Leaving it behind would mean a
    // machine that later downgrades resurrects a stale install list.
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();
    await usePluginStore.getState().hydrate();

    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('keeps the files in memory after the move, so the plugin can still start', async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();
    await usePluginStore.getState().hydrate();
    // `PluginHost.start` reads `entry.files[manifest.main]`. A migration that
    // relocated the bytes and forgot to keep them addressable would leave every
    // installed plugin unable to boot until the next reload.
    expect(usePluginStore.getState().get('com.legacy.a')?.files['main.js']).toBeDefined();
  });

  it('drops an index entry whose payload is missing, and says so', async () => {
    // The two stores are written separately, so a crash or a quota failure
    // between them leaves an entry the manager lists and nothing can start.
    // Left alone that presents as "this plugin is broken", forever, with no
    // cause and no cure but a manual uninstall.
    const withoutFiles = legacyRecord() as Record<string, unknown>;
    delete withoutFiles.files;
    localStorage.setItem(STORE_KEY, JSON.stringify([withoutFiles]));

    await reload();
    await usePluginStore.getState().hydrate();

    expect(usePluginStore.getState().plugins).toEqual([]);
    // Reported, not swallowed. Silently removing something a user installed is
    // exactly the behaviour that makes people distrust a plugin manager.
    expect(usePluginStore.getState().lastHydration?.droppedNoPayload).toEqual(['com.legacy.a']);
  });

  it('garbage-collects a payload with no index entry, and says so', async () => {
    // The opposite direction: megabytes of a plugin the user believes they
    // removed, invisible from every surface, kept until the origin is cleared.
    await PluginDatabase.put('com.orphan.a', { files: { 'main.js': 'x' }, binaries: {} });
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));

    await reload();
    await usePluginStore.getState().hydrate();

    expect(await PluginDatabase.get('com.orphan.a')).toBeNull();
    expect(usePluginStore.getState().lastHydration?.orphansRemoved).toEqual(['com.orphan.a']);
  });

  it('does not mistake a freshly migrated plugin for an orphan', async () => {
    // The ordering trap: orphan collection runs after the legacy move, so a
    // record whose payload was only just written has to be recognised as known.
    // Get this wrong and hydration deletes the package it has this second saved.
    localStorage.setItem(STORE_KEY, JSON.stringify([legacyRecord()]));
    await reload();
    await usePluginStore.getState().hydrate();

    expect(usePluginStore.getState().lastHydration?.orphansRemoved).toEqual([]);
    expect(await PluginDatabase.get('com.legacy.a')).not.toBeNull();
  });

  it('marks the store hydrated, which is what lets the host start', async () => {
    expect(usePluginStore.getState().hydrated).toBe(false);
    await usePluginStore.getState().hydrate();
    expect(usePluginStore.getState().hydrated).toBe(true);
  });

  it('hydrates an empty install set rather than staying unhydrated forever', async () => {
    // A fresh user has nothing installed. An early return that skipped the flag
    // would make `configure()` throw for exactly the people with no plugins.
    localStorage.clear();
    await reload();
    await usePluginStore.getState().hydrate();
    expect(usePluginStore.getState().hydrated).toBe(true);
  });

  it('reads a payload back out of the database on a later load', async () => {
    // The second launch: the index has no files, and they come from IndexedDB.
    await PluginDatabase.put('com.legacy.a', {
      files: { 'main.js': 'export function activate() {}' },
      binaries: {},
    });
    const withoutFiles = legacyRecord() as Record<string, unknown>;
    delete withoutFiles.files;
    localStorage.setItem(STORE_KEY, JSON.stringify([withoutFiles]));

    await reload();
    await usePluginStore.getState().hydrate();
    expect(usePluginStore.getState().get('com.legacy.a')?.files['main.js']).toBeDefined();
  });
});

/**
 * ★ An install survives being restarted. Repeatedly.
 *
 * Everything above seeds a HAND-WRITTEN record and hydrates it once, which is
 * the migration path — and it is the one path that never re-reads what this
 * build itself wrote. So a parser that emitted a manifest it would not accept
 * passed every test in this file while deleting every user's plugins at their
 * second launch, silently, for as long as it shipped.
 *
 * This closes that: install exactly as the consent screen does, then hydrate
 * twice, because the failure lives on the SECOND parse and a single reload
 * cannot see it.
 */
describe('an install survives a restart', () => {
  /** A record built the way `PluginHost.install` builds one: a PARSED manifest. */
  function installed(apiVersion: number, over: Record<string, unknown> = {}): void {
    const { manifest, errors } = parseManifest({
      id: 'studio.acme.thing',
      name: 'Thing',
      version: '1.0.0',
      description: 'A plugin that does a thing.',
      apiVersion,
      main: 'main.js',
      permissions: ['scene:read'],
      ...over,
    });
    expect(errors).toEqual([]);
    usePluginStore.getState().put({
      manifest: manifest!,
      files: { 'main.js': 'export function activate() {}' },
      binaries: {},
      granted: ['scene:read'],
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: 'registry',
    });
  }

  /** Boot again: a fresh store reading only what is in the database. */
  async function restart(): Promise<void> {
    localStorage.clear();
    usePluginStore.setState({ plugins: [], hydrated: false, lastHydration: null });
    await usePluginStore.getState().hydrate();
  }

  // Every apiVersion, because the asymmetries that caused this hit different
  // ones — the `contributes` gate at 1, "net requires API 4" at 2 and 3, and
  // `parseNet(null)` at 4. Only a plugin that declared network access survived.
  for (const apiVersion of [1, 2, 3, 4]) {
    it(`apiVersion ${apiVersion}: still installed after two restarts`, async () => {
      installed(apiVersion);
      await restart();
      expect(usePluginStore.getState().get('studio.acme.thing')).toBeDefined();
      await restart();
      const still = usePluginStore.getState().get('studio.acme.thing');
      expect(still).toBeDefined();
      // Not merely listed — startable. A record whose payload was swept by the
      // orphan pass lists once and cannot run.
      expect(still?.files['main.js']).toBeDefined();
      expect(usePluginStore.getState().lastHydration?.droppedInvalid).toEqual([]);
    });
  }

  it('an API 1 package with a bare "panel" survives too', async () => {
    installed(1, { panel: 'panel.html' });
    await restart();
    await restart();
    expect(usePluginStore.getState().get('studio.acme.thing')).toBeDefined();
  });

  it('keeps the grants and the enabled flag across the restart', async () => {
    installed(4);
    usePluginStore.getState().setEnabled('studio.acme.thing', false);
    await restart();
    const entry = usePluginStore.getState().get('studio.acme.thing');
    expect(entry?.enabled).toBe(false);
    expect(entry?.granted).toEqual(['scene:read']);
  });

  it('reports an unreadable record instead of dropping it in silence', async () => {
    // The diagnosis channel, not the bug: a record this build genuinely cannot
    // read must reach `lastHydration` with its reason attached.
    await PluginDatabase.putIndex([
      { manifest: { id: 'studio.acme.broken', apiVersion: 99 }, granted: [] },
    ]);
    usePluginStore.setState({ plugins: [], hydrated: false, lastHydration: null });
    await usePluginStore.getState().hydrate();

    const invalid = usePluginStore.getState().lastHydration?.droppedInvalid ?? [];
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.id).toBe('studio.acme.broken');
    expect(invalid[0]!.reason).not.toBe('');
  });
});
