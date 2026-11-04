/**
 * File ▸ Open After Effects Project… opens the imported composition in the EDITOR.
 *
 * The observable is the editor's tab — the timeline, the viewer's frame and the
 * layer list all follow it. The bug this pins (2026-11-04, a real 1080×1920
 * project): the engine was told the imported comp was active, but the page kept
 * the blank 1920×1080 "Composition 1" that New Project opened, so the viewer drew
 * the imported comp inside the wrong frame over an empty, "0 layers" timeline.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
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

  beforeAll(async () => {
    h = await setupAppEngine();
    tmp = mkdtempSync(path.join(os.tmpdir(), 'premation-aep-open-'));
  });
  afterAll(async () => {
    await h?.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('activates the imported composition tab, at its own size, and drops the blank one', async () => {
    const file = path.join(tmp, 'Reel.aep');
    writeFileSync(file, aepFile([compItem({ id: 1, name: 'MAIN COMP', width: 1080, height: 1920, fps: 30, durationSeconds: 6, layers: [] })]));
    const win = window as unknown as { motionEditor: Record<string, unknown> };
    win.motionEditor = { ...win.motionEditor, file: { pathOf: () => file } };

    // What New Project leaves: one blank 1920×1080 comp, open in a tab. (The project manager is
    // stubbed: the harness document is already the fresh one.)
    const made = await h.client.execute({ type: 'createComposition', settings: { name: 'Composition 1', width: 1920, height: 1080 }, fromItems: [] } as never);
    if (!made.ok) throw new Error(made.error.message);
    const blank = (made.value as { item: string }).item;
    useProjectStore.getState().actions.openTab(blank, [blank], 'Composition 1');
    setCoreServiceRefs({ project: { newProject: () => undefined } } as unknown as Parameters<typeof setCoreServiceRefs>[0]);

    await openAfterEffectsProjectFile(new File([], 'Reel.aep'));

    const { tabs, activeTabId, tabOrder } = useProjectStore.getState();
    const active = activeTabId ? tabs[activeTabId] : undefined;
    expect(active).toBeDefined();
    const comp = documentMirror().comp(active!.compositionId);
    expect(comp).toBeDefined();
    expect(comp!.settings.width).toBe(1080);
    expect(comp!.settings.height).toBe(1920);
    expect(active!.title).toBe('MAIN COMP');
    // The empty comp New Project opened is not left as a second tab.
    expect(tabOrder).toEqual([activeTabId]);
  });
});
