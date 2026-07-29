/**
 * Label color (AE-style per-layer label) — storage round-trip.
 *
 * The color must survive: view-cache reads (getNode), scene-graph writes via
 * `node.color`, and full project serialization (sceneProjectIO capture →
 * restore), since that is what feeds the Scene rows and timeline colors.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { sceneProjectIO } from './sceneProjectIO';
import { LABEL_COLORS, getNodeLabelColor, readNodeLabelColor, setNodeLabelColor } from './labelColor';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import type { SceneNode } from '@core/types';

function makeNode(id: string): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_meta`, type: 'shape', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } }],
  };
}

function clearGraph(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  clearGraph();
});

describe('LABEL_COLORS palette', () => {
  it('is a fixed set of unique hex swatches', () => {
    expect(LABEL_COLORS.length).toBeGreaterThanOrEqual(12);
    const hexes = LABEL_COLORS.map((c) => c.color);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/i);
    const ids = LABEL_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('label color read/write through the scene graph', () => {
  it('defaults to undefined (kind category color)', () => {
    defaultSceneGraph.addNode(makeNode('a'));
    expect(getNodeLabelColor('a')).toBeUndefined();
    expect(readNodeLabelColor(defaultSceneGraph.getNode('a')!)).toBeUndefined();
  });

  it('round-trips a set color through fresh getNode reads', () => {
    defaultSceneGraph.addNode(makeNode('a'));
    setNodeLabelColor('a', '#d5493d');
    // Read through the same path the timeline uses: node.color on getNode.
    expect(defaultSceneGraph.getNode('a')!.color).toBe('#d5493d');
    expect(getNodeLabelColor('a')).toBe('#d5493d');
  });

  it('clears back to the default with undefined', () => {
    defaultSceneGraph.addNode(makeNode('a'));
    setNodeLabelColor('a', '#4a7fe0');
    setNodeLabelColor('a', undefined);
    expect(getNodeLabelColor('a')).toBeUndefined();
  });

  it('applies to multiple nodes at once (selection)', () => {
    defaultSceneGraph.addNode(makeNode('a'));
    defaultSceneGraph.addNode(makeNode('b'));
    setNodeLabelColor(['a', 'b'], '#e6c74c');
    expect(getNodeLabelColor('a')).toBe('#e6c74c');
    expect(getNodeLabelColor('b')).toBe('#e6c74c');
  });

  it('ignores unknown node ids without throwing', () => {
    expect(() => setNodeLabelColor('missing', '#9e9e9e')).not.toThrow();
    expect(getNodeLabelColor('missing')).toBeUndefined();
  });
});

describe('label color persistence (sceneProjectIO)', () => {
  it('capture serializes the color and restore rehydrates it', () => {
    defaultSceneGraph.addNode(makeNode('a'));
    defaultSceneGraph.addNode(makeNode('b'));
    setNodeLabelColor('a', '#8a63d2');

    const file = sceneProjectIO.capture();
    const a = file.nodes.find((n) => n.id === 'a')!;
    const b = file.nodes.find((n) => n.id === 'b')!;
    expect(a.color).toBe('#8a63d2');
    expect(b.color).toBeUndefined();
    // Survives JSON serialization (the on-disk project format).
    const reparsed = JSON.parse(JSON.stringify(file)) as typeof file;

    sceneProjectIO.restore(reparsed);
    expect(getNodeLabelColor('a')).toBe('#8a63d2');
    expect(getNodeLabelColor('b')).toBeUndefined();
  });
});
