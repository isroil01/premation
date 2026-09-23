/**
 * `projectItems` (folders, nested folders, folder assignment, interpretation,
 * tags, labels, comments) through EVERY persistence path — save, "relaunch"
 * (a fresh session whose library knows nothing about the organisation, or
 * knows something different), reopen, deep-equal.
 *
 * The defect this pins: B2 moved folders/assignments/interpretation out of
 * localStorage into the document, but the `.motion` bundle codec had no slot
 * for them — a bundle save dropped them (and the portable zip and the export
 * snapshot, which reuse the codec), and the engine's open path then read the
 * missing key as "the project lists nothing" and emptied the folders.
 */

import { setupEngine, sec, fakePorts, type Harness } from '@core/engine/__testHelpers__/harness';
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import {
  useAssetStore,
  applyProjectItems,
  captureProjectItems,
  type ImportedAsset,
  type ProjectItemsDocument,
} from '@stores/assetStore';
import { BundleRepository } from '@core/project/bundle/BundleRepository';
import { MemoryBundleFs } from '@core/project/bundle/BundleFs';
import { CHUNK } from '@core/project/bundle/types';
import { packPortableMotion, unpackPortableMotion } from '@core/project/portableMotion';
import { ProjectManager } from '@core/project/ProjectManager';
import { ProjectService } from '@core/persistence/ProjectService';
import {
  BundleProjectStorage,
  FileProjectStorage,
  RoutedProjectStorage,
} from '@core/persistence/ProjectStorage';
import { projectDocumentIO } from '@core/project/projectDocumentIO';
import { captureRecovery, restoreRecovery } from '@core/persistence/recovery';
import { RecoverySerializer, decodeRecoveryBody } from '@core/persistence/recoverySerializer';
import type { FileManager } from '@core/files/FileManager';
import type { RecentProjects } from '@core/project/RecentProjects';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => {
  h = await setupEngine();
});
afterEach(async () => {
  await h.dispose();
});

interface Built {
  clip: string;
  still: string;
  outer: string;
  inner: string;
}

/** Two footage items, nested folders, every organisation field set. */
async function organise(): Promise<Built> {
  const { items: [clip, still] } = await h.run({
    type: 'importFiles',
    files: [
      { path: 'C:/media/plate.mp4', asSequence: false, createComposition: false },
      { path: 'C:/media/logo.png', asSequence: false, createComposition: false },
    ],
  });
  const { item: outer } = await h.run({ type: 'createFolder', name: 'Footage' });
  const { item: inner } = await h.run({ type: 'createFolder', name: 'Plates', parent: outer });
  await h.run({ type: 'moveItems', items: [clip!], folder: inner });
  await h.run({ type: 'moveItems', items: [still!], folder: outer });
  await h.run({
    type: 'setInterpretation',
    items: [clip!],
    patch: { conformFrameRate: { num: 24, den: 1 }, alpha: 'premultiplied', fieldOrder: 'upperFirst', loops: 3, pixelAspect: 2 },
  });
  await h.run({ type: 'setInterpretation', items: [still!], patch: { alpha: 'straight' } });
  await h.run({ type: 'setItemLabel', items: [clip!], label: 3 });
  await h.run({ type: 'setItemTags', item: clip!, tags: ['hero', 'day 2'] });
  await h.run({ type: 'setItemComment', item: still!, comment: 'client logo v3' });
  // A layer using the clip, so the document references it.
  await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'video', name: 'V', source: clip!, init: [] });
  return { clip: clip!, still: still!, outer, inner };
}

/**
 * A relaunch as far as the items are concerned: the library hydrates the same
 * files with NONE of the organisation — or, worse, with a different machine's
 * (the cache stated another folder and a 60 fps conform) — and nothing is
 * remembered about the previous document.
 */
function relaunch(): void {
  useAssetStore.setState((s) => {
    s.folders = [{ id: 'stale', name: 'Other project', parentId: null }];
    s.assets = s.assets.map((a): ImportedAsset => ({
      id: a.id, name: a.name, type: a.type, src: a.src, size: a.size,
      ...(a.metadata ? { metadata: a.metadata } : {}),
      folderId: 'stale',
      interpret: { conformFps: 60 },
    }));
  });
  applyProjectItems(undefined);
}

function expectItemsRestored(expected: ProjectItemsDocument, b: Built): void {
  expect(captureProjectItems()).toEqual(expected);
  const s = useAssetStore.getState();
  const inner = s.folders.find((f) => f.id === b.inner)!;
  expect(inner.parentId).toBe(b.outer);
  const clip = s.assets.find((a) => a.id === b.clip)!;
  expect(clip.folderId).toBe(b.inner);
  expect(clip.interpret).toEqual({ conformFps: 24, alpha: 'premultiplied', fields: 'upper', loopCount: 3, par: 2 });
  expect(clip.tags).toEqual(['hero', 'day 2']);
  expect(clip.label).toBeTruthy();
  const still = s.assets.find((a) => a.id === b.still)!;
  expect(still.folderId).toBe(b.outer);
  expect(still.comment).toBe('client logo v3');
}

test('the organisation carries every interpretation field', async () => {
  const b = await organise();
  const items = captureDocument().projectItems!;
  const clip = items.footage[b.clip]!;
  expect(clip.folderId).toBe(b.inner);
  expect(clip.interpret).toEqual({ conformFps: 24, alpha: 'premultiplied', fields: 'upper', loopCount: 3, par: 2 });
  expect(items.footage[b.still]!.interpret).toEqual({ alpha: 'straight' });
  expect(items.folders.map((f) => [f.id, f.parentId])).toEqual([[b.outer, null], [b.inner, b.outer]]);
});

