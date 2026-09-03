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
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { ModifierStackSection, hasModifierStackSection } from './ModifierStackSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  applyModifierStack,
  defaultModifier,
  readModifierStack,
  type Modifier,
} from '@core/animation/modifierStack';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

function addLayer(id: string, kind = 'shape'): void {
  defaultSceneGraph.addNode({
    id,
    name: 'Layer 1',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { __kind: kind, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 100 },
      },
    ],
  } as never);
}

/** The path the section picks by default — the first numeric property. */
function activePath(): string {
  return (screen.getByLabelText('Modified property') as HTMLSelectElement).value;
}

function stackOn(path: string): Modifier[] {
  return readModifierStack(defaultSceneGraph.getNode('rect')!, path)?.modifiers ?? [];
}

const offset = (amount: number): Modifier => ({ ...defaultModifier('offset'), amount } as Modifier);
const multiply = (factor: number): Modifier => ({ ...defaultModifier('multiply'), factor } as Modifier);

describe('ModifierStackSection', () => {
  beforeEach(() => {
    defaultSceneGraph.clear();
    defaultAnimation.clear();
    addLayer('rect');
  });

  it('offers itself to any layer with an animatable numeric property', () => {
    expect(hasModifierStackSection('rect')).toBe(true);
  });

  it('lists the layer’s own properties, not a hardcoded set', () => {
    render(<ModifierStackSection nodeId="rect" />);
    const picker = screen.getByLabelText('Modified property') as HTMLSelectElement;
    expect(picker.options.length).toBeGreaterThan(1);
    expect(picker.options.length).toBe(new Set([...picker.options].map((o) => o.value)).size);
  });

  it('starts empty and says so, rather than showing an empty box', () => {
    render(<ModifierStackSection nodeId="rect" />);
    expect(screen.getByText(/No modifiers yet/)).toBeInTheDocument();
    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('value');
  });

  it('adding a modifier installs a stack and shows what it compiles to', () => {
    render(<ModifierStackSection nodeId="rect" />);
    const path = activePath();
    fireEvent.change(screen.getByLabelText('Add modifier'), { target: { value: 'offset' } });

    expect(stackOn(path)).toHaveLength(1);
    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('(value + 10)');
    // And the property is genuinely driving off it.
    expect(defaultAnimation.getExpressionSrc('rect', path)).toBe('(value + 10)');
  });

  it('MOVING A ROW RECOMPILES — the order is the feature', () => {
    render(<ModifierStackSection nodeId="rect" />);
    const path = activePath();
    act(() => { applyModifierStack('rect', path, [offset(10), multiply(2)]); });

    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('((value + 10) * 2)');

    fireEvent.click(screen.getByLabelText('Move Multiply up'));

    // Not merely a reordered list: a DIFFERENT expression, and a different
    // number. A reorder that forgot to recompile looks correct on screen.
    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('((value * 2) + 10)');
    expect(defaultAnimation.getExpressionSrc('rect', path)).toBe('((value * 2) + 10)');
    expect(stackOn(path).map((m) => m.kind)).toEqual(['multiply', 'offset']);
  });

  it('the ends of the list cannot be moved past themselves', () => {
    render(<ModifierStackSection nodeId="rect" />);
    act(() => { applyModifierStack('rect', activePath(), [offset(10), multiply(2)]); });
    expect(screen.getByLabelText('Move Offset up')).toBeDisabled();
    expect(screen.getByLabelText('Move Multiply down')).toBeDisabled();
    expect(screen.getByLabelText('Move Offset down')).not.toBeDisabled();
  });

  it('a disabled row drops out of the compiled expression but stays in the list', () => {
    render(<ModifierStackSection nodeId="rect" />);
    const path = activePath();
    act(() => { applyModifierStack('rect', path, [offset(10), multiply(2)]); });

    fireEvent.click(screen.getByLabelText('Enable Multiply'));

    expect(screen.getByLabelText('Compiled expression')).toHaveTextContent('(value + 10)');
    // Still there, and still in position 2 — hiding it would make the order it
    // occupies invisible and re-enabling it a surprise.
    expect(stackOn(path).map((m) => m.kind)).toEqual(['offset', 'multiply']);
    expect(stackOn(path)[1]?.enabled).toBe(false);
  });

  it('removing the last row leaves an empty stack, not a broken expression', () => {
    render(<ModifierStackSection nodeId="rect" />);
    const path = activePath();
    act(() => { applyModifierStack('rect', path, [offset(10)]); });

    fireEvent.click(screen.getByLabelText('Remove Offset'));

    expect(stackOn(path)).toHaveLength(0);
    // `value`, the identity — NOT an empty expression, which would delete the
    // expression the stack record still claims to own.
    expect(defaultAnimation.getExpressionSrc('rect', path)).toBe('value');
  });

  it('a row’s parameters are typed fields, not a formula', () => {
    render(<ModifierStackSection nodeId="rect" />);
    act(() => { applyModifierStack('rect', activePath(), [{ ...defaultModifier('wiggle') } as Modifier]); });
    // The whole point of the exercise: numbers with names on them.
    expect(screen.getAllByLabelText('Frequency').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Amplitude').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Seed').length).toBeGreaterThan(0);
  });

  it('says when a parameter cannot be expressed instead of quietly ignoring it', () => {
    render(<ModifierStackSection nodeId="rect" />);
    act(() => { applyModifierStack('rect', activePath(), [{ ...defaultModifier('audio') } as Modifier]); });
    expect(screen.queryByText(/broadband/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Audio band'), { target: { value: 'low' } });
    expect(screen.getByText(/broadband/)).toBeInTheDocument();
  });

  it('the actions are dead until there is a stack to act on', () => {
    render(<ModifierStackSection nodeId="rect" />);
    expect(screen.getByRole('button', { name: 'Remove stack' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bake to keyframes' })).toBeDisabled();

    act(() => { applyModifierStack('rect', activePath(), [offset(10)]); });
    expect(screen.getByRole('button', { name: 'Remove stack' })).not.toBeDisabled();
  });

  it('Remove stack puts back the expression that was there first', () => {
    render(<ModifierStackSection nodeId="rect" />);
    const path = activePath();
    act(() => { defaultAnimation.setExpression('rect', path, 'value * 3'); });
    act(() => { applyModifierStack('rect', path, [offset(10)]); });

    fireEvent.click(screen.getByRole('button', { name: 'Remove stack' }));

    expect(defaultAnimation.getExpressionSrc('rect', path)).toBe('value * 3');
    expect(readModifierStack(defaultSceneGraph.getNode('rect')!, path)).toBeNull();
  });

  it('the behaviour menu installs an EDITABLE stack, not an opaque expression', () => {
    render(<ModifierStackSection nodeId="rect" />);
    fireEvent.change(screen.getByLabelText('Add behaviour'), { target: { value: 'Drift' } });

    expect(stackOn('x').map((m) => m.kind)).toEqual(['wiggle']);
    expect(stackOn('y').map((m) => m.kind)).toEqual(['wiggle']);
    // And the panel follows it, so the rows the user just created are on screen.
    expect(activePath()).toBe('x');
    expect(screen.getAllByLabelText('Frequency').length).toBeGreaterThan(0);
  });

  it('renders nothing for a node that is gone', () => {
    const { container } = render(<ModifierStackSection nodeId="missing" />);
    expect(container).toBeEmptyDOMElement();
  });
});
