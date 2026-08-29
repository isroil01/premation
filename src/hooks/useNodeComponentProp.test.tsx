import { render, screen, act } from '@testing-library/react';
import SceneGraph from '@core/scene/SceneGraph';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { useNodeComponentProp } from './useNodeComponentProp';

function Wrapper({ sceneGraph, nodeId, compId, prop }: { sceneGraph: SceneGraph; nodeId: string; compId: string; prop: string }) {
  const [value, setValue] = useNodeComponentProp(sceneGraph, nodeId, compId, prop);
  return (
    <>
      <div data-testid="val">{String(value)}</div>
      <button onClick={() => setValue('optimistic')}>Set</button>
    </>
  );
}

test('useNodeComponentProp reflects updates', async () => {
  const sg = new SceneGraph();
  const node = {
    id: 'n1', name: 'Node 1', parent: null, children: [], transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, components: [{ id: 'c1', type: 'comp', props: { foo: 'bar' } }], visible: true, locked: false,
  } as any;
  sg.addNode(node);

  render(<Wrapper sceneGraph={sg} nodeId="n1" compId="c1" prop="foo" />);
  expect(screen.getByTestId('val').textContent).toBe('bar');

  act(() => {
    updateNodeComponentProp(sg as any, 'n1', 'c1', 'foo', 'baz');
  });

  expect(screen.getByTestId('val').textContent).toBe('baz');
});

test('does not show a value that the scene graph rejected', () => {
  const sg = new SceneGraph();
  sg.addNode({
    id: 'n1', name: 'Node 1', parent: null, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'c1', type: 'comp', props: { foo: 'bar' } }],
    visible: true, locked: false,
  } as any);

  render(<Wrapper sceneGraph={sg} nodeId="n1" compId="missing" prop="foo" />);
  act(() => screen.getByRole('button', { name: 'Set' }).click());

  expect(screen.getByTestId('val').textContent).toBe('undefined');
});
