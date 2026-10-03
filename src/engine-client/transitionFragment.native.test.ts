/**
 * A solid-mode transition as an engine client (core/library/transitionFragment.ts)
 * builds the SAME panels as `applyTransitionItem` run off-document over the
 * page replica with nothing selected: the comp-sized panels, their keys from
 * the playhead, the Blur effect a `@blur` recipe keys, the iris mask keys.
 * And the edit pastes them as ONE entry, selected.
 */

import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { TRANSITION_ITEMS, applyTransitionItem } from '@core/library/transitionLibrary';
import { buildTransitionPanels } from '@core/library/transitionFragment';
import { cancelInsertPreview } from '@core/library/insertPreview';
import { applyTransitionEdit } from '@layout/EditorLayout/transitionInsertEdits';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { FragmentBuilder } from './fragmentBuilder';
import { insertFrame } from './insertFragment';
import { normalizeFragment } from './__testHelpers__/fragmentParity';

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
  it.each(TRANSITION_ITEMS.map((t) => [t.id]))('%s: the same panels as the off-document build', (id) => {
    setPlayhead(1);
    const c = useCompositionStore.getState().comp();
    const frames = Math.round(c.durationSeconds * c.fps);
    const legacy = buildLayerFragment('comp_root', () => applyTransitionItem(id));
    const b = new FragmentBuilder({ idPrefix: 'tr' });
    const made = buildTransitionPanels(b, insertFrame('comp_root'), id, 1);
    expect(made).not.toBeNull();
    expect(legacy).not.toBeNull();
    expect(normalizeFragment(b.build()!.fragment, frames)).toEqual(normalizeFragment(legacy!.fragment, frames));
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
