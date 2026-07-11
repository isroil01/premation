import { render, screen, fireEvent, act } from '@testing-library/react';
import NodeInspector from './NodeInspector';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { propertyRegistry } from '@core/inspector/PropertyRegistry';

describe('NodeInspector', () => {
  beforeEach(() => {
    // Clear scene graph nodes
    // Simple approach: recreate defaultSceneGraph nodes by removing known test ids
    try { defaultSceneGraph.removeNode('tn1'); } catch (e) { /* ignore */ }
  });

  afterEach(() => {
    propertyRegistry.unregister('comp', 'foo');
    try { defaultSceneGraph.removeNode('tn1'); } catch (e) { /* ignore */ }
  });

  test('renders editor and updates scene graph on change', async () => {
    // Add a test node with a component
    const node = {
      id: 'tn1', name: 'Test', parent: null, children: [], transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, components: [{ id: 'c1', type: 'comp', props: { foo: 'bar' } }], visible: true, locked: false,
    } as any;
    defaultSceneGraph.addNode(node);

    // Register a simple editor for comp::foo
    propertyRegistry.register('comp', 'foo', ({ value, onChange }) => (
      <input data-testid="inspector-input" value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value)} />
    ));

    render(<NodeInspector nodeId="tn1" />);

    const input = await screen.findByTestId('inspector-input');
    expect((input as HTMLInputElement).value).toBe('bar');

    // Change value
    await act(async () => {
      fireEvent.change(input, { target: { value: 'baz' } });
    });

    // Verify scene graph updated
    const updated = defaultSceneGraph.getNode('tn1')!.components[0]!.props.foo;
    expect(updated).toBe('baz');
  });
});
