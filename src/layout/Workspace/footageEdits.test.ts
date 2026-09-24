/**
 * Footage into the document through the engine API (footageEdits.ts): the
 * media insert router run off-document and landed as ONE `pasteLayers`, and
 * New Comp from Footage as ONE entry. Document state, one undo entry per
 * action, exact undo / redo.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engineIdle } from '@core/engine/engineInstance';
import { layerIdsOfComp } from '@core/engine/doc';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { pristineCompToAdopt } from '@core/composition/compositionOps';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { footageCompSettings, insertMediaEdit, newCompFromFootageEdit } from './footageEdits';

let h: Harness & { engine: LocalEngine };

beforeEach(async () => {
  h = await setupAppEngine();
  useSelectionStore.getState().clear();
});

afterEach(async () => {
  await h.dispose();
});

/** Import through the engine (the fake port: 640×360, 4 s, 30 fps; `.wav` is audio) and return the records. */
async function importAssets(...paths: string[]): Promise<ImportedAsset[]> {
  const { items } = await h.run({
    type: 'importFiles',
    files: paths.map((path) => ({ path, asSequence: false, createComposition: false })),
  });
  return items.map((id) => useAssetStore.getState().assets.find((a) => a.id === id)!);
}

const transform = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;

function activeComp(): string {
  const p = useProjectStore.getState();
  return p.tabs[p.activeTabId ?? '']?.compositionId ?? 'comp_root';
}

