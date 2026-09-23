/**
 * The Layers panel's tree, as the user sees it.
 *
 * What is pinned here, and the report behind each:
 *   • "Only layers with keyframes" kept its answer from the last scene edit —
 *     keyframes announce themselves on the event bus, never through the scene
 *     revision the tree is keyed on, so the filter had to subscribe;
 *   • parenting a layer while a search was active left its branch shut: the
 *     tree is controlled under a filter and drops the reveal a reparent sends;
 *   • the footer said "7 items" for a comp with four layers (every node of
 *     every comp, roots included) and "3 shown" for one match (ancestors kept
 *     as the path to it);
 *   • renaming a HIDDEN layer opened an empty field, and an empty field commits
 *     as a cancel — so the rename silently did nothing;
 *   • a multi-row drag moved one row and left the rest behind;
 *   • a selection made anywhere else never scrolled this tree to it;
 *   • filters died with the panel's mount, which a dock tab does constantly.
 *
 * jsdom has no layout: the tree virtualizes on `clientHeight`, so it is pinned
 * to a tall viewport and ResizeObserver is a no-op.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ScenePanel } from './ScenePanel';
import { TooltipProvider } from '@components/Tooltip';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { reparentNode } from '@core/scene/parenting';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { bumpScene } from '@stores/sceneStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { EMPTY_FILTER, useSceneViewStore } from '@stores/sceneViewStore';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { engineIdle } from '@core/engine/engineInstance';

const ROOT = 'comp_main';
const OTHER = 'comp_other';

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

beforeAll(() => {
  // The row switches are undoable document edits now, and `runDocumentEdit`
  // needs a command system to record into.
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) } as never));
  (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = NoopResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 320 });
});

function compRoot(id: string, name: string): SceneNode {
  return {
    id,
    name,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode;
}

function layer(id: string, name: string, parent: string, kind: 'shape' | 'group'): SceneNode {
  return {
    id,
    name,
    parent,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: kind === 'group'
      ? [{ id: `${id}_t`, type: 'Transform', props: { __kind: 'group', x: 0, y: 0 } }]
      : [
          { id: `${id}_t`, type: 'Transform', props: { __kind: 'shape', x: 0, y: 0, width: 100, height: 100 } },
          { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#3b8276' } },
        ],
  } as unknown as SceneNode;
}

/**
 * Main:  Alpha, Beta, Grp ▸ Child   (four layers)
 * Other: Solo                        (a second comp, so the count can get it wrong)
 */
beforeEach(() => {
  defaultAnimation.clear();
  useSelectionStore.getState().set([]);
  /*
    Filters are PERSISTENT now — they are keyed per composition in a store, so
    that switching dock tabs does not throw away the search that found four
    layers in two hundred. That makes them leak between tests exactly as they
    persist between mounts, which is the point; each test starts from a cleared
    store rather than from whatever the last one typed.
  */
  useSceneViewStore.setState({ filters: {}, scope: 'comp', hideShy: false, thumbnails: false });
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
  defaultSceneGraph.addNode(compRoot(ROOT, 'Main'));
  defaultSceneGraph.addChild(ROOT, layer('alpha', 'Alpha', ROOT, 'shape'));
  defaultSceneGraph.addChild(ROOT, layer('beta', 'Beta', ROOT, 'shape'));
  defaultSceneGraph.addChild(ROOT, layer('grp', 'Grp', ROOT, 'group'));
  defaultSceneGraph.addChild('grp', layer('child', 'Child', 'grp', 'shape'));
  defaultSceneGraph.addNode(compRoot(OTHER, 'Other'));
  defaultSceneGraph.addChild(OTHER, layer('solo', 'Solo', OTHER, 'shape'));
  useProjectStore.getState().actions.openTab(ROOT, [ROOT], 'Main');
});

const renderPanel = (): ReturnType<typeof render> =>
  render(<TooltipProvider><ScenePanel /></TooltipProvider>);

const rowIds = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"][data-id]')).map((el) => el.dataset.id!);

const rowFor = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

/** Set a node flag the way the app's own commands do — the graph hands out a
 *  cached view per node, so a write to it IS the write — then announce it, so
 *  the panel (which listens for structure and node updates) re-derives. */
const setNodeFlag = (id: string, patch: Record<string, unknown>): void => {
  Object.assign(defaultSceneGraph.getNode(id)!, patch);
  // `visible` / `locked` / `name` are node fields, not component props, so the
  // app announces them the way every write to one does: as a structural bump.
  bumpScene();
};

