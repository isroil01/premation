/**
 * Component library — save a selection as a reusable component, then insert
 * independent copies. B4 round 5: a component is the engine's `copyLayers`
 * fragment of the saved layers (built through the app's engine here); a
 * library saved in the legacy tree form is migrated on its first insert.
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { useComponentStore, type ComponentDef } from './componentStore';
import { useSelectionStore } from './selectionStore';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useComponentStore.setState({ components: [] });
});
afterEach(async () => { await h.dispose(); });

function fragmentRows(def: ComponentDef): Array<{ id: string; parent?: string | null }> {
  return (JSON.parse(def.fragment!.data) as { layers: Array<{ row: { id: string; parent?: string | null } }> }).layers.map((l) => l.row);
}

describe('component library', () => {
  it('saves a selected subtree as the engine fragment of it', async () => {
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'Card' });
    useSelectionStore.getState().set([G]);
    const id = await useComponentStore.getState().saveFromSelection('Card');
    expect(id).toBeTruthy();
    const defs = useComponentStore.getState().components;
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('Card');
    expect(defs[0]!.root).toBeUndefined();
    // The group and its two children were captured.
    expect(fragmentRows(defs[0]!).map((r) => r.id).sort()).toEqual([G, s.A, s.B].sort());
  });

  // Insert (an engine pasteLayers) is covered by componentStoreInsert.test.ts.

  it('saves a multi-selection as one component (grouped under its name on insert)', async () => {
    useSelectionStore.getState().set([s.A, s.B]);
    const id = (await useComponentStore.getState().saveFromSelection('Pair'))!;
    const def = useComponentStore.getState().components.find((c) => c.id === id)!;
    expect(fragmentRows(def).map((r) => r.id).sort()).toEqual([s.A, s.B].sort());
  });

  it('saves nothing without a selected layer', async () => {
    useSelectionStore.getState().set([]);
    expect(await useComponentStore.getState().saveFromSelection('None')).toBeNull();
    expect(useComponentStore.getState().components).toHaveLength(0);
  });

  it('removes a component', async () => {
    useSelectionStore.getState().set([s.A]);
    const id = (await useComponentStore.getState().saveFromSelection('Card'))!;
    useComponentStore.getState().remove(id);
    expect(useComponentStore.getState().components).toHaveLength(0);
  });
});
