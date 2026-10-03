/**
 * The History panel's document writes with the document engine running.
 *
 * A version restore is the engine's undoable `restoreDocument` and a pinned
 * snapshot its `addHistoryCheckpoint` (B3z, ENGINE_API.md §15.9): each ONE
 * entry, undone through the app's engine-routed undo. Above all, undo never
 * loses the document the user had before a restore.
 */

jest.mock('@core/api/client', () => {
  const actual = jest.requireActual('@core/api/client');
  return {
    ...actual,
    api: {
      ...actual.api,
      restoreVersion: jest.fn(),
      listVersions: jest.fn(async () => ({ versions: [], total: 0 })),
    },
  };
});
jest.mock('@core/engine/engineStill', () => ({
  engineCompStill: jest.fn(async () => new Blob(['frame'])),
  engineDocumentStill: jest.fn(async () => new Blob(['frame'])),
}));

import { api } from '@core/api/client';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { performRedo, performUndo } from '@stores/historyStore';
import { renderVersionFrame } from './VersionCompareDialog';
import { restoreVersionAsOneEdit } from './versionRestore';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useCloudProjectStore.setState({ projectId: 'project_1' });
});

afterEach(async () => {
  useCloudProjectStore.setState({ projectId: null });
  await h.dispose();
});

/** The document as a saved version holds it: the engine's export. */
async function exported(): Promise<unknown> {
  const { document } = await h.query({ type: 'exportDocument' });
  return JSON.parse(new TextDecoder().decode(document));
}

async function undoTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await performUndo();
    await engineIdle();
  }
}

async function redoTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await performRedo();
    await engineIdle();
  }
}

describe('restore a cloud version (restoreVersionAsOneEdit)', () => {
  it('lands the version exactly, and undo brings the pre-restore document back exactly', async () => {
    const version = (await h.doc());
    (api.restoreVersion as jest.Mock).mockResolvedValue({ document: await exported() });

    // An engine edit after the version was saved: this is what the restore replaces.
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'solid', name: 'After the version', init: [] });
    const live = (await h.doc());
    expect(live).not.toBe(version);
    const entries = (await historyLabels()).length;

    await restoreVersionAsOneEdit('version_1');
    await engineIdle();

    expect((await h.doc())).toBe(version);
    const added = (await historyLabels()).slice(entries);
    // ONE entry: the engine's undoable whole-document restore (B3z).
    expect(added).toEqual(['Restore version']);

    // Undoing across the restore's entries returns the exact pre-restore
    // document — the engine edit is still there, nothing else leaked in.
    await undoTimes(added.length);
    expect((await h.doc())).toBe(live);

    // …and the engine edit before it keeps its own entry.
    await undoTimes(1);
    expect((await h.doc())).toBe(version);
    await redoTimes(1);
    expect((await h.doc())).toBe(live);

    await redoTimes(added.length);
    expect((await h.doc())).toBe(version);
  });

  it('a failed restore leaves the document alone', async () => {
    (api.restoreVersion as jest.Mock).mockRejectedValue(new Error('offline'));
    const live = (await h.doc());

    await restoreVersionAsOneEdit('version_1');
    await engineIdle();

    expect((await h.doc())).toBe(live);
  });
});

describe('compare a version (renderVersionFrame)', () => {
  it('swaps the version in and back without an undo entry, leaving the document byte-identical', async () => {
    const version = (await exported()) as never;
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'solid', name: 'After the version', init: [] });
    const live = (await h.doc());
    const labels = (await historyLabels());

    await renderVersionFrame(version);
    await engineIdle();

    expect((await h.doc())).toBe(live);
    expect((await historyLabels())).toEqual(labels);

    // The engine edit before the compare is still the top entry.
    await undoTimes(1);
    expect((await h.doc())).not.toBe(live);
  });
});

describe('pin a snapshot (History panel)', () => {
  it('adds one named row and does not disturb the edits around it', async () => {
    const before = (await h.doc());
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'solid', name: 'Edited', init: [] });
    const edited = (await h.doc());
    const entries = (await historyLabels()).length;

    await h.run({ type: 'addHistoryCheckpoint', label: 'Snapshot' });

    expect((await historyLabels()).slice(entries)).toEqual(['Snapshot']);
    expect((await h.doc())).toBe(edited);

    // The pin itself changes nothing; the engine edit under it still undoes.
    await undoTimes(1);
    expect((await h.doc())).toBe(edited);
    await undoTimes(1);
    expect((await h.doc())).toBe(before);
  });
});
