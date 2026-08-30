/**
 * What the whip lands on.
 *
 * The walk is the whole of the pick-whip's correctness: drop on the wrong row
 * and the gesture parents a layer to the wrong thing or writes an expression
 * that reads someone else's position — both of which look like the feature
 * working, until the render.
 */

import { insertAtCaret, resolveWhipTargetAt, whipExpression, type WhipDom } from './whipTarget';

/** A DOM stub that answers `elementFromPoint` with whatever is handed in. */
function domAt(element: Element | null): WhipDom {
  return { elementFromPoint: () => element };
}

/** Build a nested chain of elements with attributes, innermost last. */
function chain(...levels: Array<Record<string, string>>): Element {
  let parent: HTMLElement | null = null;
  let innermost: HTMLElement | null = null;
  for (const attrs of levels) {
    const el = document.createElement('div');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent?.appendChild(el);
    parent = el;
    innermost = el;
  }
  return innermost as HTMLElement;
}

describe('resolveWhipTargetAt', () => {
  it('finds a layer marked directly', () => {
    const el = chain({ 'data-whip-layer': 'node_7' });
    expect(resolveWhipTargetAt(0, 0, domAt(el))).toEqual({ nodeId: 'node_7' });
  });

  it('finds a layer through its descendants', () => {
    const el = chain({ 'data-whip-layer': 'node_7' }, { class: 'label' }, { class: 'text' });
    expect(resolveWhipTargetAt(0, 0, domAt(el))).toEqual({ nodeId: 'node_7' });
  });

  it('carries the property when the row names one', () => {
    const el = chain({ 'data-whip-layer': 'node_7' }, { 'data-whip-prop': 'y' });
    expect(resolveWhipTargetAt(0, 0, domAt(el))).toEqual({ nodeId: 'node_7', prop: 'y' });
  });

  it('takes the INNERMOST property, so a nested row wins over its group', () => {
    const el = chain(
      { 'data-whip-layer': 'node_7' },
      { 'data-whip-prop': 'position' },
      { 'data-whip-prop': 'y' },
    );
    expect(resolveWhipTargetAt(0, 0, domAt(el))?.prop).toBe('y');
  });

  it('reads a scoped tree row from its data-id', () => {
    // The scene tree's rows already carry `data-id`; marking the container is
    // the whole integration.
    const el = chain({ 'data-whip-scope': 'layer' }, { 'data-id': 'node_3' }, { class: 'row-label' });
    expect(resolveWhipTargetAt(0, 0, domAt(el))).toEqual({ nodeId: 'node_3' });
  });

  it('ignores data-id outside a whip scope, where it means something else', () => {
    // The asset panel uses the same TreeView, and its ids are asset ids.
    const el = chain({ class: 'assets' }, { 'data-id': 'asset_9' });
    expect(resolveWhipTargetAt(0, 0, domAt(el))).toBeNull();
  });

  it('prefers an explicit layer attribute over a scoped data-id', () => {
    const el = chain(
      { 'data-whip-scope': 'layer' },
      { 'data-id': 'row_outer' },
      { 'data-whip-layer': 'node_real' },
    );
    expect(resolveWhipTargetAt(0, 0, domAt(el))).toEqual({ nodeId: 'node_real' });
  });

  it('is null over empty space', () => {
    expect(resolveWhipTargetAt(0, 0, domAt(null))).toBeNull();
  });

  it('is null over an unmarked panel', () => {
    expect(resolveWhipTargetAt(0, 0, domAt(chain({ class: 'viewport' })))).toBeNull();
  });
});

describe('whipExpression', () => {
  it('reads another layer property by name', () => {
    expect(whipExpression('Hero', 'y')).toBe("layer('Hero', 'y')");
  });

  it('escapes a quote in a layer name rather than emitting broken syntax', () => {
    expect(whipExpression("Ada's title", 'x')).toBe("layer('Ada\\'s title', 'x')");
  });

  it('escapes a backslash', () => {
    expect(whipExpression('back\\slash', 'x')).toBe("layer('back\\\\slash', 'x')");
  });
});

describe('insertAtCaret', () => {
  it('splices at the caret and moves it past the insertion', () => {
    expect(insertAtCaret('ab', 1, 'XY')).toEqual({ text: 'aXYb', caret: 3 });
  });

  it('appends at the end', () => {
    expect(insertAtCaret('ab', 2, '!')).toEqual({ text: 'ab!', caret: 3 });
  });

  it('clamps a caret outside the text instead of producing undefined', () => {
    expect(insertAtCaret('ab', 99, '!')).toEqual({ text: 'ab!', caret: 3 });
    expect(insertAtCaret('ab', -5, '!')).toEqual({ text: '!ab', caret: 1 });
  });
});
