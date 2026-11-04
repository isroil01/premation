/**
 * Nested-composition navigation over the engine (B4): what a double-click
 * opens and the Mini-Flowchart's network come off the document mirror, the
 * playhead maps through each layer with `mapLayerTime`, and a tab whose comp
 * an undo took away steps back out.
 */

import type { Command } from '@motion/engine-api';
import { waitFor } from '@testing-library/react';
import { setupAppEngine, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore, type TabInfo } from '@stores/projectStore';
import { getTime, setTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { mirrorCompNetwork, mirrorNestedTarget } from '@core/mirror/compNetwork';
import {
  canOpenPreviousComposition,
  navigateToCrumb,
  openLayerComposition,
  openPreviousComposition,
  repairNestedTabs,
} from './compNavigationEdits';

let h: Harness;
const ROOT = 'comp_root';

/** The engine took the edits, the mirror saw them, and the mapped playhead (a mapLayerTime query) landed. */
const settle = (): Promise<void> => settleEdits();

/** The mapped playhead lands asynchronously (a `mapLayerTime` query per hop). */
async function playheadIs(seconds: number): Promise<void> {
  await settle();
  await waitFor(() => expect(getTime(active().id)).toBeCloseTo(seconds, 5));
}

function active(): TabInfo {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId!]!;
}

/** Main holds `inst`, a placed "Lower Third" that starts 1s in; Lower Third holds one solid. */
async function placeLowerThird(): Promise<{ inst: string; lower: string; shape: string }> {
  const shape = (await h.run({ type: 'createLayer', comp: ROOT, kind: 'shape', name: 'Shape', init: [] } as Command) as { layer: string }).layer;
  const solid = (await h.run({ type: 'createLayer', comp: ROOT, kind: 'solid', name: 'S', init: [] } as Command) as { layer: string }).layer;
  const r = await h.run({ type: 'precompose', comp: ROOT, layers: [solid], name: 'Lower Third', mode: 'moveAll', adjustDuration: false } as Command) as { comp: string; layer: string };
  await h.run({ type: 'moveLayersInTime', layers: [r.layer], delta: sec(1), ripple: false } as Command);
  await settle();
  return { inst: r.layer, lower: r.comp, shape };
}

beforeEach(async () => {
  h = await setupAppEngine();
  const actions = useProjectStore.getState().actions;
  actions.resetTabs();
  actions.openTab(ROOT, [ROOT], 'Main');
  useSelectionStore.getState().clear();
  await settle();
});
afterEach(async () => {
  await h.dispose();
});

describe('the network off the mirror', () => {
  it('a placed comp opens its source; a shape opens nothing; up/downstream name each other', async () => {
    const { inst, lower, shape } = await placeLowerThird();
    const m = documentMirror();
    expect(mirrorNestedTarget(m, inst)).toEqual({ compId: lower, title: 'Lower Third', kind: 'instance' });
    expect(mirrorNestedTarget(m, shape)).toBeNull();
    expect(openLayerComposition(shape)).toBe(false);

    const main = mirrorCompNetwork(m, ROOT);
    expect(main.upstream.map((e) => [e.compId, e.layerIds])).toEqual([[lower, [inst]]]);
    expect(main.downstream).toEqual([]);
    const nested = mirrorCompNetwork(m, lower);
    expect(nested.upstream).toEqual([]);
    expect(nested.downstream.map((e) => [e.compId, e.layerIds])).toEqual([[ROOT, [inst]]]);
  });
});

describe('opening and walking the trail', () => {
  it('opens the nested comp with the playhead mapped in, walks out and back, Shift+Esc toggles', async () => {
    const { inst, lower } = await placeLowerThird();
    setTime(active().id, 2);
    useSelectionStore.getState().set([inst]);

    expect(openLayerComposition(inst)).toBe(true);
    expect(active().compositionId).toBe(lower);
    expect(active().breadcrumbPath).toEqual([ROOT, lower]);
    expect(active().breadcrumbVia).toEqual([inst]);
    expect(useSelectionStore.getState().ids).toEqual([]);
    await playheadIs(1);

    setTime(active().id, 1.5);
    expect(navigateToCrumb(1)).toBe(false);
    expect(navigateToCrumb(0)).toBe(true);
    expect(active().compositionId).toBe(ROOT);
    expect(active().breadcrumbPath).toEqual([ROOT, lower]);
    await playheadIs(2.5);

    expect(canOpenPreviousComposition()).toBe(true);
    expect(openPreviousComposition()).toBe(true);
    expect(active().compositionId).toBe(lower);
    await playheadIs(1.5);
  });

  it('steps back out when an undo takes the open comp away', async () => {
    const { inst, lower } = await placeLowerThird();
    openLayerComposition(inst);
    expect(active().compositionId).toBe(lower);
    await h.run({ type: 'undo' } as Command); // the time move
    await h.run({ type: 'undo' } as Command); // the precompose
    await settle();
    repairNestedTabs();
    expect(active().compositionId).toBe(ROOT);
    expect(Object.values(useProjectStore.getState().tabs).some((t) => t.compositionId === lower)).toBe(false);
  });
});

describe('a project opened without its default comp', () => {
  // An imported After Effects project has no `comp_root` (the blank one is removed on import), but
  // a project opens with the default tab on it: the repair closed that tab and opened nothing, so
  // the Timeline read "(none)" over a composition the engine was showing (2026-11-04).
  it('opens the main composition when the only tab named a comp that is gone', async () => {
    const { lower } = await placeLowerThird();
    const made = await h.run({ type: 'createComposition', settings: { name: 'MAIN COMP', duration: sec(20) }, fromItems: [] } as Command) as { item: string };
    await h.run({ type: 'removeItems', items: [ROOT], removeUsingLayers: true } as Command);
    await settle();
    repairNestedTabs();
    const s = useProjectStore.getState();
    expect(s.tabOrder).toHaveLength(1);
    // The longest top-level comp, not Lower Third (nested in nothing now, but shorter).
    expect(active().compositionId).toBe(made.item);
    expect(active().compositionId).not.toBe(lower);
  });

  it('leaves the Timeline empty when the user closed the last tab themselves', async () => {
    const s = useProjectStore.getState();
    s.actions.closeTab(s.activeTabId!);
    repairNestedTabs();
    expect(useProjectStore.getState().tabOrder).toHaveLength(0);
  });
});
