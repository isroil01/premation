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

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { sceneNodeMenuItems, invertSelection, deleteLayersWithFeedback } from './sceneMenu';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import type { SceneNode } from '@core/types';

const ROOT = 'comp_main';

function node(id: string, kind: string, parent: string | null): SceneNode {
  return {
    id,
    name: id,
    parent,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 10, height: 10 } }],
  } as unknown as SceneNode;
}

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) } as never));
});

beforeEach(() => {
  useSelectionStore.getState().set([]);
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
  defaultSceneGraph.addNode(node(ROOT, 'group', null));
  defaultSceneGraph.addChild(ROOT, node('a', 'shape', ROOT));
  defaultSceneGraph.addChild(ROOT, node('b', 'shape', ROOT));
  defaultSceneGraph.addChild(ROOT, node('grp', 'group', ROOT));
  defaultSceneGraph.addChild('grp', node('kid', 'shape', 'grp'));
  useProjectStore.getState().actions.openTab(ROOT, [ROOT], 'Main');
});

const deps = { startRename: () => {} };
const menu = (id: string): ContextMenuItem[] => sceneNodeMenuItems(id, deps);
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

    useSelectionStore.getState().set(['a', 'b']);
    expect(ids(menu('a'))).toContain('merge-paths');
    expect(ids(menu('a'))).toContain('align');
  });

  it('greys distribution out below three layers, as AE does', () => {
    useSelectionStore.getState().set(['a', 'b']);
    const align = find(menu('a'), 'align')?.children ?? [];
    expect(find(align, 'align-distribute-h')?.disabled).toBe(true);

    useSelectionStore.getState().set(['a', 'b', 'grp']);
    const align3 = find(menu('a'), 'align')?.children ?? [];
    expect(find(align3, 'align-distribute-h')?.disabled).toBe(false);
  });

  it('says how many layers Delete will take', () => {
    useSelectionStore.getState().set(['a', 'b']);
    expect(find(menu('a'), 'delete')?.label).toBe('Delete 2 Layers');
    useSelectionStore.getState().set(['a']);
    expect(find(menu('a'), 'delete')?.label).toBe('Delete');
  });
});

describe('anchoring', () => {
  it('acts on the SELECTION when the clicked row is part of it', () => {
    useSelectionStore.getState().set(['a', 'b']);
    expect(find(menu('a'), 'delete')?.label).toBe('Delete 2 Layers');
  });

  it('acts on the clicked row alone when it is not in the selection', () => {
    useSelectionStore.getState().set(['a', 'b']);
    // Right-clicking outside the selection is a new target, not an addition
    // to the old one — the TreeView re-selects for exactly this reason.
    expect(find(menu('grp'), 'delete')?.label).toBe('Delete');
  });

  it('labels Hide / Lock / Solo after the clicked row, not after the first selected one', () => {
    Object.assign(defaultSceneGraph.getNode('b')!, { locked: true });
    useSelectionStore.getState().set(['a', 'b']);
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
    useSelectionStore.getState().set(['a']);
    invertSelection();
    const after = useSelectionStore.getState().ids;
    expect(after).not.toContain('a');
    expect(after).not.toContain(ROOT);
    expect(after).toEqual(expect.arrayContaining(['b', 'grp', 'kid']));
  });
});

describe('delete', () => {
  it('says what it skipped instead of silently leaving locked layers behind', async () => {
    Object.assign(defaultSceneGraph.getNode('b')!, { locked: true });
    useSelectionStore.getState().set(['a', 'b']);
    const notices: string[] = [];
    const spy = jest.spyOn(useUIStore.getState(), 'notify').mockImplementation((n) => {
      notices.push(String(n.message));
      return 'noticeId';
    });

    await deleteLayersWithFeedback(['a', 'b']);

    expect(defaultSceneGraph.getNode('a')).toBeUndefined();
    expect(defaultSceneGraph.getNode('b')).toBeDefined();
    // It has always filtered locked layers out. It did it in silence, so
    // deleting five of which two were locked looked like a partial failure
    // with no cause on screen.
    expect(notices.join(' ')).toContain('1 locked layer was left in place');
    spy.mockRestore();
  });

  it('says nothing extra when nothing was skipped', async () => {
    useSelectionStore.getState().set(['a']);
    const spy = jest.spyOn(useUIStore.getState(), 'notify').mockImplementation(() => 'noticeId');
    await deleteLayersWithFeedback(['a']);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
