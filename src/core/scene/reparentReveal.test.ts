/**
 * Issue #14 — "Missing Layer after parent to null".
 *
 * Create a rectangle and a Null, parent the rectangle to the Null, and the
 * rectangle disappears from the Scene panel.
 *
 * It was never gone: the canvas kept drawing it, the timeline kept its row, and
 * its world transform was correctly compensated so it did not even move. What
 * vanished was its ROW, and that is enough to read as a lost layer — there is
 * no other list of what a composition contains.
 *
 * `parent` IS the tree in this graph, so parenting MOVES the layer into the
 * parent's branch. The Scene panel expands composition roots and nothing else
 * (deliberately — one imported SVG is a group of dozens of paths, and unfolding
 * it buries the scene). A Null has no children until the moment you parent
 * something to it, so it is never in the expanded set, and the branch the layer
 * just moved into renders shut.
 *
 * The fix is an event every reparent route emits, so the panel can open the
 * destination. These tests pin the event and its payload — the panel wiring
 * that consumes it lives in `DemoPanels`, and `TreeView.revealIds` merges it
 * into the expansion set without overriding what the user has closed since.
 */

import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertNull, reparentNode } from '@core/scene/parenting';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { createCommandPort, createSceneGraphPort } from '@core/workspace/ports';
import { commands } from '@motion/workspace';

/** A rectangle drawn the way the Rectangle tool (Q) draws one. */
function newRect(): string {
  createCommandPort().execute(
    commands.createNode('shape' as never, { x: 700, y: 300, width: 400, height: 250 }),
  );
  const id = useSelectionStore.getState().ids.slice(-1)[0];
  if (!id) throw new Error('createNode selected nothing');
  return id;
}

function newNull(): string {
  insertNull();
  const id = useSelectionStore.getState().ids.slice(-1)[0];
  if (!id) throw new Error('insertNull selected nothing');
  return id;
}

function worldBounds(id: string): { x: number; y: number; width: number; height: number } | null {
  const found = [...createSceneGraphPort().getNodes()].find(
    (n) => (n as unknown as { id: string }).id === id,
  );
  return found ? (found as unknown as { worldBounds: never }).worldBounds : null;
}

beforeAll(() => {
  seedDefaultScene();
});

describe('parenting a layer to a Null', () => {
  it('announces the move so a collapsed destination can be opened', () => {
    const rect = newRect();
    const nul = newNull();
    const seen: Array<{ nodeId: string; parentId: string }> = [];
    const sub = getEventBus().on('LayerReparented', (p) => { seen.push(p); });

    try {
      expect(reparentNode(rect, nul)).toBe(true);
    } finally {
      sub.dispose();
    }

    // Without this the Scene panel has no idea a branch needs opening, and the
    // layer is simply not drawn in the list.
    expect(seen).toEqual([{ nodeId: rect, parentId: nul }]);
  });

  it('announces un-parenting too, back to the layer’s own comp root', () => {
    const rect = newRect();
    const nul = newNull();
    reparentNode(rect, nul);

    const seen: Array<{ nodeId: string; parentId: string }> = [];
    const sub = getEventBus().on('LayerReparented', (p) => { seen.push(p); });
    try {
      reparentNode(rect, null);
    } finally {
      sub.dispose();
    }

    // "None" resolves to a real node id, never a bare null — the panel has to
    // be able to walk up from it.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.nodeId).toBe(rect);
    expect(seen[0]?.parentId).toBe(defaultSceneGraph.getNode(rect as never)?.parent);
  });

  it('says nothing when the move is refused, so no branch opens for a no-op', () => {
    const rect = newRect();
    const seen: unknown[] = [];
    const sub = getEventBus().on('LayerReparented', (p) => { seen.push(p); });
    try {
      // A layer cannot be its own parent.
      expect(reparentNode(rect, rect)).toBe(false);
    } finally {
      sub.dispose();
    }
    expect(seen).toEqual([]);
  });

  it('still leaves the layer exactly where it was on canvas', () => {
    const rect = newRect();
    const nul = newNull();
    const before = worldBounds(rect);

    reparentNode(rect, nul);

    // The half that was never broken, pinned so a reveal fix cannot regress it:
    // parenting compensates the local transform and the layer does not move.
    expect(worldBounds(rect)).toEqual(before);
    expect(defaultSceneGraph.getNode(rect as never)?.parent).toBe(nul);
    expect(defaultSceneGraph.getNode(rect as never)?.visible).not.toBe(false);
  });
});
