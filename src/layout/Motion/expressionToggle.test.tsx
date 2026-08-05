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