test('.motion directory bundle: save → relaunch → open', async () => {
  const b = await organise();
  const before = captureDocument();
  const repo = new BundleRepository(new MemoryBundleFs());
  await repo.save('/p/items.motion', before);
  relaunch();
  const loaded = await repo.load('/p/items.motion');
  expect(loaded!.projectItems).toEqual(before.projectItems);
  restoreDocument(loaded!);
  expectItemsRestored(before.projectItems!, b);
});

test('bundle version history restores the items too', async () => {
  const b = await organise();
  const before = captureDocument();
  const { VersionStore } = await import('@core/project/bundle/VersionStore');
  const vs = new VersionStore(new MemoryBundleFs(), '/p/v.motion');
  const entry = await vs.snapshot(before, { kind: 'manual', createdAt: 1 });
  expect(entry.chunks[CHUNK.project]).toBeDefined();
  relaunch();
  restoreDocument((await vs.restore(entry.rev))!);
  expectItemsRestored(before.projectItems!, b);
});

test('portable .motion zip: pack → relaunch → unpack', async () => {
  const b = await organise();
  const before = captureDocument();
  const bytes = packPortableMotion(before);
  relaunch();
  const { document } = unpackPortableMotion(bytes);
  restoreDocument(document);
  expectItemsRestored(before.projectItems!, b);
});

function manager(localFirst: boolean): { pm: ProjectManager; disk: Map<string, string> } {
  const disk = new Map<string, string>();
  const files = {
    read: async (p: string) => disk.get(p) ?? null,
    write: async (p: string, c: string) => void disk.set(p, c),
  } as unknown as FileManager;
  const service = new ProjectService();
  const storage = new RoutedProjectStorage(
    new FileProjectStorage(service, files),
    new BundleProjectStorage(new BundleRepository(new MemoryBundleFs())),
    () => localFirst,
  );
  const recent = { add: () => {} } as unknown as RecentProjects;
  const pm = new ProjectManager({ service, files, recent, io: projectDocumentIO, storage });
  return { pm, disk };
}

test.each([
  ['a .motion bundle (local-first)', true, '/p/a.motion'],
  ['a single-file .motion', false, '/p/a.motion'],
  ['a .json project', true, '/p/a.json'],
])('ProjectManager through %s: writeDocument/snapshotTo → openPath', async (_n, localFirst, path) => {
  const b = await organise();
  const before = captureDocument();
  const { pm } = manager(localFirst);
  // The export supervisor's snapshot and the engine's file port both go here.
  await pm.snapshotTo(path);
  expect((await pm.readDocument(path) as EditorDocument).projectItems).toEqual(before.projectItems);
  relaunch();
  expect(await pm.openPath(path)).not.toBeNull();
  expectItemsRestored(before.projectItems!, b);
});

test('cloud document: capture → JSON → restore', async () => {
  const b = await organise();
  const before = captureDocument();
  const wire = JSON.parse(JSON.stringify(before)) as EditorDocument;
  relaunch();
  restoreDocument(wire);
  expectItemsRestored(before.projectItems!, b);
});

test('crash recovery: snapshot → serialize → relaunch → restore', async () => {
  const b = await organise();
  const expected = captureProjectItems();
  const snap = captureRecovery(sec(1))!;
  const res = new RecoverySerializer().run({ seq: 1, snap: { ...snap, savedAt: 1 }, force: true, folder: false });
  expect(res.status).toBe('write');
  relaunch();
  const decoded = decodeRecoveryBody((res as { body: string }).body)!;
  restoreRecovery(decoded);
  expectItemsRestored(expected, b);
});

test('engine save → New Project → open (bundle on disk): nothing reset', async () => {
  const b = await organise();
  const expected = captureProjectItems();
  const { pm } = manager(true);
  h.engine.attachPorts({
    ...fakePorts(h.files),
    readProject: async (p) => (await pm.readDocument(p)) as EditorDocument,
    writeProject: async (p, d) => {
      await pm.writeDocument(p, d);
      return { bytes: 1 };
    },
  });
  await h.run({ type: 'saveProject', path: '/p/e.motion', copy: false });
  const library = useAssetStore.getState().assets;
  await h.run({ type: 'newProject' });
  expect(useAssetStore.getState().folders).toEqual([]);
  // The session's library still has the files (the device library).
  useAssetStore.setState((s) => {
    s.assets = library.map((a) => ({ id: a.id, name: a.name, type: a.type, src: a.src, size: a.size }));
  });
  const opened = await h.run({ type: 'openProject', path: '/p/e.motion' });
  expect(opened.missingItems).toEqual([]);
  expectItemsRestored(expected, b);
  const items = await h.query({ type: 'getItems', items: [b.inner, b.clip] });
  expect(JSON.stringify(items)).toContain('Plates');
  expect(JSON.stringify(items)).toContain('plate.mp4');
});

test('an item the document lists but the session lacks is a placeholder, filled when its bytes arrive', async () => {
  const b = await organise();
  const doc = captureDocument();
  await h.run({ type: 'newProject' });
  useAssetStore.setState((s) => {
    s.assets = [];
  });
  h.files.set('/p/m.motion', doc);
  const opened = await h.run({ type: 'openProject', path: '/p/m.motion' });
  expect([...opened.missingItems].sort()).toEqual([b.clip, b.still].sort());
  const ph = useAssetStore.getState().assets.find((a) => a.id === b.clip)!;
  expect(ph.src).toBe('');
  expect(ph.folderId).toBe(b.inner);
  expect(ph.interpret?.conformFps).toBe(24);
});

test('a document with no items opened into an empty session: New Project does not inherit folders', async () => {
  await organise();
  await h.run({ type: 'newProject' });
  expect(useAssetStore.getState().folders).toEqual([]);
  expect(captureDocument().projectItems).toEqual({ folders: [], footage: {} });
});