async function expectOneUndoableEntry(label: string, entries: number, before: string): Promise<void> {
  await engineIdle();
  expect(historyLabels().slice(entries)).toEqual([label]);
  const after = h.doc();
  expect(after).not.toBe(before);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

describe('insertMediaEdit', () => {
  it('a footage layer contain-fitted by the router — ONE entry, selected, undoable', async () => {
    const [clip] = await importAssets('C:/media/clip.mp4');
    const comp = activeComp();
    const settings = useProjectStore.getState().comps[comp]!;
    const before = h.doc();
    const entries = historyLabels().length;

    const ids = await insertMediaEdit([clip!]);
    expect(ids).toHaveLength(1);
    const id = ids![0]!;
    expect(layerIdsOfComp(comp)).toContain(id);
    expect(defaultSceneGraph.getNode(id)!.name).toBe('clip.mp4');
    // Contain-fit of 640×360 (16:9) into the comp frame: the router's size, not the file's.
    const t = transform(id);
    expect(t.assetId).toBe(clip!.id);
    expect(Math.min(settings.width / (t.width as number), settings.height / (t.height as number))).toBeCloseTo(1, 5);
    expect((t.width as number) / (t.height as number)).toBeCloseTo(640 / 360, 2);
    expect(useSelectionStore.getState().ids).toEqual([id]);
    expect(getTimelineController().getLayersForNode(id)).toHaveLength(1);

    await expectOneUndoableEntry('Insert clip.mp4', entries, before);
  });

  it('`at` lands the layer under the drop point in the same entry', async () => {
    const [clip] = await importAssets('C:/media/clip.mp4');
    const entries = historyLabels().length;
    const [id] = (await insertMediaEdit([clip!], { at: { x: 120, y: 80 } }))!;
    await engineIdle();
    expect(transform(id!).x).toBe(120);
    expect(transform(id!).y).toBe(80);
    expect(historyLabels().slice(entries)).toEqual(['Insert clip.mp4']);
  });

  it('several files (video + audio) are ONE entry; the last one is selected', async () => {
    const assets = await importAssets('C:/media/clip.mp4', 'C:/media/tone.wav');
    const before = h.doc();
    const entries = historyLabels().length;
    const ids = (await insertMediaEdit(assets))!;
    expect(ids).toHaveLength(2);
    const audio = ids.find((id) => defaultSceneGraph.getNode(id)!.components.some((c) => c.type === 'Audio'));
    expect(audio).toBeDefined();
    expect(useSelectionStore.getState().ids).toEqual([audio]);
    await expectOneUndoableEntry('Insert 2 Layers', entries, before);
  });

  it('`follow` commands join the paste in the same entry, with the new id', async () => {
    const [clip] = await importAssets('C:/media/clip.mp4');
    const entries = historyLabels().length;
    let seen: readonly string[] = [];
    const ids = (await insertMediaEdit([clip!], {
      label: 'Insert and Rename',
      follow: (selected) => {
        seen = selected;
        return [{ type: 'renameLayer', layer: selected[0]!, name: 'Renamed' }];
      },
    }))!;
    await engineIdle();
    expect(seen).toEqual(ids);
    expect(defaultSceneGraph.getNode(ids[0]!)!.name).toBe('Renamed');
    expect(historyLabels().slice(entries)).toEqual(['Insert and Rename']);
    await h.run({ type: 'undo' });
    expect(defaultSceneGraph.getNode(ids[0]!)).toBeUndefined();
  });

  it('an SVG whose markup cannot be read is skipped with a notice — nothing written', async () => {
    const notify = jest.spyOn(useUIStore.getState(), 'notify');
    const svg: ImportedAsset = { id: 'svg1', name: 'logo.svg', type: 'image', src: 'blob:nowhere/logo', size: 1 };
    const before = h.doc();
    const entries = historyLabels().length;
    expect(await insertMediaEdit([svg])).toEqual([]);
    expect(h.doc()).toBe(before);
    expect(historyLabels().length).toBe(entries);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
    notify.mockRestore();
  });
});

describe('newCompFromFootageEdit', () => {
  it('footageCompSettings: the clip’s size × PAR, duration and probed rate; name without extension', () => {
    const s = footageCompSettings({
      id: 'x', name: 'shot_04.mov', type: 'video', src: '', size: 1,
      metadata: { width: 720, height: 480, duration: 7, fps: 23.976 },
      interpret: { par: 1.5 },
    } as ImportedAsset);
    expect(s).toEqual({ name: 'shot_04', width: 1080, height: 480, fps: 23.976, durationSeconds: 7 });
    // Unprobed: the APP defaults, not the active comp's.
    const d = footageCompSettings({ id: 'y', name: 'x.mp4', type: 'video', src: '', size: 1 });
    expect(d).toMatchObject({ width: 1920, height: 1080, fps: 30, durationSeconds: 10 });
  });

  it('a NEW comp conformed to the clip holding it at full frame — ONE entry, tab + selection', async () => {
    const [clip] = await importAssets('C:/media/clip.mp4');
    // A project the user has worked in: nothing pristine to adopt.
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { name: 'Main' } });
    expect(pristineCompToAdopt()).toBeNull();
    const before = h.doc();
    const entries = historyLabels().length;

    const made = (await newCompFromFootageEdit(clip!))!;
    expect(made.comp).not.toBe('comp_root');
    const settings = useProjectStore.getState().comps[made.comp]!;
    expect(settings).toMatchObject({ name: 'clip', width: 640, height: 360, fps: 30, durationSeconds: 4 });
    expect(layerIdsOfComp(made.comp)).toEqual([made.layer]);
    expect(transform(made.layer)).toMatchObject({ width: 640, height: 360, x: 320, y: 180, assetId: clip!.id });
    expect(activeComp()).toBe(made.comp);
    expect(useSelectionStore.getState().ids).toEqual([made.layer]);

    await expectOneUndoableEntry('New Comp from Footage', entries, before);
  });

  it('a fresh project’s pristine comp is ADOPTED (configured), not stacked beside', async () => {
    const [clip] = await importAssets('C:/media/clip.mp4');
    const adopt = pristineCompToAdopt();
    expect(adopt).not.toBeNull();
    const comps = Object.keys(useProjectStore.getState().comps).length;
    const before = h.doc();
    const entries = historyLabels().length;

    const made = (await newCompFromFootageEdit(clip!))!;
    expect(made.comp).toBe(adopt);
    expect(Object.keys(useProjectStore.getState().comps)).toHaveLength(comps);
    expect(useProjectStore.getState().comps[adopt!]).toMatchObject({ name: 'clip', width: 640, height: 360, durationSeconds: 4 });
    expect(useProjectStore.getState().comps[adopt!]!.pristine).toBeFalsy();
    expect(layerIdsOfComp(adopt!)).toEqual([made.layer]);

    await expectOneUndoableEntry('New Comp from Footage', entries, before);
    // Undone, the comp is pristine (adoptable) again.
    await h.run({ type: 'undo' });
    expect(pristineCompToAdopt()).toBe(adopt);
  });

  it('`follow` commands for the new layer / comp are part of the same entry', async () => {
    const [clip] = await importAssets('C:/media/clip.mp4');
    const entries = historyLabels().length;
    const made = (await newCompFromFootageEdit(clip!, {
      label: 'Custom',
      follow: (layer, comp) => [
        { type: 'renameLayer', layer, name: 'Hero' },
        { type: 'setCompositionSettings', comp, patch: { duration: 2 * 705_600_000 } },
      ],
    }))!;
    await engineIdle();
    expect(defaultSceneGraph.getNode(made.layer)!.name).toBe('Hero');
    expect(useProjectStore.getState().comps[made.comp]!.durationSeconds).toBe(2);
    expect(historyLabels().slice(entries)).toEqual(['Custom']);
  });
});
