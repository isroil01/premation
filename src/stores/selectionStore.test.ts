import { makeKeyframeId } from '@motion/animation';
import { pruneKeyframeSelectionToNodes, useKeyframeSelectionStore } from './keyframeSelectionStore';
import { prunePropertySelectionToNodes, usePropertySelectionStore } from './propertySelectionStore';
import { useSelectionStore } from './selectionStore';

beforeEach(() => {
  useSelectionStore.setState({ ids: [], primary: null });
  usePropertySelectionStore.setState({ entries: [], proportional: true });
  useKeyframeSelectionStore.setState({ ids: new Set() });
});

it('keeps independent timeline selections when layer selection changes', () => {
  useSelectionStore.getState().set(['a', 'b']);
  usePropertySelectionStore.setState({
    entries: [
      { nodeId: 'a', prop: 'x' },
      { nodeId: 'b', prop: 'opacity' },
    ],
  });
  useKeyframeSelectionStore.getState().set(new Set([
    makeKeyframeId('a', 'x', 0),
    makeKeyframeId('b', 'opacity', 1),
  ]));

  useSelectionStore.getState().set(['b']);

  expect(usePropertySelectionStore.getState().entries).toHaveLength(2);
  expect(useKeyframeSelectionStore.getState().ids.size).toBe(2);
});

it('prunes sub-selections only when their nodes leave the scene', () => {
  useSelectionStore.getState().set(['a']);
  usePropertySelectionStore.getState().select({ nodeId: 'a', prop: 'x' });
  useKeyframeSelectionStore.getState().set(new Set([makeKeyframeId('a', 'x', 0)]));

  usePropertySelectionStore.getState().toggle({ nodeId: 'b', prop: 'opacity' });
  useKeyframeSelectionStore.getState().set(new Set([
    makeKeyframeId('a', 'x', 0),
    makeKeyframeId('b', 'opacity', 1),
  ]));

  const remaining = new Set(['b']);
  prunePropertySelectionToNodes(remaining);
  pruneKeyframeSelectionToNodes(remaining);

  expect(usePropertySelectionStore.getState().entries).toEqual([{ nodeId: 'b', prop: 'opacity' }]);
  expect([...useKeyframeSelectionStore.getState().ids]).toEqual([makeKeyframeId('b', 'opacity', 1)]);
});
