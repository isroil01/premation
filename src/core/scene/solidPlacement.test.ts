/**
 * A new Solid must fill its composition.
 *
 * `insertSolid` seeded `anchorX/anchorY` with HALF THE LAYER (w/2, h/2), which
 * is how After Effects numbers an anchor — layer space with its origin at the
 * top-left corner. This app stores the anchor as an OFFSET FROM THE LAYER
 * CENTRE instead: `anchor.ts` says so ("0,0 = centre"), `buildSnapshot` treats
 * 0 as the neutral value, and every other insert in `sceneInsert` writes 0.
 *
 * So the solid was displaced by exactly half its own size in each axis. Its
 * world matrix came out as the IDENTITY — the position (960,540) cancelled
 * against the anchor (960,540) — parking a comp-sized solid with its CENTRE on
 * the composition's top-left corner. Three quarters of it hung outside the
 * frame and the quarter that showed looked like a solid at a quarter size.
 *
 * It also poisoned every gesture downstream, because the selection box, the
 * handles and the resize pivot are all derived from that same matrix: handles
 * sat far from the pixels they belonged to, and a corner drag scaled about a
 * pivot outside the layer.
 */

import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertSolid } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { createSceneGraphPort } from '@core/workspace/ports';

interface Boxed {
  id: string;
  worldBounds: { x: number; y: number; width: number; height: number };
  worldMatrix: { a: number; b: number; c: number; d: number; e: number; f: number };
}

function newSolid(): string {
  insertSolid();
  const id = useSelectionStore.getState().ids.slice(-1)[0];
  if (!id) throw new Error('insertSolid selected nothing');
  return id;
}

function workspaceNode(id: string): Boxed {
  const found = [...createSceneGraphPort().getNodes()].find(
    (n) => (n as unknown as Boxed).id === id,
  );
  if (!found) throw new Error(`node ${id} never reached the workspace port`);
  return found as unknown as Boxed;
}

beforeAll(() => {
  seedDefaultScene();
});

describe('a freshly inserted Solid', () => {
  it('covers the composition exactly, rather than hanging off its corner', () => {
    const { width, height } = useCompositionStore.getState();
    const box = workspaceNode(newSolid()).worldBounds;

    expect(box.width).toBeCloseTo(width, 5);
    expect(box.height).toBeCloseTo(height, 5);
    // The failing half: x/y were −width/2, −height/2.
    expect(box.x).toBeCloseTo(0, 5);
    expect(box.y).toBeCloseTo(0, 5);
  });

  it('places its centre at the comp centre, not at the comp origin', () => {
    const { width, height } = useCompositionStore.getState();
    const m = workspaceNode(newSolid()).worldMatrix;

    // The translation IS the layer centre. It used to come out as (0,0) — an
    // identity matrix — because position and anchor cancelled.
    expect(m.e).toBeCloseTo(width / 2, 5);
    expect(m.f).toBeCloseTo(height / 2, 5);
  });

  it('stores a centred anchor the way every other layer kind does', () => {
    const node = defaultSceneGraph.getNode(newSolid() as never);
    const t = node?.components.find((c) => c.type === 'Transform');
    const props = t?.props as Record<string, unknown>;

    // 0 is "centre" in this model — not w/2, which is After Effects' numbering.
    expect(props.anchorX).toBe(0);
    expect(props.anchorY).toBe(0);
  });
});
