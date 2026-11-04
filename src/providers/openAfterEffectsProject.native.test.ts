/**
 * File ▸ Open After Effects Project…: where the converted project lands, and what is open after.
 *
 * Two bugs this pins (2026-11-04, real 1080×1920 projects):
 *  - the engine was told the imported comp was active, but the page kept the blank 1920×1080
 *    "Composition 1" tab, so the viewer drew the imported comp inside the wrong frame over an
 *    empty, "0 layers" timeline;
 *  - a dashboard "New Project" with an .aep opened in it reopened EMPTY: the open ran New
 *    Project first, which unbound the editor from the routed project, so cloud autosave
 *    (rightly) refused to upload the converted document over it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '@core/engine/__testHelpers__/nativeEngine';
import { aepFile, compItem } from '@core/aep/__testHelpers__/buildAep';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import { setCoreServiceRefs } from '@core/services/coreServices';
import { openAfterEffectsProjectFile } from './Providers';

jest.mock('@core/project/confirmDiscard', () => ({ confirmDiscardChanges: async () => true }));

jest.setTimeout(120_000);

const maybe = nativeEngineIsHeadless() ? describe.skip : describe;

maybe('Open After Effects Project', () => {
  let h: Harness;
  let tmp: string;
  const newProject = jest.fn();

  beforeAll(async () => {
    h = await setupAppEngine();
    tmp = mkdtempSync(path.join(os.tmpdir(), 'premation-aep-open-'));
  });
  afterAll(async () => {
    await h?.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    newProject.mockReset();
    // The project manager is stubbed: the harness document is the project in both cases.
    setCoreServiceRefs({ project: { newProject } } as unknown as Parameters<typeof setCoreServiceRefs>[0]);
  });

  /** An .aep with one empty 1080×1920 comp, the page's file → disk path seam pointed at it. */
  const aep = (name: string, compName: string): File => {
    const file = path.join(tmp, name);
    writeFileSync(file, aepFile([compItem({ id: 1, name: compName, width: 1080, height: 1920, fps: 30, durationSeconds: 6, layers: [] })]));
    const win = window as unknown as { motionEditor: Record<string, unknown> };
    win.motionEditor = { ...win.motionEditor, file: { pathOf: () => file } };
    return new File([], name);
  };
  /** What a dashboard "New Project" is: one blank 1920×1080 comp, open in a tab. */
  const blankComp = async (): Promise<string> => {
    const made = await h.client.execute({ type: 'createComposition', settings: { name: 'Composition 1', width: 1920, height: 1080 }, fromItems: [] } as never);
    if (!made.ok) throw new Error(made.error.message);
    const id = (made.value as { item: string }).item;
    useProjectStore.getState().actions.openTab(id, [id], 'Composition 1');
    return id;
  };

  it('an empty project RECEIVES the import: same project, imported comp open at its size, placeholder gone, unsaved', async () => {
    const blank = await blankComp();

    await openAfterEffectsProjectFile(aep('Reel.aep', 'MAIN COMP'));
    await settleEdits();

    // Not replaced by a New Project: the routed project keeps its identity, so it is saved back.
    expect(newProject).not.toHaveBeenCalled();
    const { tabs, activeTabId, tabOrder } = useProjectStore.getState();
    const active = activeTabId ? tabs[activeTabId] : undefined;
    expect(active).toBeDefined();
    const comp = documentMirror().comp(active!.compositionId);
    expect(comp!.settings.width).toBe(1080);
    expect(comp!.settings.height).toBe(1920);
    expect(active!.title).toBe('MAIN COMP');
    expect(tabOrder).toEqual([activeTabId]);
    // The blank placeholder is removed: reopened, the project shows the import, not an empty comp.
    expect(documentMirror().comp(blank)).toBeUndefined();
    // Unsaved work, never marked clean.
    expect(active!.dirty).toBe(true);
  });

  it('a project with content gets a fresh document for the import', async () => {
    const comp = await blankComp();
    const layer = await h.client.execute({ type: 'createLayer', comp, kind: 'null', name: 'Mine', init: [] } as never);
    if (!layer.ok) throw new Error(layer.error.message);

    await openAfterEffectsProjectFile(aep('Other.aep', 'OTHER COMP'));

    expect(newProject).toHaveBeenCalledTimes(1);
  });
});
