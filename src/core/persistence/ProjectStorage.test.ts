/**
 * RoutedProjectStorage — which strategy a save/open lands on.
 *
 * Locks the LOCAL_FIRST contract: bundles are only CREATED under the flag, but a
 * bundle already on disk always OPENS as a bundle (so turning the flag off never
 * strands saved work), and single-file paths always stay single-file.
 */

import { FileProjectStorage, BundleProjectStorage, RoutedProjectStorage, type ProjectStorage } from './ProjectStorage';
import { BundleRepository } from '@core/project/bundle/BundleRepository';
import { MemoryBundleFs } from '@core/project/bundle/BundleFs';
import type { VersionedDocument } from '@core/types';

const DOC = { version: '1.1.0' } as VersionedDocument;
const BUNDLE = '/p/My.motion';
const FILE = '/p/My.json';

/** A ProjectStorage that records the paths it was asked to save/load. */
function fakeFile(): { storage: ProjectStorage; saved: string[]; loaded: string[] } {
  const saved: string[] = [];
  const loaded: string[] = [];
  const store = new Map<string, VersionedDocument>();
  const storage: ProjectStorage = {
    async save(path, doc) {
      saved.push(path);
      store.set(path, doc);
    },
    async load(path) {
      loaded.push(path);
      return store.get(path) ?? null;
    },
  };
  return { storage, saved, loaded };
}

function routed(localFirst: () => boolean) {
  const file = fakeFile();
  const bundle = new BundleProjectStorage(new BundleRepository(new MemoryBundleFs()));
  const storage = new RoutedProjectStorage(file.storage, bundle, localFirst);
  return { storage, file, bundle };
}

describe('save routing', () => {
  it('writes a bundle for a .motion path when LOCAL_FIRST is on', async () => {
    const { storage, file, bundle } = routed(() => true);
    await storage.save(BUNDLE, DOC);
    expect(file.saved).toEqual([]); // did not go to single-file
    expect(await bundle.has(BUNDLE)).toBe(true);
  });

  it('stays single-file for a .motion path when the flag is off', async () => {
    const { storage, file, bundle } = routed(() => false);
    await storage.save(BUNDLE, DOC);
    expect(file.saved).toEqual([BUNDLE]);
    expect(await bundle.has(BUNDLE)).toBe(false);
  });

  it('stays single-file for a non-bundle path even with the flag on', async () => {
    const { storage, file } = routed(() => true);
    await storage.save(FILE, DOC);
    expect(file.saved).toEqual([FILE]);
  });
});

describe('load routing', () => {
  it('opens an existing bundle as a bundle regardless of the flag', async () => {
    const { file, bundle } = routed(() => true);
    await bundle.save(BUNDLE, DOC); // bundle now on disk
    const offStorage = new RoutedProjectStorage(file.storage, bundle, () => false);
    const loaded = await offStorage.load(BUNDLE);
    expect(loaded).toMatchObject({ version: '1.1.0' });
    expect(file.loaded).toEqual([]); // never fell through to single-file
  });

  it('falls back to single-file for a .motion path with no bundle present', async () => {
    const { storage, file } = routed(() => true);
    await storage.load(BUNDLE);
    expect(file.loaded).toEqual([BUNDLE]);
  });

  it('loads a non-bundle path from single-file', async () => {
    const { storage, file } = routed(() => true);
    await storage.load(FILE);
    expect(file.loaded).toEqual([FILE]);
  });
});

describe('FileProjectStorage', () => {
  it('round-trips through the injected service + file manager', async () => {
    const store = new Map<string, string>();
    const files = {
      write: async (p: string, c: string) => void store.set(p, c),
      read: async (p: string) => store.get(p) ?? null,
    } as never;
    const service = { serialize: (d: unknown) => JSON.stringify(d), parse: (c: string) => JSON.parse(c) } as never;
    const fs = new FileProjectStorage(service, files);
    await fs.save(FILE, DOC);
    expect(await fs.load(FILE)).toEqual(DOC);
  });
});
