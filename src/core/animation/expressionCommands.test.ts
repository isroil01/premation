/**
 * Add / Remove / Enable-Disable Expression: one undo step each, the timeline
 * row menu and Alt+Shift+= going through the same helper the inspector's `=`
 * toggle uses, and the editor request that opens the row.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  addExpression,
  consumeExpressionEditorRequest,
  DEFAULT_EXPRESSION,
  expressionMenuItems,
  onExpressionEditorRequest,
  removeExpression,
  setFocusedExpressionRow,
  toggleExpressionEnabled,
} from './expressionCommands';

const ID = 'expr_layer';

function undoDepth(): number {
  const hist = getCommandSystem().getHistory();
  let n = 0;
  while (hist.canUndo()) { hist.undo(); n++; }
  for (let i = 0; i < n; i++) hist.redo();
  return n;
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
  try { defaultSceneGraph.removeNode(ID); } catch { /* fresh */ }
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', rotation: 0 } }],
  } as unknown as SceneNode);
  usePropertySelectionStore.getState().clear();
  setFocusedExpressionRow(null);
});

describe('the three writes', () => {
  it('Add attaches `value` as ONE undo step and asks that row to open its editor', () => {
    const heard: Array<{ nodeId: string; prop: string }> = [];
    const off = onExpressionEditorRequest((r) => heard.push(r));
    const before = undoDepth();

    expect(addExpression([{ nodeId: ID, prop: 'rotation' }])).toBe(1);
    expect(defaultAnimation.getExpressionSrc(ID, 'rotation')).toBe(DEFAULT_EXPRESSION);
    expect(defaultAnimation.isExpressionEnabled(ID, 'rotation')).toBe(true);
    expect(undoDepth() - before).toBe(1);
    expect(heard).toEqual([{ nodeId: ID, prop: 'rotation' }]);
    // A row that mounts after the request claims it — once.
    expect(consumeExpressionEditorRequest(ID, 'rotation')).toBe(true);
    expect(consumeExpressionEditorRequest(ID, 'rotation')).toBe(false);

    getCommandSystem().getHistory().undo();
    expect(defaultAnimation.hasExpression(ID, 'rotation')).toBe(false);
    off();
  });

  it('Add on a property that already has one keeps it and adds no undo step', () => {
    defaultAnimation.setExpression(ID, 'rotation', 'time * 90');
    const before = undoDepth();
    expect(addExpression([{ nodeId: ID, prop: 'rotation' }], { openEditor: false })).toBe(0);
    expect(defaultAnimation.getExpressionSrc(ID, 'rotation')).toBe('time * 90');
    expect(undoDepth()).toBe(before);
  });

  it('Disable keeps the source, Enable restores it, Remove drops it — one undo step each', () => {
    const ref = { nodeId: ID, prop: 'rotation' };
    addExpression([ref], { openEditor: false });
    const base = undoDepth();

    expect(toggleExpressionEnabled([ref])).toBe(false);
    expect(defaultAnimation.hasExpression(ID, 'rotation')).toBe(true);
    expect(defaultAnimation.isExpressionEnabled(ID, 'rotation')).toBe(false);
    expect(toggleExpressionEnabled([ref])).toBe(true);
    expect(removeExpression([ref])).toBe(1);
    expect(defaultAnimation.hasExpression(ID, 'rotation')).toBe(false);
    expect(undoDepth() - base).toBe(3);

    getCommandSystem().getHistory().undo();
    expect(defaultAnimation.getExpressionSrc(ID, 'rotation')).toBe(DEFAULT_EXPRESSION);
  });
});

describe('the timeline row menu', () => {
  it('offers Add until every prop behind the row has one, then Disable / Remove', () => {
    const labels = (): Array<[unknown, boolean | undefined]> =>
      expressionMenuItems(ID, ['x', 'y']).map((i) => [i.label, i.disabled]);
    expect(labels()).toEqual([
      ['Add Expression', false],
      ['Disable Expression', true],
      ['Remove Expression', true],
    ]);

    expressionMenuItems(ID, ['x', 'y'])[0]!.onSelect?.();
    expect(defaultAnimation.hasExpression(ID, 'x') && defaultAnimation.hasExpression(ID, 'y')).toBe(true);
    expect(labels()).toEqual([
      ['Add Expression', true],
      ['Disable Expression', false],
      ['Remove Expression', false],
    ]);

    expressionMenuItems(ID, ['x', 'y'])[1]!.onSelect?.();
    expect(labels()[1]).toEqual(['Enable Expression', false]);
  });
});
