/**
 * A solid-mode transition as an engine client (core/library/transitionFragment.ts):
 * every item builds its comp-sized panels, keyed from the playhead, in a
 * fragment the engine takes; and the edit pastes them as ONE entry, selected.
 */

import { unwrap } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { TRANSITION_ITEMS } from '@core/library/transitionLibrary';
import { buildTransitionPanels } from '@core/library/transitionFragment';
import { cancelInsertPreview } from '@core/library/insertPreview';
import { applyTransitionEdit } from '@layout/EditorLayout/transitionInsertEdits';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { FragmentBuilder } from './fragmentBuilder';
import { insertFrame } from './insertFragment';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
  useSelectionStore.getState().set([]);
});
afterEach(async () => {
  cancelInsertPreview();
  await h.dispose();
});

function setPlayhead(t: number): void {
  const ws = useWorkspaceStore.getState();
  const tab = ws.activeTabId!;
  useWorkspaceStore.setState({ tabs: { ...ws.tabs, [tab]: { ...ws.tabs[tab]!, time: t } } });
}

describe('solid-mode transitions as engine clients', () => {
  it.each(TRANSITION_ITEMS.map((t) => [t.id]))('%s: comp-sized panels the engine takes', async (id) => {
    setPlayhead(1);
    const b = new FragmentBuilder({ idPrefix: 'tr' });
    const made = buildTransitionPanels(b, insertFrame('comp_root'), id, 1);
    expect(made).not.toBeNull();
    const built = b.build()!;
    const item = TRANSITION_ITEMS.find((t) => t.id === id)!;
    expect(made!.panels.length).toBe(item.solidCount ?? 1);
    // Keys start at the playhead (1 s): no panel key lands before it.
    for (const l of built.layers) {
      for (const keys of Object.values(l.anim?.tracks ?? {})) for (const k of keys) expect(k.t).toBeGreaterThanOrEqual(-1e-9);
    }
    const before = await h.doc();
    const ids = unwrap(await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built.fragment })).layers;
    expect(ids).toHaveLength(built.scratchIds.length);
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });

  it('pastes the panels as ONE entry and selects them', async () => {
    const item = TRANSITION_ITEMS.find((t) => (t.solidCount ?? 1) > 1) ?? TRANSITION_ITEMS[0]!;
    const n = (await historyLabels()).length;
    const r = await applyTransitionEdit(item.id, `Apply ${item.name}`);
    expect(r?.mode).toBe('solid');
    expect(r!.nodeIds.length).toBe(item.solidCount ?? 1);
    expect((await historyLabels()).length).toBe(n + 1);
    expect(useSelectionStore.getState().ids).toEqual(r!.nodeIds);
  });
});
