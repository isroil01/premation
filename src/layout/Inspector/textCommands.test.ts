/**
 * Swap Fill and Stroke (Shift+X) — the shortcut the Character panel advertised
 * long before it existed.
 *
 * The swap is ONE engine batch (B3z), so the fixture is the app's engine: the
 * text layer is created through it, its colours are seeded with the same
 * command builder the panel uses, and the swap is pinned as one undo entry that
 * undo reverses exactly.
 */

import { act } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { componentPropsCommands } from './useComponentProp';
import {
  buildTextCommands,
  isTypingInField,
  selectedTextLayerIds,
  swapTextFillStroke,
  TEXT_SWAP_FILL_STROKE_COMMAND,
} from './textCommands';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let T = '';

const textComp = (id: string) => defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!;
const textProps = (id: string): Record<string, unknown> => textComp(id).props as Record<string, unknown>;

beforeEach(async () => {
  h = await setupAppEngine();
  T = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'sw1', init: [] })).layer;
  // Seed through the engine, with the builder the panel writes with.
  const { cmds, rest } = componentPropsCommands(T, textComp(T).id, { fill: '#ff0000', stroke: '#00ff00', noFill: true }, 0);
  expect(rest).toEqual({});
  await h.batch('seed', cmds);
  getCommandSystem().getHistory().clear();
  useSelectionStore.setState({ ids: [] });
});

afterEach(async () => {
  useSelectionStore.setState({ ids: [] });
  await h.dispose();
});

describe('text.swapFillStroke', () => {
  const command = buildTextCommands().find((c) => c.id === TEXT_SWAP_FILL_STROKE_COMMAND)!;

  it('is bound to Shift+X', () => {
    expect(command).toBeDefined();
    expect(command.shortcut).toEqual({ key: 'x', shift: true });
  });

  it('is enabled only with a text layer selected and nothing being typed into', () => {
    expect(command.enabled?.()).toBe(false);
    useSelectionStore.setState({ ids: [T] });
    expect(selectedTextLayerIds()).toEqual([T]);
    expect(command.enabled?.()).toBe(true);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      expect(isTypingInField()).toBe(true);
      expect(command.enabled?.()).toBe(false);
    } finally {
      input.remove();
    }
  });

  it('swaps the colours and the none swatches, and gives a strokeless layer a visible stroke — one undo entry', async () => {
    const before = h.doc();
    const seeded = textProps(T);
    expect(seeded.fill).toBe('#ff0000');
    expect(seeded.stroke).toBe('#00ff00');
    expect(seeded.noFill).toBe(true);
    expect(seeded.strokeWidth ?? 0).toBe(0);

    let swapped = false;
    await act(async () => {
      swapped = swapTextFillStroke([T]);
      await engineIdle();
    });
    expect(swapped).toBe(true);
    const p = textProps(T);
    expect(p.fill).toBe('#00ff00');
    expect(p.stroke).toBe('#ff0000');
    expect(p.noFill).toBe(false);
    expect(p.noStroke).toBe(true);
    expect(p.strokeWidth).toBe(2);
    // No second entry from the 700 ms recorder on top of the engine's.
    act(() => { jest.advanceTimersByTime(2000); });
    expect(historyLabels()).toEqual(['Swap Fill and Stroke']);

    await act(async () => { await h.run({ type: 'undo' }); });
    expect(h.doc()).toBe(before);
  });

  it('does nothing for non-text ids', () => {
    expect(swapTextFillStroke(['nope'])).toBe(false);
    expect(historyLabels()).toEqual([]);
  });
});
