/**
 * Documents written before `projectItems` existed (and bundles written before
 * the bundle had a `project.json`): their folders, folder assignments,
 * interpretation, tags and labels lived in this machine's localStorage. They
 * are migrated into the document the first time such a project is opened —
 * from a copy of that cache frozen before any document edit could overwrite it
 * — and once the document carries them the cache is never applied again.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupEngine, type Harness } from '@core/engine/__testHelpers__/harness';
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import {
  useAssetStore,
  applyProjectItems,
  freezeLegacyProjectItems,
  legacyProjectItems,
  withDocumentItems,
  LEGACY_ITEMS_KEY,
  type ImportedAsset,
} from '@stores/assetStore';
import { decodeBundle } from '@core/project/bundle/bundleCodec';
import { setLocalFirst } from '@core/config/flags';
import { restoreBundleAssets } from '@core/assets/local/bundleAssetCollect';
import { readBundleAssets } from '@core/assets/local/bundleAssetSync';

jest.mock('@core/assets/local/bundleAssetSync', () => ({
  ...jest.requireActual('@core/assets/local/bundleAssetSync'),
  readBundleAssets: jest.fn(async () => []),
}));

jest.useFakeTimers();

/** The localStorage keys the pre-document builds wrote (assetStore.ts, before B2). */
const OLD = {
  folders: 'motion-editor.assetFolders.v1',
  assign: 'motion-editor.assetFolderAssignments.v1',
  interp: 'motion-editor.assetInterpretations.v1',
  org: 'motion-editor.assetOrganisation.v1',
};

function writeLegacyCache(v: { conform: number; folderName: string }): void {
  localStorage.setItem(OLD.folders, JSON.stringify([
    { id: 'f_old', name: v.folderName, parentId: null },
    { id: 'f_old_sub', name: 'Sub', parentId: 'f_old' },
  ]));
  localStorage.setItem(OLD.assign, JSON.stringify({ asset_plate: 'f_old_sub' }));
  localStorage.setItem(OLD.interp, JSON.stringify({ asset_plate: { conformFps: v.conform, loopCount: 2 } }));
  localStorage.setItem(OLD.org, JSON.stringify({ asset_plate: { tags: ['old tag'], label: '#ff0000' } }));
}

function oldBundleDoc(): EditorDocument {
  const files = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'pre-items-bundle-1.8.0.json'), 'utf8')) as Record<string, string>;
  return decodeBundle(files);
}

const plate = (): ImportedAsset => ({ id: 'asset_plate', name: 'plate.mp4', type: 'video', src: 'blob:live/plate', size: 10 });

let h: Harness;
beforeEach(async () => {
  h = await setupEngine();
  localStorage.clear();
  writeLegacyCache({ conform: 24, folderName: 'Old Footage' });
  freezeLegacyProjectItems();
});
afterEach(async () => {
  setLocalFirst(false);
  await h.dispose();
});

test('the pre-document cache is frozen once and never rewritten', () => {
  const first = localStorage.getItem(LEGACY_ITEMS_KEY);
  expect(JSON.parse(first!).folders.map((f: { id: string }) => f.id)).toEqual(['f_old', 'f_old_sub']);
  // Any later document edit rewrites the live keys with the CURRENT project.
  writeLegacyCache({ conform: 60, folderName: 'Someone else' });
  freezeLegacyProjectItems();
  expect(localStorage.getItem(LEGACY_ITEMS_KEY)).toBe(first);
  expect(legacyProjectItems(['asset_plate']).footage.asset_plate!.interpret).toEqual({ conformFps: 24, loopCount: 2 });
});

test('an old-format bundle (1.8.0, no project.json) still opens', () => {
  const doc = oldBundleDoc();
  expect(doc.version).toBe('1.8.0');
  expect(doc.projectItems).toBeUndefined();
  expect(() => restoreDocument(doc)).not.toThrow();
  expect(useAssetStore.getState().folders.map((f) => f.name)).toEqual(['Old Footage', 'Sub']);
});

test('opening an older project migrates its organisation into the document', () => {
  useAssetStore.setState((s) => {
    s.assets = [plate()];
  });
  restoreDocument(oldBundleDoc());
  const a = useAssetStore.getState().assets[0]!;
  expect(a.folderId).toBe('f_old_sub');
  expect(a.interpret).toEqual({ conformFps: 24, loopCount: 2 });
  expect(a.tags).toEqual(['old tag']);
  expect(a.label).toBe('#ff0000');
  // …and the next save writes it into the file.
  const saved = captureDocument();
  expect(saved.projectItems!.folders.map((f) => [f.id, f.parentId])).toEqual([['f_old', null], ['f_old_sub', 'f_old']]);
  expect(saved.projectItems!.footage.asset_plate).toMatchObject({ folderId: 'f_old_sub', interpret: { conformFps: 24, loopCount: 2 }, tags: ['old tag'] });
});

