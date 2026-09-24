/**
 * The Modifier Stack panel.
 *
 * The compilation is proved in `core/animation/modifierCompile.test.ts` and the
 * storage in `modifierStack.test.ts`. What is left for this file is the wiring
 * a person's hands actually touch, and in particular the two things a panel
 * over an ORDERED model can get wrong without any test noticing:
 *
 *   • the property list is derived from the layer rather than hardcoded, and
 *   • moving a row changes the ORDER OF THE COMPILED EXPRESSION, not just the
 *     order of the DOM.
 *
 * The second is the one worth the file. A reorder that re-rendered the list and
 * forgot to recompile would look completely correct on screen.
 *
 * Every edit goes through the engine API (B3): the fixture is the app's engine
 * over a scene built through it, stacks are seeded with the same command
 * builders the panel sends, and each action is pinned as ONE undo entry that
 * undo reverses exactly.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { defaultModifier, readModifierStack, type Modifier } from '@core/animation/modifierStack';
import { ModifierStackSection, hasModifierStackSection } from './ModifierStackSection';
import { expressionTarget, modifierStackCommands, modifiersMoved, modifiersWithout } from './modifierEdits';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
let L: string; // the shape layer every test edits

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  L = s.B;
  getCommandSystem().getHistory().clear();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };

/** The path the section picks by default — the first numeric property. */
function activePath(): string {
  return (screen.getByLabelText('Modified property') as HTMLSelectElement).value;
}

function stackOn(path: string): Modifier[] {
  return readModifierStack(defaultSceneGraph.getNode(L)!, path)?.modifiers ?? [];
}

/** Seed a stack through the engine (as the panel would), then start from an empty history. */
async function seed(path: string, list: Modifier[]): Promise<void> {
  const cmds = modifierStackCommands(L, path, list);
  expect(cmds.length).toBeGreaterThan(0);
  await act(async () => { await h.batch('seed', cmds); });
  getCommandSystem().getHistory().clear();
}

const offset = (amount: number): Modifier => ({ ...defaultModifier('offset'), amount } as Modifier);
const multiply = (factor: number): Modifier => ({ ...defaultModifier('multiply'), factor } as Modifier);

