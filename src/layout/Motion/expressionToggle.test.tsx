/**
 * The expression enable/disable toggle, in the panel.
 *
 * ── RULE 5·0: WHY THIS FILE EXISTS AT ALL ───────────────────────────────────
 *
 * The observable is "a user can turn an expression off and see that it is off".
 * The layer that produces it is React, and neither of the other two guards
 * samples that layer: the engine test builds its own `AnimationEngine`, and the
 * command test calls `captureAnimEdit` directly. Both would pass in full on a
 * build where the toggle was never rendered — which is exactly F29's shape, a
 * complete model with nothing wired to it, and the reason a model-only change
 * is a half-ship.
 *
 * What THIS medium cannot see is the pixels: jsdom has no layout, so "the
 * toggle looks off" is checked by `aria-checked`, not by appearance. The visual
 * state was confirmed in the running app.
 *
 * Runtime note: CSS-module class names are stubbed to '' under jest, so nothing
 * here selects on a class — the switch is found by role and label, which is
 * also the accessibility contract worth pinning.
 */

import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ExpressionEditor } from './ExpressionEditor';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { getEventBus } from '@core/events/EventBus';

const NODE = 'expr-node';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  // Providers binds this at boot; without it nothing tells React the engine moved.
  defaultAnimation.setChangeListener((nodeId) =>
    getEventBus().emit('AnimationChanged', { nodeId }),
  );
});

beforeEach(() => {
  defaultAnimation.clear();
  getCommandSystem().getHistory().clear();
  // x: 0 → 100 over 0..2s. The panel renders at the store's playhead, which is
  // 0 in a bare test — so the numbers below are read at t=0, where the
  // keyframed value is 0 and the expression's is 200.
  defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
  defaultAnimation.setKeyframe(NODE, 'x', 2, 100);
  defaultAnimation.setExpression(NODE, 'x', 'value + 200');
});

afterEach(cleanup);

const toggle = (): HTMLElement => screen.getByRole('switch', { name: 'Expression enabled' });

describe('the toggle exists and reports the engine state', () => {
  test('an attached expression renders a switch, checked', () => {
    render(<ExpressionEditor nodeId={NODE} prop="x" />);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  test('a property with NO expression renders no switch at all', () => {
    defaultAnimation.removeExpression(NODE, 'x');
    render(<ExpressionEditor nodeId={NODE} prop="x" />);
    expect(screen.queryByRole('switch', { name: 'Expression enabled' })).toBeNull();
    // …and no remove button either: there is nothing to remove.
    expect(screen.queryByRole('button', { name: 'Remove expression' })).toBeNull();
  });

  test('an attached but DISABLED expression still renders the switch, unchecked', () => {
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);
    render(<ExpressionEditor nodeId={NODE} prop="x" />);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    // The distinction the old `hasExpression`-as-`enabled` conflation lost:
    // disabled is not absent, so the remove button is still there.
    expect(screen.getByRole('button', { name: 'Remove expression' })).toBeTruthy();
  });
});

describe('clicking the toggle drives the engine, undoably', () => {
  test('click disables the expression and the property falls back to its keyframes', () => {
    render(<ExpressionEditor nodeId={NODE} prop="x" />);
    expect(defaultAnimation.sample(NODE, 'x', 1)).toBeCloseTo(250);

    act(() => { fireEvent.click(toggle()); });

    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);
    expect(defaultAnimation.hasExpression(NODE, 'x')).toBe(true);
    expect(defaultAnimation.sample(NODE, 'x', 1)).toBeCloseTo(50);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  test('clicking twice returns to the original state', () => {
    render(<ExpressionEditor nodeId={NODE} prop="x" />);
    act(() => { fireEvent.click(toggle()); });
    act(() => { fireEvent.click(toggle()); });
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(true);
    expect(defaultAnimation.sample(NODE, 'x', 1)).toBeCloseTo(250);
  });

  test('the toggle records ONE undoable command, and undo re-enables', () => {
    render(<ExpressionEditor nodeId={NODE} prop="x" />);
    const before = getCommandSystem().getHistory().canUndo();
    expect(before).toBe(false);

    act(() => { fireEvent.click(toggle()); });
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);

    act(() => { getCommandSystem().getHistory().undo(); });
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(true);
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('value + 200');
  });
});

describe('the status line does not lie about a disabled expression', () => {
  /**
   * The specific misreport this replaces: the panel used to show "= 200.00"
   * beside any expression it held. On a disabled one that is the value the
   * property does NOT have, in the one place a user goes to find out.
   */
  test('disabled says so, and does not present the value as the property value', () => {
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);
    const { container } = render(<ExpressionEditor nodeId={NODE} prop="x" />);
    const text = container.textContent ?? '';
    expect(text).toContain('Disabled');
    expect(text).toContain('the property uses its keyframes');
    expect(text).not.toMatch(/(^|[^d])= 200\.00/);
  });

  test('enabled shows the live value as before', () => {
    const { container } = render(<ExpressionEditor nodeId={NODE} prop="x" />);
    expect(container.textContent ?? '').toContain('= 200.00');
    expect(container.textContent ?? '').not.toContain('Disabled');
  });
});