test('once migrated, the cache is never applied again', () => {
  useAssetStore.setState((s) => {
    s.assets = [plate()];
  });
  restoreDocument(oldBundleDoc());
  // The user re-files and un-conforms the footage, then saves.
  useAssetStore.setState((s) => {
    s.assets[0]!.folderId = 'f_old';
    delete s.assets[0]!.interpret;
    delete s.assets[0]!.tags;
  });
  const saved = captureDocument();
  expect(saved.projectItems).toBeDefined();

  // A different cache on the next launch — and a stale frozen copy too.
  writeLegacyCache({ conform: 60, folderName: 'Someone else' });
  localStorage.removeItem(LEGACY_ITEMS_KEY);
  freezeLegacyProjectItems();
  useAssetStore.setState((s) => {
    s.assets = [{ ...plate(), folderId: 'f_old_sub', interpret: { conformFps: 60 }, tags: ['stale'] }];
  });
  applyProjectItems(undefined);
  restoreDocument(JSON.parse(JSON.stringify(saved)) as EditorDocument);

  const a = useAssetStore.getState().assets[0]!;
  expect(a.folderId).toBe('f_old');
  expect(a.interpret).toBeUndefined();
  expect(a.tags).toBeUndefined();
  expect(useAssetStore.getState().folders.map((f) => f.name)).toEqual(['Old Footage', 'Sub']);
});

test('footage the old document references but the session lacks is patched when it arrives', () => {
  useAssetStore.setState((s) => {
    s.assets = [];
  });
  restoreDocument(oldBundleDoc());
  const [arrived] = withDocumentItems([plate()]);
  expect(arrived!.folderId).toBe('f_old_sub');
  expect(arrived!.interpret?.conformFps).toBe(24);
});

test('a new, empty project does not inherit the legacy folder tree', () => {
  useAssetStore.setState((s) => {
    s.assets = [];
  });
  restoreDocument({ version: '1.1.0', scene: { version: '1.0.0', nodes: [] }, animation: { tracks: {}, expressions: {} } } as unknown as EditorDocument);
  expect(useAssetStore.getState().folders).toEqual([]);
});

test('the engine open path keeps an older project\'s items (it used to empty them)', async () => {
  useAssetStore.setState((s) => {
    s.assets = [plate()];
  });
  h.files.set('C:/p/old.motion', oldBundleDoc());
  const r = await h.run({ type: 'openProject', path: 'C:/p/old.motion' });
  expect(r.missingItems).toEqual([]);
  expect(useAssetStore.getState().folders.map((f) => f.id)).toEqual(['f_old', 'f_old_sub']);
  expect(useAssetStore.getState().assets.map((a) => [a.id, a.folderId])).toEqual([['asset_plate', 'f_old_sub']]);
});

test('bundle assets restored after the open get the document\'s organisation', async () => {
  setLocalFirst(true);
  useAssetStore.setState((s) => {
    s.assets = [];
  });
  restoreDocument({
    ...oldBundleDoc(),
    projectItems: {
      folders: [{ id: 'f1', name: 'Plates', parentId: null }],
      footage: { asset_plate: { name: 'plate.mp4', type: 'video', folderId: 'f1', interpret: { conformFps: 24 }, tags: ['doc'] } },
    },
  });
  (readBundleAssets as jest.Mock).mockResolvedValueOnce([
    { id: 'asset_plate', name: 'plate.mp4', type: 'video', src: 'motion-blob:abc', size: 10, tags: ['registry'] },
  ]);
  expect(await restoreBundleAssets('C:/p/x.motion')).toBe(1);
  const a = useAssetStore.getState().assets[0]!;
  expect(a.src).toBe('motion-blob:abc');
  expect(a.folderId).toBe('f1');
  expect(a.interpret).toEqual({ conformFps: 24 });
  expect(a.tags).toEqual(['doc']);
});

test('a missing-footage placeholder is filled (not skipped) when the bundle registry brings its bytes', async () => {
  setLocalFirst(true);
  useAssetStore.setState((s) => {
    s.assets = [];
  });
  h.files.set('C:/p/m.motion', {
    ...oldBundleDoc(),
    projectItems: { folders: [{ id: 'f1', name: 'Plates', parentId: null }], footage: { asset_plate: { name: 'plate.mp4', type: 'video', folderId: 'f1' } } },
  });
  const r = await h.run({ type: 'openProject', path: 'C:/p/m.motion' });
  expect(r.missingItems).toEqual(['asset_plate']);
  (readBundleAssets as jest.Mock).mockResolvedValueOnce([{ id: 'asset_plate', name: 'plate.mp4', type: 'video', src: 'motion-blob:abc', size: 10 }]);
  expect(await restoreBundleAssets('C:/p/m.motion')).toBe(1);
  const list = useAssetStore.getState().assets;
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: 'asset_plate', src: 'motion-blob:abc', size: 10, folderId: 'f1' });
});
