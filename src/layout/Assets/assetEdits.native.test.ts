/**
 * The Assets panel's item edits through the engine (B3): each user action is
 * ONE undo entry and undo restores the document exactly.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { useAssetStore } from '@stores/assetStore';
import {
  consolidateFootageEdit,
  createFolderEdit,
  createFolderTreeEdit,
  duplicateFootageCount,
  importBrowserFilesEdit,
  importPathsEdit,
  interpretFootageEdit,
  layersUsingItems,
  moveItemsEdit,
  removeItemsEdit,
  renameItemEdit,
  setItemLabelEdit,
  setItemTagsEdit,
} from './assetEdits';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

const asset = (id: string) => useAssetStore.getState().assets.find((a) => a.id === id);
const folder = (id: string) => useAssetStore.getState().folders.find((f) => f.id === id);
const entries = async (label: string): Promise<number> => (await historyLabels()).filter((l) => l === label).length;

/** Run `act`, then pin: one new entry named `label`, undo === before, redo === after. */
async function oneEntry(label: string, act: () => Promise<unknown>): Promise<void> {
  const before = (await h.doc());
  const n = (await historyLabels()).length;
  await act();
  await engineIdle();
  const after = (await h.doc());
  expect((await historyLabels()).length).toBe(n + 1);
  expect((await historyLabels()).at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toBe(after);
}

describe('import by path', () => {
  it('imports into a folder as one entry', async () => {
    let ids: string[] = [];
    await oneEntry('Import 2 Files', async () => {
      const r = await importPathsEdit(['C:/media/a.png', 'C:/media/b.mp4'], s.folder);
      ids = r.imported.map((a) => a.id);
      expect(r.failed).toEqual([]);
    });
    expect(ids).toHaveLength(2);
    expect(asset(ids[0]!)).toMatchObject({ name: 'a.png', folderId: s.folder, path: 'C:/media/a.png' });
  });

  it('one bad file neither blocks the rest nor splits the entry', async () => {
    // The engine's test ports refuse a file named `undecodable` (a decode failure).
    const before = (await h.doc());
    const r = await importPathsEdit(['C:/media/ok.png', 'C:/media/undecodable.mov', 'C:/media/ok2.png']);
    expect(r.imported.map((a) => a.name)).toEqual(['ok.png', 'ok2.png']);
    expect(r.failed).toEqual(['C:/media/undecodable.mov']);
    expect(await entries('Import 3 Files')).toBe(1);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
  });

  it('a file already in the project is reused, not imported again', async () => {
    const n = (await historyLabels()).length;
    // The scene imported C:/media/clip.mp4; the same file, spelled the Windows way, is that item.
    const again = await importPathsEdit(['C:\\Media\\CLIP.mp4']);
    expect(again.imported.map((a) => a.id)).toEqual([s.footage]);
    expect(again.reused?.map((a) => a.id)).toEqual([s.footage]);
    expect((await historyLabels()).length).toBe(n);
    // A mix: the known file is reused, the new one imported (one entry, named for what is new).
    const mix = await importPathsEdit(['C:/media/clip.mp4', 'C:/media/new.png', 'C:/media/new.png']);
    expect(mix.imported.map((a) => a.name)).toEqual(['clip.mp4', 'new.png']);
    expect(mix.imported[0]!.id).toBe(s.footage);
    expect(await entries('Import File')).toBe(1);
  });
});

describe('Consolidate All Footage', () => {
  it('points layers at the first item of a file and removes the copies, as one entry', async () => {
    // An older project: the same file imported twice, a layer on the copy.
    const { items: [copy] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/media/clip.mp4', asSequence: false, createComposition: false }] });
    await h.run({ type: 'replaceLayerSource', layer: s.V, source: copy!, keepSize: true });
    await engineIdle();
    expect(duplicateFootageCount()).toBe(1);
    await oneEntry('Consolidate All Footage', async () => { expect(await consolidateFootageEdit()).toBe(1); });
    expect(asset(copy!)).toBeUndefined();
    expect(layersUsingItems([s.footage])).toBe(1);
    expect(duplicateFootageCount()).toBe(0);
    expect(await consolidateFootageEdit()).toBe(0);
  });
});

describe('import browser Files (from bytes)', () => {
  const file = (name: string, bytes = [1, 2, 3], type = 'image/png'): File => new File([new Uint8Array(bytes)], name, { type });

  it('imports picked Files into a folder as one entry', async () => {
    let ids: string[] = [];
    await oneEntry('Import 2 Files', async () => {
      const r = await importBrowserFilesEdit([{ file: file('a.png'), folderId: s.folder }, { file: file('b.png') }]);
      ids = r.imported.map((a) => a.id);
      expect(r.failed).toEqual([]);
    });
    expect(asset(ids[0]!)).toMatchObject({ name: 'a.png', folderId: s.folder, size: 3 });
    expect(asset(ids[1]!)?.folderId ?? null).toBeNull();
  });

  it('one bad file neither blocks the rest nor splits the entry', async () => {
    const before = (await h.doc());
    const r = await importBrowserFilesEdit([{ file: file('ok.png') }, { file: file('undecodable.mov') }, { file: file('ok2.png') }], 'Drop');
    expect(r.imported.map((a) => a.name)).toEqual(['ok.png', 'ok2.png']);
    expect(r.failed).toEqual(['undecodable.mov']);
    expect(await entries('Drop')).toBe(1);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
  });

  it('the same path-less file dropped again is reused (same name, same size)', async () => {
    const first = await importBrowserFilesEdit([{ file: file('giraffe.jpg', [1, 2, 3, 4], 'image/jpeg') }]);
    await engineIdle();
    const n = (await historyLabels()).length;
    const again = await importBrowserFilesEdit([{ file: file('giraffe.jpg', [1, 2, 3, 4], 'image/jpeg') }]);
    expect(again.imported.map((a) => a.id)).toEqual(first.imported.map((a) => a.id));
    expect((await historyLabels()).length).toBe(n);
    // A different size is a different file.
    const other = await importBrowserFilesEdit([{ file: file('giraffe.jpg', [1, 2, 3, 4, 5], 'image/jpeg') }]);
    expect(other.reused).toBeUndefined();
  });
});

describe('folders, rename, move', () => {
  it('New Folder is one entry and returns the id', async () => {
    let id: string | null = null;
    await oneEntry('New Folder', async () => { id = await createFolderEdit('Plates', s.folder); });
    expect(folder(id!)).toMatchObject({ name: 'Plates', parentId: s.folder });
  });

  it('a folder TREE (Import Folder) is one entry with parents wired', async () => {
    let map = new Map<string, string>();
    await oneEntry('New Folders', async () => { map = await createFolderTreeEdit(['Pack', 'Pack/logos', 'Pack/music'], null); });
    expect(folder(map.get('Pack/logos')!)?.parentId).toBe(map.get('Pack'));
    expect(folder(map.get('Pack/music')!)?.parentId).toBe(map.get('Pack'));
  });

  it('rename: one entry; Enter + the blur that follows do not make two', async () => {
    const n = (await historyLabels()).length;
    await Promise.all([renameItemEdit(s.folder, 'Footage B'), renameItemEdit(s.folder, 'Footage B')]);
    await engineIdle();
    expect((await historyLabels()).length).toBe(n + 1);
    expect(folder(s.folder)?.name).toBe('Footage B');
    // Unchanged and blank names are no-ops.
    await renameItemEdit(s.folder, 'Footage B');
    await renameItemEdit(s.folder, '   ');
    expect((await historyLabels()).length).toBe(n + 1);
  });

  it('move into a folder is one entry; moving where it already is records nothing', async () => {
    await oneEntry('Move to Folder', () => moveItemsEdit([s.footage], s.folder));
    expect(asset(s.footage)?.folderId).toBe(s.folder);
    const n = (await historyLabels()).length;
    await moveItemsEdit([s.footage], s.folder);
    expect((await historyLabels()).length).toBe(n);
  });
});

describe('delete', () => {
  it('a used item takes its layers with it; undo brings both back with the same ids', async () => {
    expect(layersUsingItems([s.footage])).toBe(1);
    await oneEntry('Delete Asset', () => removeItemsEdit([s.footage], 'Delete Asset'));
    expect(asset(s.footage)).toBeUndefined();
    expect((await docView()).getNode(s.V)).toBeUndefined();
    await h.run({ type: 'undo' });
    expect(asset(s.footage)).toBeDefined();
    expect((await docView()).getNode(s.V)).toBeDefined();
  });

  it('a folder goes with its contents', async () => {
    await moveItemsEdit([s.footage2], s.folder);
    await oneEntry('Delete Folder', () => removeItemsEdit([s.folder], 'Delete Folder'));
    expect(folder(s.folder)).toBeUndefined();
    expect(asset(s.footage2)).toBeUndefined();
  });
});

describe('tags and interpretation', () => {
  it('tags for a selection are one entry; unchanged items are skipped', async () => {
    await oneEntry('Edit Tags', () => setItemTagsEdit([
      { id: s.footage, tags: ['b-roll'] },
      { id: s.footage2, tags: ['b-roll', 'music'] },
    ]));
    expect(asset(s.footage2)?.tags).toEqual(['b-roll', 'music']);
    const n = (await historyLabels()).length;
    await setItemTagsEdit([{ id: s.footage, tags: ['b-roll'] }]);
    expect((await historyLabels()).length).toBe(n);
  });

  it('Interpret Footage sends only what changed, Remove Pulldown included (B3z)', async () => {
    const a = asset(s.footage)!;
    await oneEntry('Interpret Footage', () => interpretFootageEdit(a, { conformFps: 23.976, par: 1, alpha: 'straight', loopCount: 3 }));
    expect(asset(s.footage)?.interpret).toMatchObject({ conformFps: 23.976, loopCount: 3 });
    expect(asset(s.footage)?.interpret?.par).toBeUndefined();
    await oneEntry('Interpret Footage', () => interpretFootageEdit(asset(s.footage)!, { ...asset(s.footage)!.interpret, pulldownPhase: 2 }));
    expect(asset(s.footage)?.interpret?.pulldownPhase).toBe(2);
    await oneEntry('Interpret Footage', () => interpretFootageEdit(asset(s.footage)!, { ...asset(s.footage)!.interpret, pulldownPhase: undefined }));
    expect(asset(s.footage)?.interpret?.pulldownPhase).toBeUndefined();
  });

  it('the label menu stores the palette id, one entry (B3z)', async () => {
    await oneEntry('Item Label', () => setItemLabelEdit([s.footage], 'coral'));
    expect(asset(s.footage)?.label).toBe('coral');
    await oneEntry('Item Label', () => setItemLabelEdit([s.footage], null));
    expect(asset(s.footage)?.label).toBeUndefined();
  });
});