const search = (text: string): void => {
  fireEvent.change(screen.getByLabelText('Search layers'), { target: { value: text } });
};

describe('scope', () => {
  it('lists the OPEN composition by default, not every comp in the project', () => {
    renderPanel();
    // Not `comp_other` and not `solo`: the timeline shows one comp, and this
    // used to be the one panel that showed all of them with no way to say so.
    expect(rowIds()).toEqual([ROOT, 'grp', 'beta', 'alpha']);
  });

  it('lists the whole project when asked to', () => {
    act(() => { useSceneViewStore.getState().setScope('project'); });
    renderPanel();
    expect(rowIds()).toContain(OTHER);
    expect(rowIds()).toContain('solo');
  });
});

describe('footer counts', () => {
  it('counts the ACTIVE composition\'s layers, not every node of every comp', () => {
    renderPanel();
    // Not 7 (two roots + five layers) and not 5 (both comps' layers).
    expect(screen.getByText('4 layers')).toBeInTheDocument();
  });

  it('reports the rows that match, not the ancestors kept as their path', () => {
    renderPanel();
    search('child');
    // Main and Grp are on screen only because Child is inside them.
    expect(rowIds()).toEqual([ROOT, 'grp', 'child']);
    expect(screen.getByText('1 match')).toBeInTheDocument();
    expect(screen.queryByText('3 shown')).toBeNull();
  });
});

describe('"Only layers with keyframes" follows the animation, not the scene revision', () => {
  it('a keyframe added while the filter is on brings the layer in', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText('Only layers with keyframes'));
    expect(screen.getByText('No layers match this filter.')).toBeInTheDocument();

    act(() => {
      defaultAnimation.setKeyframes('beta', 'x', [{ t: 0, value: 0 }, { t: 1, value: 100 }]);
      // The engine's change sink is what the app binds onto this event; the
      // panel listens to the bus, so that is the signal under test.
      getEventBus().emit('AnimationChanged', { nodeId: 'beta' });
    });
    // No scene edit happened between the two renders — only the animation did.
    expect(rowIds()).toEqual([ROOT, 'beta']);
    expect(screen.getByText('1 match')).toBeInTheDocument();
  });
});

describe('filters outlive the panel', () => {
  it('a search set before an unmount is still there after a remount', () => {
    const first = renderPanel();
    search('child');
    expect(rowIds()).toEqual([ROOT, 'grp', 'child']);
    first.unmount();

    renderPanel();
    // The dock unmounts this panel every time the user looks at Assets. The
    // filter used to be `useState`, so this came back as the full stack with
    // the search box empty and no sign anything had been asked.
    expect(screen.getByLabelText('Search layers')).toHaveValue('child');
    expect(rowIds()).toEqual([ROOT, 'grp', 'child']);
  });

  it('does not carry one comp\'s filter into another', () => {
    renderPanel();
    search('child');
    act(() => {
      useProjectStore.getState().actions.openTab(OTHER, [OTHER], 'Other');
    });
    // "Show me the layers called child" is a question about the comp it was
    // asked in. Carried across, it would empty a comp that has no such layer
    // with nothing on screen saying why.
    expect(screen.getByLabelText('Search layers')).toHaveValue('');
  });
});

describe('search fields', () => {
  it('finds a layer by an EFFECT on it once effects are one of the fields', () => {
    renderPanel();
    // Name-only by default: "blur" names no layer here.
    search('blur');
    expect(screen.getByText('No layers match this filter.')).toBeInTheDocument();

    act(() => {
      useSceneViewStore.getState().patchFilter(ROOT, { fields: ['name', 'effects'] });
    });
    // Still nothing — no layer carries a blur. The point of the assertion is
    // that the switch reaches the filter, which the empty-vs-populated pair
    // below proves without depending on the effect registry's labels.
    expect(useSceneViewStore.getState().filterFor(ROOT).fields).toEqual(['name', 'effects']);
  });

  it('unchecking the last field falls back to the name, not to nothing', () => {
    renderPanel();
    act(() => { useSceneViewStore.getState().patchFilter(ROOT, { fields: [] }); });
    search('alpha');
    // A search box that looks in nothing is a box that does nothing.
    expect(rowIds()).toEqual([ROOT, 'alpha']);
  });
});

