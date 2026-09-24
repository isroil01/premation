/**
 * NodeInspector renders the registered editor for a component prop and writes
 * the edit back to the document — through the engine API (B3z): the fixture is
 * a layer created through the app's engine, the edit is ONE undo entry, and
 * undo restores the document exactly.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import NodeInspector from './NodeInspector';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { propertyRegistry } from './PropertyRegistry';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let T: string;

beforeEach(async () => {
  h = await setupAppEngine();
  ({ layer: T } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'Test', init: [] }));
  // A string field the engine addresses on the Text component (G1 `text/fontFamily`).
  await h.run({ type: 'setProperty', prop: { layer: T, path: 'text/fontFamily' }, value: { kind: 'string', value: 'bar' } });
  getCommandSystem().getHistory().clear();
});

afterEach(async () => {
  propertyRegistry.unregister('Text', 'fontFamily');
  cleanup();
  await h.dispose();
});

const textComponent = () => defaultSceneGraph.getNode(T)!.components.find((c) => c.type === 'Text')!;

describe('NodeInspector', () => {
  test('renders editor and updates scene graph on change', async () => {
    // Register a simple editor for Text::fontFamily
    propertyRegistry.register('Text', 'fontFamily', ({ value, onChange }) => (
      <input data-testid="inspector-input" value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value)} />
    ));

    render(<NodeInspector nodeId={T} />);

    const input = await screen.findByTestId('inspector-input');
    expect((input as HTMLInputElement).value).toBe('bar');

    const before = h.doc();
    // Change value
    await act(async () => {
      fireEvent.change(input, { target: { value: 'baz' } });
      await engineIdle();
    });

    // Verify scene graph updated — as ONE undo entry
    expect(textComponent().props.fontFamily).toBe('baz');
    // No second entry from the 700 ms recorder on top of the engine's.
    act(() => { jest.advanceTimersByTime(2000); });
    expect(historyLabels()).toHaveLength(1);

    await act(async () => { await h.run({ type: 'undo' }); });
    expect(textComponent().props.fontFamily).toBe('bar');
    expect(h.doc()).toBe(before);
  });
});