/**
 * Autocomplete, at the level this medium can actually see.
 *
 * The string arithmetic — which range an accepted item replaces, where the
 * caret lands — is pinned in `expressionCompletion.test.ts`, without a DOM.
 * What is left, and what ONLY a render can check, is the wiring: that typing
 * opens the list, that the keys reach the textarea rather than the global
 * shortcut manager, and that accepting writes through to the engine.
 *
 * Note the shape of every case: the caret is set on the element before firing,
 * because a controlled textarea in jsdom does not move it for you and the
 * completion is defined entirely by where the caret is.
 */
describe('completion at the caret', () => {
  const editor = (): HTMLTextAreaElement =>
    screen.getByRole('combobox', { name: 'Expression for x' }) as HTMLTextAreaElement;

  /** Type `text` as if it were entered, leaving the caret at its end. */
  const type = (el: HTMLTextAreaElement, text: string): void => {
    act(() => {
      fireEvent.change(el, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
    });
  };

  const render1 = (): HTMLTextAreaElement => {
    defaultAnimation.removeExpression(NODE, 'x');
    render(<ExpressionEditor nodeId={NODE} prop="x" />);
    return editor();
  };

  test('typing an identifier opens a ranked list', () => {
    const el = render1();
    type(el, 'wig');
    const list = screen.getByRole('listbox', { name: 'Expression completions' });
    expect(list).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).toContain('wiggle()');
    // …with the documentation beside it, which the chip strip only had on hover.
    expect(options[0]?.textContent).toContain('smooth random motion');
    expect(options.length).toBeLessThanOrEqual(8);
  });

  test('nothing opens on punctuation or an empty field', () => {
    const el = render1();
    type(el, 'value + ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('Enter accepts the highlighted row and writes the expression through', () => {
    const el = render1();
    type(el, 'wig');
    act(() => { fireEvent.keyDown(el, { key: 'Enter' }); });
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('wiggle(2, 30)');
    // …and the list is gone, so a second Enter is a newline again.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('Tab accepts too', () => {
    const el = render1();
    type(el, 'wig');
    act(() => { fireEvent.keyDown(el, { key: 'Tab' }); });
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('wiggle(2, 30)');
  });

  test('the arrows move the highlight, and Enter takes what is highlighted', () => {
    const el = render1();
    type(el, 'loop');
    const before = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    act(() => { fireEvent.keyDown(el, { key: 'ArrowDown' }); });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'false');
    act(() => { fireEvent.keyDown(el, { key: 'Enter' }); });
    // Whatever row two was, that is what landed — asserted through the list
    // rather than against a hardcoded name, so ranking can change freely.
    const label = (before[1] ?? '').replace(/\(\).*$/, '');
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')?.startsWith(label)).toBe(true);
  });

  test('Escape dismisses without touching the text', () => {
    const el = render1();
    type(el, 'wig');
    act(() => { fireEvent.keyDown(el, { key: 'Escape' }); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('wig');
  });

  test('Ctrl+Space opens the list on demand', () => {
    const el = render1();
    type(el, 'e');
    act(() => { fireEvent.keyDown(el, { key: 'Escape' }); });
    expect(screen.queryByRole('listbox')).toBeNull();
    act(() => { fireEvent.keyDown(el, { key: ' ', code: 'Space', ctrlKey: true }); });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  test('clicking a row accepts it', () => {
    const el = render1();
    type(el, 'wig');
    act(() => { fireEvent.mouseDown(screen.getAllByRole('option')[0]!); });
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('wiggle(2, 30)');
  });

  test('a dotted access offers that object’s members', () => {
    const el = render1();
    type(el, 'thisComp.wi');
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('thisComp.width');
    act(() => { fireEvent.keyDown(el, { key: 'Enter' }); });
    // The object the user already typed is not duplicated — the bug the
    // insert-at-caret chip strip had in every form.
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('thisComp.width');
  });

  test('the combobox points a screen reader at the highlighted row', () => {
    const el = render1();
    type(el, 'wig');
    expect(el).toHaveAttribute('aria-expanded', 'true');
    const active = el.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the reference is folded away', () => {
  test('the 50-chip strip lives behind a closed disclosure', () => {
    const { container } = render(<ExpressionEditor nodeId={NODE} prop="x" />);
    const details = container.querySelector('details');
    expect(details).toBeTruthy();
    // Closed by default: the panel is the code and its value, not a wall of
    // names. The chips themselves are unchanged inside it.
    expect(details?.hasAttribute('open')).toBe(false);
    expect(container.textContent ?? '').toContain('Reference');
    expect(screen.getByRole('button', { name: 'wiggle()' })).toBeTruthy();
  });
});