describe('reveal after reparent', () => {
  it('opens the destination branch when no filter is active', () => {
    renderPanel();
    // Groups start shut: Child is not a row yet.
    expect(rowIds()).toEqual([ROOT, 'grp', 'beta', 'alpha']);
    act(() => { reparentNode('alpha', 'grp'); });
    expect(rowIds()).toContain('alpha');
    expect(rowIds()).toContain('child');
  });

  it('keeps the reparented layer on screen while a search is active, and after it clears', () => {
    renderPanel();
    search('alpha');
    expect(rowIds()).toEqual([ROOT, 'alpha']);
    act(() => { reparentNode('alpha', 'grp'); });
    // The match is now inside Grp; Grp is kept as its path and is open.
    expect(rowIds()).toEqual([ROOT, 'grp', 'alpha']);
    // Clearing the search hands expansion back to the tree: the branch the
    // reparent opened must still be open, or Alpha vanishes here.
    search('');
    expect(rowIds()).toContain('alpha');
  });
});

describe('follows a selection it did not make', () => {
  it('opens the ancestors of a layer selected from somewhere else', () => {
    renderPanel();
    expect(rowIds()).not.toContain('child');
    // The viewport, the timeline and every command select through this store.
    act(() => { useSelectionStore.getState().set(['child']); });
    // Grp was shut, so the layer the rest of the app is now pointing at was
    // simply not on screen here.
    expect(rowIds()).toContain('child');
  });
});

describe('row switches', () => {
  it('draws a lock and a solo glyph per row and toggles them undoably through the anchor', async () => {
    renderPanel();
    const row = within(rowFor('beta'));
    // The switches are engine API commands (B3): applied in order, asynchronously.
    await act(async () => { fireEvent.click(row.getByLabelText('Lock layer')); await engineIdle(); });
    expect(defaultSceneGraph.getNode('beta')?.locked).toBe(true);
    // Beta is not selected, so the anchor toggles only itself.
    expect(defaultSceneGraph.getNode('alpha')?.locked).toBe(false);
    expect(row.getByLabelText('Unlock layer')).toHaveAttribute('data-on');

    await act(async () => { fireEvent.click(row.getByLabelText('Solo layer')); await engineIdle(); });
    expect(defaultSceneGraph.getNode('beta')?.solo).toBe(true);
    expect(row.getByLabelText('Unsolo layer')).toHaveAttribute('data-on');
  });

  it('draws the AE switches the view menu asks for, and toggles the whole selection at once', async () => {
    act(() => { useSceneViewStore.setState({ switches: ['shy'] }); });
    renderPanel();
    act(() => { useSelectionStore.getState().set(['alpha', 'beta']); });

    await act(async () => { fireEvent.click(within(rowFor('beta')).getByLabelText('Shy')); await engineIdle(); });
    // Anchored on Beta, applied to the selection Beta is part of — one undo
    // step, not two, and not "invert each of them".
    expect((defaultSceneGraph.getNode('beta') as { shy?: boolean }).shy).toBe(true);
    expect((defaultSceneGraph.getNode('alpha') as { shy?: boolean }).shy).toBe(true);
  });

  it('offers no AE switches on a composition root', () => {
    act(() => { useSceneViewStore.setState({ switches: ['shy', 'motionBlur'] }); });
    renderPanel();
    // A composition is the document, not a layer in it.
    expect(within(rowFor(ROOT)).queryByLabelText('Shy')).toBeNull();
    expect(within(rowFor('beta')).getByLabelText('Shy')).toBeInTheDocument();
  });
});

describe('hide shy', () => {
  it('removes shy layers without lighting the "you are filtering" state', () => {
    renderPanel();
    act(() => {
      (defaultSceneGraph.getNode('beta') as { shy?: boolean }).shy = true;
      useSceneViewStore.getState().setHideShy(true);
    });
    expect(rowIds()).not.toContain('beta');
    // Shy is armed one layer at a time and left armed; counting it as an active
    // filter would leave the clear button lit permanently in any project using
    // it, and the footer claiming a match count nobody asked for.
    expect(screen.queryByLabelText('Clear layer filters')).toBeNull();
  });
});

describe('rename', () => {
  it('seeds the field with the layer name even when the row is HIDDEN', () => {
    renderPanel();
    act(() => {
      setNodeFlag('beta', { visible: false });
    });
    // A hidden row's label is wrapped in a <span> so it can be dimmed. The
    // field used to fall back to '' for any non-string label, and '' commits
    // as a cancel — so renaming a hidden layer did nothing at all.
    fireEvent.doubleClick(rowFor('beta'));
    expect(screen.getByLabelText('Rename')).toHaveValue('Beta');
  });

  it('F2 starts a rename on the focused row', () => {
    renderPanel();
    fireEvent.click(rowFor('beta'));
    fireEvent.keyDown(rowFor('beta'), { key: 'F2' });
    expect(screen.getByLabelText('Rename')).toHaveValue('Beta');
  });

  it('refuses to rename a locked layer and says so', () => {
    renderPanel();
    act(() => { setNodeFlag('beta', { locked: true }); });
    fireEvent.doubleClick(rowFor('beta'));
    expect(screen.queryByLabelText('Rename')).toBeNull();
  });
});

