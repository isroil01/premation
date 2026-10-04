/**
 * The Layers row menu, as a LIST.
 *
 * What the panel offers is a question about this table, not about React, so it
 * is asserted here without standing a tree up. The report behind it: the menu
 * carried nine verbs while the app had implemented four times that many, and
 * every missing one was already shipped, wired and reachable from somewhere
 * else — which, from the user's side of the panel they are looking at, is the
 * same as not existing.
 *
 * Also pinned: a composition root gets the COMP's verbs, not a layer's, and
 * deleting a locked layer says so instead of quietly skipping it.
 */

import type { Command } from '@motion/engine-api';
import { sceneNodeMenuItems, invertSelection, deleteLayersWithFeedback } from './sceneMenu';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import type { ContextMenuItem } from '@stores/contextMenuStore';

const ROOT = 'comp_root';

let h: Harness;
/** Fixture names → the engine's layer ids. */
const L: Record<string, string> = {};

async function layer(name: string, kind: string, comp: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp, kind, name, init: [] } as Command) as { layer: string }).layer;
}

async function lock(name: string): Promise<void> {
  await h.run({ type: 'setLayerSwitches', layers: [L[name]!], patch: { locked: true } } as Command);
  await settleEdits();
}

beforeEach(async () => {
  h = await setupAppEngine();
  useSelectionStore.getState().set([]);
  L.a = await layer('a', 'shape', ROOT);
  L.b = await layer('b', 'shape', ROOT);
  L.kid = await layer('kid', 'shape', ROOT);
  L.grp = (await h.run({ type: 'groupLayers', layers: [L.kid], name: 'grp' } as Command) as { layer: string }).layer;
  await settleEdits();
  const actions = useProjectStore.getState().actions;
  actions.setActiveTab(actions.openTab(ROOT, [ROOT], 'Main'));
});
afterEach(async () => {
  await h.dispose();
});

/** Select fixture layers by name. */
const select = (...names: string[]): void => useSelectionStore.getState().set(names.map((n) => L[n]!));

const deps = { startRename: () => {} };
const menu = (name: string): ContextMenuItem[] => sceneNodeMenuItems(L[name] ?? name, deps);
const ids = (items: ContextMenuItem[]): string[] => items.map((i) => i.id);
const find = (items: ContextMenuItem[], id: string): ContextMenuItem | undefined =>
  items.find((i) => i.id === id);

describe('what the menu offers', () => {
  it('reaches the verbs that existed but were unreachable from this panel', () => {
    const m = ids(menu('a'));
    // Each of these routes to the same implementation the menu bar or the
    // timeline already used; none of them is a second copy.
    expect(m).toEqual(expect.arrayContaining([
      'rename', 'duplicate', 'arrange',
      'switches', 'labelColor',
      'blend', 'matte', 'parent',
      'transform', 'time',
      'group', 'precompose',
      'select-all', 'invert', 'delete',
    ]));
  });

  it('names the layer\'s current blending mode on the submenu, not just "Blending Mode"', () => {
    // The value you are about to change is worth reading before you open a
    // list of thirty to change it.
    expect(String(find(menu('a'), 'blend')?.label)).toContain('Normal');
  });

  it('offers Ungroup only on a group', () => {
    expect(ids(menu('grp'))).toContain('ungroup');
    expect(ids(menu('a'))).not.toContain('ungroup');
  });

  it('offers the multi-layer verbs only with more than one layer selected', () => {
    expect(ids(menu('a'))).not.toContain('merge-paths');
    expect(ids(menu('a'))).not.toContain('align');

    select('a', 'b');
    expect(ids(menu('a'))).toContain('merge-paths');
    expect(ids(menu('a'))).toContain('align');
  });

  it('greys distribution out below three layers, as AE does', () => {
    select('a', 'b');
    const align = find(menu('a'), 'align')?.children ?? [];
    expect(find(align, 'align-distribute-h')?.disabled).toBe(true);

    select('a', 'b', 'grp');
    const align3 = find(menu('a'), 'align')?.children ?? [];
    expect(find(align3, 'align-distribute-h')?.disabled).toBe(false);
  });

  it('says how many layers Delete will take', () => {
    select('a', 'b');
    expect(find(menu('a'), 'delete')?.label).toBe('Delete 2 Layers');
    select('a');
    expect(find(menu('a'), 'delete')?.label).toBe('Delete');
  });
});

describe('anchoring', () => {
  it('acts on the SELECTION when the clicked row is part of it', () => {
    select('a', 'b');
    expect(find(menu('a'), 'delete')?.label).toBe('Delete 2 Layers');
  });

  it('acts on the clicked row alone when it is not in the selection', () => {
    select('a', 'b');
    // Right-clicking outside the selection is a new target, not an addition
    // to the old one — the TreeView re-selects for exactly this reason.
    expect(find(menu('grp'), 'delete')?.label).toBe('Delete');
  });

  it('labels Hide / Lock / Solo after the clicked row, not after the first selected one', async () => {
    await lock('b');
    select('a', 'b');
    // In a mixed selection these differed, and "Unlock" locked everything.
    expect(find(menu('b'), 'lock')?.label).toBe('Unlock');
    expect(find(menu('a'), 'lock')?.label).toBe('Lock');
  });
});

describe('composition roots', () => {
  it('offers the composition\'s verbs, not a layer\'s', () => {
    const m = ids(menu(ROOT));
    expect(m).toEqual(['rename', 'sep-root', 'settings']);
    // A comp has no switches, no parent and no blending mode; offering them
    // here would be a second, divergent set of comp verbs beside the
    // Compositions list directly above.
    expect(m).not.toContain('switches');
    expect(m).not.toContain('parent');
  });
});

describe('invert selection', () => {
  it('selects every layer that was not selected, roots excluded', () => {
    select('a');
    invertSelection();
    const after = useSelectionStore.getState().ids;
    expect(after).not.toContain(L.a);
    expect(after).not.toContain(ROOT);
    expect(after).toEqual(expect.arrayContaining([L.b, L.grp, L.kid]));
  });
});

describe('delete', () => {
  it('says what it skipped instead of silently leaving locked layers behind', async () => {
    await lock('b');
    select('a', 'b');
    const notices: string[] = [];
    const spy = jest.spyOn(useUIStore.getState(), 'notify').mockImplementation((n) => {
      notices.push(String(n.message));
      return 'noticeId';
    });

    await deleteLayersWithFeedback([L.a!, L.b!]);
    await settleEdits();

    expect(documentMirror().layer(L.a!)).toBeUndefined();
    expect(documentMirror().layer(L.b!)).toBeDefined();
    // It has always filtered locked layers out. It did it in silence, so
    // deleting five of which two were locked looked like a partial failure
    // with no cause on screen.
    expect(notices.join(' ')).toContain('1 locked layer was left in place');
    spy.mockRestore();
  });

  it('says nothing extra when nothing was skipped', async () => {
    select('a');
    const spy = jest.spyOn(useUIStore.getState(), 'notify').mockImplementation(() => 'noticeId');
    await deleteLayersWithFeedback([L.a!]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
