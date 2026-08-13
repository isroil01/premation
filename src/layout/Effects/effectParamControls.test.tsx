/**
 * The controls AE draws in Effect Controls, and that we could not draw.
 *
 * Two of the three gaps found by comparing our panel against a screenshot of
 * AE's own Effect Controls:
 *
 *   1. No named-choice control. `EffectParamDef.type` had no `'enum'`, so
 *      "Echo Operator: Add" was not expressible — and our Echo shipped with
 *      FOUR parameters where AE's has five. The missing one was Echo Operator.
 *   2. No parameter groups. The list was flat, so Colorama's five collapsible
 *      sections (Input Phase, Output Cycle, Modify, Pixel Selection, Masking)
 *      could not exist; every grouped effect drew as one undivided column.
 *
 * These assert what a user can SEE and OPERATE, not that a field exists on a
 * def — a param model can be perfectly typed and still render nothing, which is
 * the failure this panel has had before (see pluginEffectStack.test.tsx).
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { EffectStack } from './EffectStack';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { addEffect, getNodeEffects, effectDefFor } from '@core/effects/effects';

const NODE = 'paramctl_node';

beforeEach(() => {
  try { defaultSceneGraph.removeNode(NODE); } catch { /* first run */ }
  defaultSceneGraph.addNode({
    id: NODE,
    name: 'Layer',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [],
    visible: true,
    locked: false,
  } as never);
});

afterEach(() => {
  cleanup();
  try { defaultSceneGraph.removeNode(NODE); } catch { /* already gone */ }
});

describe('Echo Operator — the enum control', () => {
  test('Echo carries the operator AE shows, so the def is not four params where AE has five', () => {
    const params = effectDefFor('echo')!.params.map((p) => p.key);
    expect(params).toContain('echoOperator');
  });

  test('renders as a menu of the named modes, not a number field', () => {
    addEffect(NODE, 'echo');
    render(<EffectStack nodeId={NODE} />);

    const menu = screen.getByLabelText('Echo Echo Operator') as HTMLSelectElement;
    expect(menu.tagName).toBe('SELECT');
    expect([...menu.options].map((o) => o.textContent)).toEqual([
      'Add', 'Maximum', 'Minimum', 'Screen', 'Composite In Back', 'Composite In Front',
    ]);
  });

  test('opens on AE’s default (Add) and writes the chosen mode back as a NUMBER', () => {
    addEffect(NODE, 'echo');
    render(<EffectStack nodeId={NODE} />);

    const menu = screen.getByLabelText('Echo Echo Operator') as HTMLSelectElement;
    expect(menu.value).toBe('0');

    fireEvent.change(menu, { target: { value: '3' } });

    // Stored numeric, like every other param — that is what lets it read
    // through effectNumber and pack into a uniform unchanged.
    const stored = getNodeEffects(NODE).find((e) => e.type === 'echo')?.params?.echoOperator;
    expect(stored).toBe(3);
    expect(typeof stored).toBe('number');
  });

  test('an enum has no stopwatch — interpolating between named modes is meaningless', () => {
    addEffect(NODE, 'echo');
    render(<EffectStack nodeId={NODE} />);

    // Numeric neighbours keep theirs, so this is about the enum specifically
    // and not about the whole effect having lost its stopwatches. (A numeric
    // param carries both a field and a slider under one label, hence getAll.)
    expect(screen.queryByLabelText(/Animate Echo Echo Operator/i)).toBeNull();
    expect(screen.getAllByLabelText('Echo Number of Echoes').length).toBeGreaterThan(0);
  });
});

describe('parameter groups — Colorama’s collapsible sections', () => {
  test('the param that was labelled with its GROUP’s name now has its own', () => {
    // `palette` read "Output Cycle", which in AE names the section the param
    // sits inside — so a single slider wore a group's title.
    const labels = effectDefFor('colorama')!.params.map((p) => p.label);
    expect(labels).toContain('Use Preset Palette');
    expect(labels).not.toContain('Output Cycle');
  });

  test('a grouped param is hidden until its section is opened', () => {
    addEffect(NODE, 'colorama');
    render(<EffectStack nodeId={NODE} />);

    // Collapsed by default: an effect has groups precisely because it has too
    // many controls to show at once.
    expect(screen.getByRole('button', { name: /Output Cycle/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Use Preset Palette')).toBeNull();
    // The ungrouped one is visible without opening anything.
    expect(screen.getByText('Blend With Original')).toBeInTheDocument();
  });

  test('opening a section reveals exactly its own params', () => {
    addEffect(NODE, 'colorama');
    render(<EffectStack nodeId={NODE} />);

    fireEvent.click(screen.getByRole('button', { name: /Output Cycle/ }));

    expect(screen.getByText('Use Preset Palette')).toBeInTheDocument();
    expect(screen.getByText('Cycle Repetitions')).toBeInTheDocument();
    // The OTHER section stayed shut — one twisty opens one section.
    expect(screen.queryByText('Phase Shift')).toBeNull();
  });

  test('an ungrouped effect draws no section chrome at all', () => {
    // Guards against every effect suddenly growing a twisty: almost every def
    // has no groups and must look exactly as it did.
    addEffect(NODE, 'echo');
    render(<EffectStack nodeId={NODE} />);
    expect(screen.queryByRole('button', { name: /Output Cycle/ })).toBeNull();
  });
});
