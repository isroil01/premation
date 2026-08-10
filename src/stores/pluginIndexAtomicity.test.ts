/**
 * The index and the package are written together, and the move off
 * `localStorage` cannot lose a user's plugins.
 *
 * ── The class of bug this removes ────────────────────────────────────────────
 *
 * Package bytes lived in IndexedDB and the metadata index in `localStorage`.
 * Two storage systems, two writes, no way to commit them together — so a crash,
 * a quota failure, or a browser clearing one origin store between them left the
 * pair disagreeing, in either direction:
 *
 *   • **Index without payload** — a plugin the manager lists that can never
 *     start. It reads as "this plugin is broken", with no cause and no cure but
 *     a manual uninstall.
 *   • **Payload without index** — megabytes of a plugin the user believes they
 *     removed, invisible from every surface until the origin is cleared.
 *
 * `hydrate()` existed to clean up after both, and it stays: it still catches an
 * aborted transaction, a database the browser dropped, and every record written
 * by a build predating this. What goes away is the class where OUR code
 * produced the inconsistency, because there are no longer two writes.
 *
 * ── What is asserted here, and what deliberately is not ─────────────────────
 *
 * Atomicity belongs to IndexedDB. Re-testing it would be testing the browser,
 * and this environment has no IndexedDB to test it against — `PluginDatabase`
 * degrades to no-ops in jsdom, which is why the real database is mocked.
 *
 * What IS ours, and is asserted: that the store reaches for the combined write
 * rather than two separate ones, and that the one-time migration is ordered so
 * that no failure can lose the list.
 */

jest.mock('@core/services/PluginDatabase', () => ({
  PluginDatabase: {
    get: jest.fn().mockResolvedValue(null),
    put: jest.fn().mockResolvedValue(true),
    remove: jest.fn().mockResolvedValue(undefined),
    keys: jest.fn().mockResolvedValue([]),
    getStorage: jest.fn().mockResolvedValue(null),
    putStorage: jest.fn().mockResolvedValue(true),
    getIndex: jest.fn().mockResolvedValue(null),
    putIndex: jest.fn().mockResolvedValue(true),
    putPackageAndIndex: jest.fn().mockResolvedValue(true),
    removePackageAndIndex: jest.fn().mockResolvedValue(true),
  },
}));

import { PluginDatabase } from '@core/services/PluginDatabase';
import { usePluginStore, STORE_KEY, type InstalledPlugin } from './pluginStore';

const db = PluginDatabase as jest.Mocked<typeof PluginDatabase>;

const MANIFEST = {
  id: 'studio.acme.thing',
  name: 'Thing',
  version: '1.0.0',
  description: 'A plugin used by the storage tests.',
  apiVersion: 5,
  main: 'main.js',
  permissions: [],
  // No `net` key. `null` is what the parser NORMALISES an absent one to, and
  // feeding that back in is rejected — "reach nowhere" is not a thing a
  // manifest may say.
  contributes: { commands: [], panels: [], layerKinds: [], effects: [] },
  activationEvents: ['onStartup'],
};

const entry = (): InstalledPlugin => ({
  manifest: MANIFEST,
  granted: [],
  enabled: true,
  files: { 'main.js': 'export function activate(){}' },
  binaries: {},
  installedAt: 0,
} as never);

beforeEach(() => {
  jest.clearAllMocks();
  db.getIndex.mockResolvedValue(null);
  localStorage.clear();
  usePluginStore.setState({ plugins: [], hydrated: false, lastHydration: null });
});

describe('writing', () => {
  it('sends the package and the index in ONE call', () => {
    /*
      The whole item, in one assertion. Two calls means two transactions means
      the torn write is back — and it would still pass every test that only
      checks the plugin ends up installed.
    */
    usePluginStore.getState().put(entry());

    expect(db.putPackageAndIndex).toHaveBeenCalledTimes(1);
    expect(db.put).not.toHaveBeenCalled();
    expect(db.putIndex).not.toHaveBeenCalled();

    const [id, payload, index] = db.putPackageAndIndex.mock.calls[0]!;
    expect(id).toBe('studio.acme.thing');
    expect(payload.files['main.js']).toContain('activate');
    expect(index).toHaveLength(1);
  });

  it('strips the package bytes out of the index', () => {
    // The reason the index is small enough to hold in one record at all — and
    // the reason a 2 MB texture in a package cannot make the index write fail.
    usePluginStore.getState().put(entry());
    const index = db.putPackageAndIndex.mock.calls[0]![2] as Array<Record<string, unknown>>;
    expect(index[0]).not.toHaveProperty('files');
    expect(index[0]).not.toHaveProperty('binaries');
    expect(index[0]!.manifest).toMatchObject({ id: 'studio.acme.thing' });
  });

  it('sends the delete and the index in ONE call', () => {
    // The same torn write with the sign flipped: a package whose index entry is
    // gone is the orphan `hydrate()` had to hunt for.
    usePluginStore.getState().put(entry());
    jest.clearAllMocks();

    usePluginStore.getState().remove('studio.acme.thing');

    expect(db.removePackageAndIndex).toHaveBeenCalledTimes(1);
    expect(db.remove).not.toHaveBeenCalled();
    expect(db.removePackageAndIndex.mock.calls[0]![1]).toEqual([]);
  });

  it('writes the index alone for a change that touches no bytes', () => {
    // Narrowing a grant rewrites metadata and nothing else. Dragging the
    // package through that write would make every permission edit rewrite
    // megabytes.
    usePluginStore.getState().put(entry());
    jest.clearAllMocks();

    usePluginStore.getState().setGranted('studio.acme.thing', []);

    expect(db.putIndex).toHaveBeenCalledTimes(1);
    expect(db.putPackageAndIndex).not.toHaveBeenCalled();
  });
});

