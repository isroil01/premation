/**
 * The viewport layer menu's document actions reach the engine API: Group
 * Selection and Merge Paths ▸ Bake are one undo entry each, and a grouping the
 * API cannot express (layers of two compositions) changes nothing and says so.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { nodeContextMenuItems } from './useWorkspaceContextMenu';

let h: Harness & { engine: LocalEngine };
let s: Scene;
const COMP = 'comp_root';

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.getState().clear();
});

afterEach(async () => {
  await h.dispose();
});

function find(items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined {
  for (const it of items) {
    if (it.id === id) return it;
    const hit = it.children ? find(it.children, id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

async function choose(anchor: string, id: string): Promise<void> {
  const item = find(nodeContextMenuItems(anchor), id);
  expect(item?.onSelect).toBeDefined();
  item!.onSelect!();
  // The handlers are fire-and-forget promises; let them land.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await engineIdle();
}

describe('Group Selection', () => {
  it('groups through the engine — one entry, the group selected', async () => {
    useSelectionStore.getState().set([s.A, s.T]);
    const entries = historyLabels().length;
    await choose(s.A, 'group');
    expect(historyLabels().slice(entries)).toEqual(['Group Layers']);
    const group = useSelectionStore.getState().ids[0]!;
    expect(defaultSceneGraph.getNode(s.A)!.parent).toBe(group);
    expect(defaultSceneGraph.getNode(s.T)!.parent).toBe(group);
  });

  it('layers of two compositions: nothing changes, a notice says why', async () => {
    const notify = jest.spyOn(useUIStore.getState(), 'notify');
    useSelectionStore.getState().set([s.A, s.c2layer]);
    const before = h.doc();
    const entries = historyLabels().length;
    await choose(s.A, 'group');
    expect(h.doc()).toBe(before);
    expect(historyLabels()).toHaveLength(entries);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/one composition/) }));
    notify.mockRestore();
  });
});

describe('Merge Paths ▸ Bake', () => {
  it('Bake Intersect: one entry, undo restores the operands', async () => {
    const rect = async (name: string): Promise<string> =>
      (await h.run({ type: 'createLayer', comp: COMP, kind: 'rectangle', name, init: [] })).layer;
    const r1 = await rect('R1');
    const r2 = await rect('R2');
    await h.run({ type: 'setProperty', prop: { layer: r2, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 1000, y: 600 } } });
    useSelectionStore.getState().set([r1, r2]);
    const before = h.doc();
    const entries = historyLabels().length;
    await choose(r1, 'merge-intersect');
    expect(historyLabels().slice(entries)).toEqual(['Merge Paths (intersect)']);
    const [merged] = useSelectionStore.getState().ids;
    expect(defaultSceneGraph.getNode(merged!)!.name).toBe('Merged (intersect)');
    expect(defaultSceneGraph.getNode(r1)).toBeUndefined();
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });
});
