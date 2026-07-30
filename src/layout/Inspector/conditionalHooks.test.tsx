/**
 * Inspector sections must not vary their hook count between renders.
 *
 * `AppearanceSection` and `TextSection` both did `if (!node) return null;`
 * BEFORE their `useMemo` / `useNodeComponentProp` / `useSelectionStore` calls.
 * React counts hooks per render, so the first pass (node present) ran the full
 * set and the next pass (node deleted, still selected) ran none — "Rendered
 * fewer hooks than expected", which unmounts the tree and takes the editor down.
 *
 * Deleting a selected layer with the inspector open is the ordinary way to hit
 * it, which is why this is a crash and not an edge case.
 *
 * The guards moved BELOW the hooks (`if (!node || !sComp) return null;`) and the
 * component reads `node?.components` so the hooks are safe with no node at all.
 */

import { render, cleanup } from '@testing-library/react';
import { AppearanceSection } from './AppearanceSection';
import { TextSection } from './TextSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const ID = 'hooks_probe_layer';

function textNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0, width: 200, height: 60, opacity: 100 } },
      { id: `${id}_txt`, type: 'Text', props: { content: 'Hi', fontSize: 48, fontFamily: 'Inter' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

afterEach(() => {
  cleanup();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe.each([
  ['AppearanceSection', AppearanceSection],
  ['TextSection', TextSection],
])('%s survives its node disappearing mid-session', (_name, Section) => {
  it('renders with the node present, then again after it is deleted', () => {
    defaultSceneGraph.addNode(textNode(ID));
    useSelectionStore.setState({ ids: [ID] } as never);

    const view = render(<Section nodeId={ID} />);
    // The node goes away while the panel is still mounted and still pointed at it
    // — exactly what deleting a selected layer does.
    defaultSceneGraph.removeNode(ID);

    // Before the fix this threw "Rendered fewer hooks than expected".
    expect(() => view.rerender(<Section nodeId={ID} />)).not.toThrow();
  });

  it('renders for a node id that never existed', () => {
    useSelectionStore.setState({ ids: [] } as never);
    expect(() => render(<Section nodeId="no_such_node" />)).not.toThrow();
  });

  it('mounting straight onto a missing node, then a real one, is stable', () => {
    // The reverse order: hook count must not change when the node APPEARS either.
    const view = render(<Section nodeId={ID} />);
    defaultSceneGraph.addNode(textNode(ID));
    expect(() => view.rerender(<Section nodeId={ID} />)).not.toThrow();
  });
});
