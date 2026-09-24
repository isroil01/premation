/**
 * The History panel's document writes with the document engine running.
 *
 * None of these is an engine command yet: the engine has no undoable
 * whole-document restore and no named checkpoint entry (ENGINE_API.md §15.9
 * reserves Session ids 20–29 for both). They are writes around the engine,
 * recorded by the legacy snapshot recorder, and undone through the app's
 * engine-routed undo (`performUndo` → the engine's `undo`, which walks the
 * shared stack's foreign entries). These tests pin what must keep holding on
 * that path until the commands exist — above all that undo never loses the
 * document the user had before a restore.
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
jest.mock('@core/export/offlineRenderer', () => ({
  renderStillFrame: jest.fn(async () => new Blob(['frame'])),
}));

import { api } from '@core/api/client';
import { captureDocument } from '@core/api/cloudDocument';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { performRedo, performUndo, useHistoryStore } from '@stores/historyStore';
import { renderVersionFrame } from './VersionCompareDialog';
import { restoreVersionAsOneEdit } from './versionRestore';

let h: Harness & { engine: LocalEngine };
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
    const version = h.doc();
    (api.restoreVersion as jest.Mock).mockResolvedValue({ document: structuredClone(captureDocument()) });

    // An engine edit after the version was saved: this is what the restore replaces.
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'solid', name: 'After the version', init: [] });
    const live = h.doc();
    expect(live).not.toBe(version);
    const entries = historyLabels().length;

    await restoreVersionAsOneEdit('version_1');
    await engineIdle();

    expect(h.doc()).toBe(version);
    const added = historyLabels().slice(entries);
    expect(added).toContain('Restore version');
    // KNOWN GAP (reported, not fixed here): the recorder also commits the
    // restore's own bus burst as an unnamed `Edit N` (the burst's animation →
    // scene key change, or the 700 ms timer during the version-list reload),
    // so the named row is a no-op and the restore takes TWO undo steps. The
    // fix is the engine's undoable whole-document restore (§15.9, ids 20–29).
    expect(added.length).toBeLessThanOrEqual(2);

    // Undoing across the restore's entries returns the exact pre-restore
    // document — the engine edit is still there, nothing else leaked in.
    await undoTimes(added.length);
    expect(h.doc()).toBe(live);

    // …and the engine edit before it keeps its own entry.
    await undoTimes(1);
    expect(h.doc()).toBe(version);
    await redoTimes(1);
    expect(h.doc()).toBe(live);

    await redoTimes(added.length);
    expect(h.doc()).toBe(version);
  });

  it('a failed restore leaves the document alone', async () => {
    (api.restoreVersion as jest.Mock).mockRejectedValue(new Error('offline'));
    const live = h.doc();

    await restoreVersionAsOneEdit('version_1');
    await engineIdle();

    expect(h.doc()).toBe(live);
  });
});

describe('compare a version (renderVersionFrame)', () => {
  it('swaps the version in and back without an undo entry, leaving the document byte-identical', async () => {
    const version = structuredClone(captureDocument());
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'solid', name: 'After the version', init: [] });
    const live = h.doc();
    const labels = historyLabels();

    await renderVersionFrame(version);
    await engineIdle();
    useHistoryStore.getState().flush();

    expect(h.doc()).toBe(live);
    expect(historyLabels()).toEqual(labels);

    // The engine edit before the compare is still the top entry.
    await undoTimes(1);
    expect(h.doc()).not.toBe(live);
  });
});

describe('pin a snapshot (History panel)', () => {
  it('adds one named row and does not disturb the edits around it', async () => {
    const before = h.doc();
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'solid', name: 'Edited', init: [] });
    const edited = h.doc();
    const entries = historyLabels().length;

    useHistoryStore.getState().record('Snapshot', true);

    expect(historyLabels().slice(entries)).toEqual(['Snapshot']);
    expect(h.doc()).toBe(edited);

    // The pin itself changes nothing; the engine edit under it still undoes.
    await undoTimes(1);
    expect(h.doc()).toBe(edited);
    await undoTimes(1);
    expect(h.doc()).toBe(before);
  });
});