describe('the one-time migration off localStorage', () => {
  /** A legacy index, as a pre-move build left it. */
  function seedLegacy(): void {
    localStorage.setItem(STORE_KEY, JSON.stringify([
      { manifest: MANIFEST, granted: [], enabled: true, installedAt: 0 },
    ]));
    usePluginStore.getState().rehydrateFromStorage();
  }

  it('moves the list, then clears the old key', async () => {
    seedLegacy();
    db.getIndex
      .mockResolvedValueOnce(null)                 // nothing in the new home yet
      .mockResolvedValueOnce([{ manifest: MANIFEST, granted: [] }]); // verified back

    await usePluginStore.getState().hydrate();

    expect(db.putIndex).toHaveBeenCalled();
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('does NOT clear the old key when the new write failed', async () => {
    /*
      Ordering, and it is the whole safety of the migration. Clearing first and
      writing second would lose every installed plugin the one time the write
      fails — the single outcome worse than not migrating at all.
    */
    seedLegacy();
    db.putIndex.mockResolvedValue(false);

    await usePluginStore.getState().hydrate();

    expect(localStorage.getItem(STORE_KEY)).not.toBeNull();
  });

  it('does NOT clear the old key when the write cannot be read back', async () => {
    // `putIndex` resolving true is a promise, not a fact. The old copy survives
    // until the new one has actually been read.
    seedLegacy();
    db.putIndex.mockResolvedValue(true);
    db.getIndex.mockResolvedValue(null);

    await usePluginStore.getState().hydrate();

    expect(localStorage.getItem(STORE_KEY)).not.toBeNull();
  });

  it('does not migrate over an index that exists and is EMPTY', async () => {
    /*
      `null` and `[]` are different answers and the distinction is load-bearing:
      "there is no index here" means migrate, "there is an index listing nothing"
      means the user uninstalled everything after the move. Confusing them
      resurrects deleted plugins on the next launch.
    */
    seedLegacy();
    db.getIndex.mockResolvedValue([]);

    await usePluginStore.getState().hydrate();

    // Not "putIndex was never called" — hydration rewrites the index at the end
    // regardless. The claim is that nothing it wrote contains the legacy list.
    for (const [written] of db.putIndex.mock.calls) {
      expect(written).toEqual([]);
    }
    expect(usePluginStore.getState().plugins).toEqual([]);
    expect(localStorage.getItem(STORE_KEY)).not.toBeNull();
  });

  it('prefers the new home once it has anything in it', async () => {
    seedLegacy();
    db.getIndex.mockResolvedValue([
      { manifest: { ...MANIFEST, id: 'studio.other.newer' }, granted: [] },
    ]);
    db.get.mockResolvedValue({ files: { 'main.js': 'x' }, binaries: {} });

    await usePluginStore.getState().hydrate();

    expect(usePluginStore.getState().plugins.map((p) => p.manifest.id))
      .toEqual(['studio.other.newer']);
  });
});

describe('hydrate still reconciles', () => {
  it('drops an index entry whose package is missing, and reports it', async () => {
    /*
      Kept, deliberately. The combined transaction removes the inconsistencies
      THIS code can create; it does not remove the ones a browser can — an
      aborted transaction, an evicted database, a record from an older build.
      Silently dropping something a user installed is what makes people
      distrust a plugin manager, so it is still reported.
    */
    db.getIndex.mockResolvedValue([{ manifest: MANIFEST, granted: [] }]);
    db.get.mockResolvedValue(null);

    await usePluginStore.getState().hydrate();

    expect(usePluginStore.getState().plugins).toEqual([]);
    expect(usePluginStore.getState().lastHydration?.droppedNoPayload)
      .toEqual(['studio.acme.thing']);
  });

  it('frees a package no index entry points at', async () => {
    db.getIndex.mockResolvedValue([]);
    db.keys.mockResolvedValue(['studio.ghost.app']);

    await usePluginStore.getState().hydrate();

    expect(db.remove).toHaveBeenCalledWith('studio.ghost.app');
    expect(usePluginStore.getState().lastHydration?.orphansRemoved)
      .toEqual(['studio.ghost.app']);
  });
});