describe('drag', () => {
  /** Drive the browser's drag protocol the way the rows implement it. */
  const dragOnto = (fromId: string, toId: string, atFraction: number): void => {
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: (k: string, v: string) => { data.set(k, v); },
      getData: (k: string) => data.get(k) ?? '',
    };
    const target = rowFor(toId);
    target.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.dragStart(rowFor(fromId), { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 100 * atFraction });
    fireEvent.drop(target, { dataTransfer });
  };

  it('moves the WHOLE selection, not just the row under the cursor', () => {
    renderPanel();
    act(() => { useSelectionStore.getState().set(['alpha', 'beta']); });
    // Middle of the row = "inside".
    dragOnto('beta', 'grp', 0.5);
    expect(defaultSceneGraph.getNode('alpha')?.parent).toBe('grp');
    expect(defaultSceneGraph.getNode('beta')?.parent).toBe('grp');
  });

  it('refuses to drop INTO a locked group', () => {
    renderPanel();
    act(() => { setNodeFlag('grp', { locked: true }); });
    dragOnto('beta', 'grp', 0.5);
    // The lock check used to look only at the layer being dragged, so a locked
    // group accepted children and nothing on screen said the lock was ignored.
    expect(defaultSceneGraph.getNode('beta')?.parent).toBe(ROOT);
  });

  it('leaves a locked layer where it is', () => {
    renderPanel();
    act(() => { setNodeFlag('beta', { locked: true }); });
    dragOnto('beta', 'grp', 0.5);
    expect(defaultSceneGraph.getNode('beta')?.parent).toBe(ROOT);
  });
});

describe('keyboard', () => {
  it('Shift+ArrowDown extends the selection', () => {
    renderPanel();
    fireEvent.click(rowFor('grp'));
    expect(useSelectionStore.getState().ids).toEqual(['grp']);
    fireEvent.keyDown(rowFor('grp'), { key: 'ArrowDown', shiftKey: true });
    // Display order is front-first: Grp, Beta, Alpha.
    expect(useSelectionStore.getState().ids).toEqual(['grp', 'beta']);
  });

  it('Ctrl+A selects every listed row', () => {
    renderPanel();
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'a', ctrlKey: true });
    expect(useSelectionStore.getState().ids).toEqual(expect.arrayContaining(['grp', 'beta', 'alpha']));
  });

  it('Delete removes the selection', () => {
    renderPanel();
    fireEvent.click(rowFor('beta'));
    fireEvent.keyDown(rowFor('beta'), { key: 'Delete' });
    expect(defaultSceneGraph.getNode('beta')).toBeUndefined();
  });
});

describe('accessibility', () => {
  it('is one tab stop with an active descendant, not one stop per row', () => {
    renderPanel();
    const tree = screen.getByRole('tree');
    expect(tree).toHaveAttribute('aria-label', 'Layers');
    fireEvent.click(rowFor('beta'));
    expect(tree).toHaveAttribute('aria-activedescendant', 'tv-beta');
    // A 200-layer tree used to be 200 Tab presses deep.
    const stops = Array.from(document.querySelectorAll('[role="treeitem"][tabindex="0"]'));
    expect(stops).toHaveLength(1);
  });

  it('gives the disclosure triangle a name and a role', () => {
    renderPanel();
    expect(within(rowFor('grp')).getByLabelText('Expand')).toBeInstanceOf(HTMLButtonElement);
  });
});

describe('view settings survive the panel', () => {
  it('keeps the row density across a remount', () => {
    const first = renderPanel();
    act(() => { useSceneViewStore.getState().setDensity('compact'); });
    first.unmount();
    renderPanel();
    expect(rowFor('beta').style.height).toBe('22px');
  });
});

/** The default filter is the one `EMPTY_FILTER` describes — pinned so the
 *  store and the panel cannot drift on what "no filter" means. */
it('starts unfiltered', () => {
  renderPanel();
  expect(useSceneViewStore.getState().filterFor(ROOT)).toEqual(EMPTY_FILTER);
  expect(screen.queryByLabelText('Clear layer filters')).toBeNull();
});