describe('ModifierStackSection', () => {
  it('offers itself to any layer with an animatable numeric property', () => {
    expect(hasModifierStackSection(L)).toBe(true);
  });

  it('lists the layer’s own properties, not a hardcoded set', () => {
    render(<ModifierStackSection nodeId={L} />);
    const picker = screen.getByLabelText('Modified property') as HTMLSelectElement;
    expect(picker.options.length).toBeGreaterThan(1);
    expect(picker.options.length).toBe(new Set([...picker.options].map((o) => o.value)).size);
  });

  it('starts empty and says so, rather than showing an empty box', () => {
    render(<ModifierStackSection nodeId={L} />);
    expect(screen.getByText(/No modifiers yet/)).toBeInTheDocument();
    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('value');
  });

  it('adding a modifier installs a stack and shows what it compiles to — one undo entry', async () => {
    render(<ModifierStackSection nodeId={L} />);
    const path = activePath();
    const before = h.doc();
    fireEvent.change(screen.getByLabelText('Add modifier'), { target: { value: 'offset' } });
    await idle();

    expect(stackOn(path)).toHaveLength(1);
    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('(value + 10)');
    // And the property is genuinely driving off it.
    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('(value + 10)');
    settle();
    expect(historyLabels()).toEqual(['Add Modifier']);

    await undo();
    expect(stackOn(path)).toHaveLength(0);
    expect(h.doc()).toBe(before);
  });

  it('MOVING A ROW RECOMPILES — the order is the feature', async () => {
    render(<ModifierStackSection nodeId={L} />);
    const path = activePath();
    await seed(path, [offset(10), multiply(2)]);

    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('((value + 10) * 2)');
    const before = h.doc();

    fireEvent.click(screen.getByLabelText('Move Multiply up'));
    await idle();

    // Not merely a reordered list: a DIFFERENT expression, and a different
    // number. A reorder that forgot to recompile looks correct on screen.
    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('((value * 2) + 10)');
    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('((value * 2) + 10)');
    expect(stackOn(path).map((m) => m.kind)).toEqual(['multiply', 'offset']);
    settle();
    expect(historyLabels()).toEqual(['Reorder Modifier']);

    await undo();
    expect(stackOn(path).map((m) => m.kind)).toEqual(['offset', 'multiply']);
    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('((value + 10) * 2)');
    expect(h.doc()).toBe(before);
  });

  it('▼ moves a row down, as one entry', async () => {
    render(<ModifierStackSection nodeId={L} />);
    const path = activePath();
    await seed(path, [offset(10), multiply(2)]);

    fireEvent.click(screen.getByLabelText('Move Offset down'));
    await idle();

    expect(stackOn(path).map((m) => m.kind)).toEqual(['multiply', 'offset']);
    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('((value * 2) + 10)');
    settle();
    expect(historyLabels()).toEqual(['Reorder Modifier']);
  });

  it('the ends of the list cannot be moved past themselves', async () => {
    render(<ModifierStackSection nodeId={L} />);
    await seed(activePath(), [offset(10), multiply(2)]);
    expect(screen.getByLabelText('Move Offset up')).toBeDisabled();
    expect(screen.getByLabelText('Move Multiply down')).toBeDisabled();
    expect(screen.getByLabelText('Move Offset down')).not.toBeDisabled();
  });

  it('a disabled row drops out of the compiled expression but stays in the list', async () => {
    render(<ModifierStackSection nodeId={L} />);
    const path = activePath();
    await seed(path, [offset(10), multiply(2)]);

    fireEvent.click(screen.getByLabelText('Enable Multiply'));
    await idle();

    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('(value + 10)');
    // Still there, and still in position 2 — hiding it would make the order it
    // occupies invisible and re-enabling it a surprise.
    expect(stackOn(path).map((m) => m.kind)).toEqual(['offset', 'multiply']);
    expect(stackOn(path)[1]?.enabled).toBe(false);
  });

  it('removing a row is one entry that undo brings back in place', async () => {
    render(<ModifierStackSection nodeId={L} />);
    const path = activePath();
    await seed(path, [offset(10), multiply(2)]);
    const before = h.doc();

    fireEvent.click(screen.getByLabelText('Remove Offset'));
    await idle();

    expect(stackOn(path).map((m) => m.kind)).toEqual(['multiply']);
    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('(value * 2)');
    settle();
    expect(historyLabels()).toEqual(['Remove Modifier']);

    await undo();
    expect(stackOn(path).map((m) => m.kind)).toEqual(['offset', 'multiply']);
    expect(h.doc()).toBe(before);
  });

  it('removing the last row leaves an empty stack, not a broken expression', async () => {
    render(<ModifierStackSection nodeId={L} />);
    const path = activePath();
    await seed(path, [offset(10)]);

    fireEvent.click(screen.getByLabelText('Remove Offset'));
    await idle();

    expect(readModifierStack(defaultSceneGraph.getNode(L)!, path)).not.toBeNull();
    expect(stackOn(path)).toHaveLength(0);
    // `value`, the identity — NOT an empty expression, which would delete the
    // expression the stack record still claims to own.
    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('value');
  });

  it('a row’s parameters are typed fields, not a formula', async () => {
    render(<ModifierStackSection nodeId={L} />);
    await seed(activePath(), [{ ...defaultModifier('wiggle') } as Modifier]);
    // The whole point of the exercise: numbers with names on them.
    expect(screen.getAllByLabelText('Frequency').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Amplitude').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Seed').length).toBeGreaterThan(0);
  });

  it('says when a parameter cannot be expressed instead of quietly ignoring it', async () => {
    render(<ModifierStackSection nodeId={L} />);
    await seed(activePath(), [{ ...defaultModifier('audio') } as Modifier]);
    expect(screen.queryByText(/broadband/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Audio band'), { target: { value: 'low' } });
    await idle();
    expect(screen.getByText(/broadband/)).toBeInTheDocument();
  });

  it('the actions are dead until there is a stack to act on', async () => {
    render(<ModifierStackSection nodeId={L} />);
    expect(screen.getByRole('button', { name: 'Remove stack' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bake to keyframes' })).toBeDisabled();

    await seed(activePath(), [offset(10)]);
    expect(screen.getByRole('button', { name: 'Remove stack' })).not.toBeDisabled();
  });

  it('Remove stack puts back the expression that was there first', async () => {
    render(<ModifierStackSection nodeId={L} />);
    const path = activePath();
    const t = expressionTarget(L, path)!;
    await act(async () => {
      await h.run({ type: 'setExpression', prop: t.prop, source: 'value * 3', enabled: true, ...(t.member !== undefined ? { member: t.member } : {}) });
    });
    await seed(path, [offset(10)]);
    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('(value + 10)');

    fireEvent.click(screen.getByRole('button', { name: 'Remove stack' }));
    await idle();

    expect(defaultAnimation.getExpressionSrc(L, path)).toBe('value * 3');
    expect(readModifierStack(defaultSceneGraph.getNode(L)!, path)).toBeNull();
    settle();
    expect(historyLabels()).toEqual(['Remove Modifier Stack']);
  });

  it('the behaviour menu installs an EDITABLE stack, not an opaque expression', async () => {
    render(<ModifierStackSection nodeId={L} />);
    fireEvent.change(screen.getByLabelText('Add behaviour'), { target: { value: 'Drift' } });
    await idle();

    expect(stackOn('x').map((m) => m.kind)).toEqual(['wiggle']);
    expect(stackOn('y').map((m) => m.kind)).toEqual(['wiggle']);
    // And the panel follows it, so the rows the user just created are on screen.
    expect(activePath()).toBe('x');
    expect(screen.getAllByLabelText('Frequency').length).toBeGreaterThan(0);
    // Both axes in ONE entry.
    settle();
    expect(historyLabels()).toEqual(['Add Drift']);
  });

  it('renders nothing for a node that is gone', () => {
    const { container } = render(<ModifierStackSection nodeId="missing" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('modifier list arithmetic (modifierEdits)', () => {
  const a = offset(1);
  const b = multiply(2);
  const c = offset(3);

  it('moves a row and clamps the target to the list', () => {
    expect(modifiersMoved([a, b, c], 0, 2)).toEqual([b, c, a]);
    expect(modifiersMoved([a, b, c], 2, 0)).toEqual([c, a, b]);
    expect(modifiersMoved([a, b, c], 1, 99)).toEqual([a, c, b]);
    expect(modifiersMoved([a, b, c], 1, -5)).toEqual([b, a, c]);
    expect(modifiersMoved([a, b, c], 7, 0)).toEqual([a, b, c]);
  });

  it('removes by id and leaves the input alone', () => {
    const list = [a, b];
    expect(modifiersWithout(list, a.id)).toEqual([b]);
    expect(list).toEqual([a, b]);
  });
});
