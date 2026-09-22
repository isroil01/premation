import { SelectionController } from './SelectionController';
import type { NodeId, SceneGraphPort, SelectionPort, WorkspaceNode } from '../ports';

/**
 * The overlay asks for every selected node on every painted frame. A host whose
 * `getNode` has per-call setup paid it once per id — (selected × scene size) —
 * which froze playback with a few hundred layers selected.
 */
const wn = (id: string, x: number): WorkspaceNode => ({
  id: id as NodeId, zIndex: 0,
  worldBounds: { x, y: 0, width: 10, height: 10 },
} as unknown as WorkspaceNode);

function harness(ids: string[], withBatch: boolean) {
  const calls = { single: 0, batch: 0 };
  const nodes = new Map(ids.map((id, i) => [id as NodeId, wn(id, i * 20)]));
  const scene = {
    getNodes: () => nodes.values(),
    getNode: (id: NodeId) => { calls.single += 1; return nodes.get(id); },
    onChanged: () => () => {},
    ...(withBatch ? { getNodesById: (want: readonly NodeId[]) => { calls.batch += 1; return new Map(want.filter((i) => nodes.has(i)).map((i) => [i, nodes.get(i)!])); } } : {}),
  } as unknown as SceneGraphPort;
  const selection = { get: () => ids as NodeId[], set: () => {}, onChanged: () => () => {} } as unknown as SelectionPort;
  return { c: new SelectionController(scene, selection, {} as never), calls };
}

describe('SelectionController — batch node lookup', () => {
  const ids = Array.from({ length: 64 }, (_, i) => `n${i}`);

  it('resolves a multi-selection in one host call, not one per id', () => {
    const { c, calls } = harness(ids, true);
    expect(c.selectionBoxes()).toHaveLength(64);
    expect(c.selectionBounds()).toEqual({ x: 0, y: 0, width: 63 * 20 + 10, height: 10 });
    expect(calls).toEqual({ single: 0, batch: 2 });
  });

  it('gives the same geometry from a host with no batch call', () => {
    const a = harness(ids, true).c;
    const b = harness(ids, false).c;
    expect(b.selectionBoxes()).toEqual(a.selectionBoxes());
    expect(b.selectionBounds()).toEqual(a.selectionBounds());
  });
});
