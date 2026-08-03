/**
 * The selection overlay's box and the renderer's quad are ONE rectangle.
 *
 * They are computed twice, from two different modules, and nothing in the type
 * system makes them agree:
 *
 *   overlay   core/workspace/ports.ts   T(x,y)·R·S·T(−anchor) applied to the
 *                                       node's local bounds → `worldCorners`,
 *                                       which SelectionController draws.
 *   renderer  core/rendering/snapshot-  the unit-quad model matrix the GPU
 *             ToFrameScene.ts           actually draws the layer with.
 *
 * They disagreed on the ANCHOR, and only on the anchor, which is why it went
 * unnoticed: every default layer has anchor (0,0), where the two expressions are
 * identical. `buildSnapshot` threaded `anchorX`/`anchorY` onto the RenderLayer
 * and `RenderBackend` documented them as a draw-time content shift, but no
 * matrix in snapshotToFrameScene read them — the field was write-only. So the
 * overlay applied the anchor, the renderer applied nothing, and the box sat
 * exactly `−R·S·anchor` away from the artwork. Measured on a real layer before
 * the fix: anchor (300, 400) put the box's centre at (660, 140) while the shape
 * drew at (960, 540).
 *
 * Every case below therefore uses a NON-ZERO anchor — the untested value — and
 * sweeps it against rotation, scale and parenting, which is where a pivot that
 * is applied in the wrong place stops being a pure translation and starts
 * swinging the box around a different point than the layer.
 *
 * The invariant, stated once: whatever the anchor does, the selection box
 * encloses the visible object.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene, SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { activeCompRootId } from '@core/scene/activeComp';
import { defaultAnimation } from '@motion/animation';
import { createSceneGraphPort } from './ports';
import { rasterPadding } from '@core/rendering/raster/vectorDraw';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { layerToRenderable } from '@core/rendering/snapshotToFrameScene';
import type { SceneNode } from '@core/types';

/** Same composition the workspace port resolves against, so both sides walk the
 *  identical subtree — a snapshot rooted elsewhere would compare nothing. */
const comp = (): { width: number; height: number; background: string; rootId: string } => ({
  width: 1920, height: 1080, background: '#000', rootId: activeCompRootId(),
});

type Pt = { x: number; y: number };

interface Transform {
  x?: number; y?: number;
  rotation?: number;
  scaleX?: number; scaleY?: number;
  anchorX?: number; anchorY?: number;
}

let seq = 0;

/** A plain unstroked 200×100 rect, so the raster quad carries no padding and
 *  the two rectangles are directly comparable. */
function addShape(t: Transform, parent?: string): string {
  const id = `parity_${seq++}`;
  // The workspace port only emits layers inside the ACTIVE composition, so a
  // root-parented node would be invisible to the overlay and the test vacuous.
  parent = parent ?? activeCompRootId();
  const node: SceneNode = {
    id,
    name: id,
    parent,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: t.x ?? 0, y: t.y ?? 0 }, rotation: t.rotation ?? 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0,
          width: 200, height: 100, shapeType: 'rect',
          ...t,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { fill: '#2b7eff', opacity: 100 } },
    ],
  } as unknown as SceneNode;
  // addChild, not addNode + setParent: only addChild links the parent's child
  // list, and buildSnapshot walks the tree downward from the comp root.
  defaultSceneGraph.addChild(parent, node);
  return id;
}

/** The four corners the SELECTION OVERLAY draws, in world space. */
function overlayCorners(id: string): Pt[] {
  const n = createSceneGraphPort().getNode(id as never);
  if (!n) throw new Error(`node ${id} is not visible to the workspace port`);
  return (n.worldCorners ?? []).map((c) => ({ x: c.x, y: c.y }));
}

/** The four corners the RENDERER draws, in world space — the unit quad pushed
 *  through the model matrix that reaches the GPU. */
function renderCorners(id: string): Pt[] {
  const snapshot = buildSnapshot(
    defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, comp(),
  );
  const layer = snapshot.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`node ${id} produced no render layer`);
  // A padded quad (stroked shapes) is legitimately larger than the selection
  // box; these fixtures must not be padded or the comparison is not like-for-like.
  expect(rasterPadding(layer)).toBe(0);
  const m = layerToRenderable(layer).modelMatrix;
  const at = (x: number, y: number): Pt => ({
    x: m[0]! * x + m[3]! * y + m[6]!,
    y: m[1]! * x + m[4]! * y + m[7]!,
  });
  // Same winding as Rect.corners / OBox.transformCorners: TL, TR, BR, BL.
  return [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
}

function expectParity(id: string): void {
  const overlay = overlayCorners(id);
  const render = renderCorners(id);
  expect(overlay).toHaveLength(4);
  expect(render).toHaveLength(4);
  for (let i = 0; i < 4; i++) {
    expect(overlay[i]!.x).toBeCloseTo(render[i]!.x, 3);
    expect(overlay[i]!.y).toBeCloseTo(render[i]!.y, 3);
  }
}

beforeAll(() => {
  seedDefaultScene();
});

describe('selection overlay ⇄ renderer bounds parity', () => {
  it('agree with no anchor — the case that always passed, kept as the control', () => {
    expectParity(addShape({ x: 400, y: 300 }));
  });

  it('agree with a non-zero anchor (the reported failure)', () => {
    expectParity(addShape({ x: 960, y: 540, anchorX: 300, anchorY: 400 }));
  });

  it('a non-zero anchor MOVES the layer, by −anchor — AE numeric-anchor semantics', () => {
    // Not merely "the two agree": pin WHICH way they agree, so a future change
    // cannot make them agree by both ignoring the anchor again.
    const id = addShape({ x: 960, y: 540, anchorX: 100, anchorY: 0 });
    const c = renderCorners(id);
    const centre = { x: (c[0]!.x + c[2]!.x) / 2, y: (c[0]!.y + c[2]!.y) / 2 };
    expect(centre.x).toBeCloseTo(860, 3);
    expect(centre.y).toBeCloseTo(540, 3);
  });

  it('agree with an anchor + rotation — the box must swing around the SAME pivot', () => {
    expectParity(addShape({ x: 960, y: 540, anchorX: 100, anchorY: -60, rotation: 37 }));
  });

  it('the anchor IS the rotation pivot: the anchor point holds still as it spins', () => {
    // The layer-local anchor maps to Position at every rotation, by definition of
    // `content_world = position + R·S·(local − anchor)`.
    const still = addShape({ x: 600, y: 400, anchorX: 100, anchorY: -60, rotation: 0 });
    const spun = addShape({ x: 600, y: 400, anchorX: 100, anchorY: -60, rotation: 90 });
    // Anchor in unit-quad coords: local (ax, ay) with the box spanning ±(w/2,h/2).
    const anchorUnit = { x: 0.5 + 100 / 200, y: 0.5 + -60 / 100 };
    for (const id of [still, spun]) {
      const snapshot = buildSnapshot(
        defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, comp(),
      );
      const m = layerToRenderable(snapshot.layers.find((l) => l.id === id)!).modelMatrix;
      const p = {
        x: m[0]! * anchorUnit.x + m[3]! * anchorUnit.y + m[6]!,
        y: m[1]! * anchorUnit.x + m[4]! * anchorUnit.y + m[7]!,
      };
      expect(p.x).toBeCloseTo(600, 3);
      expect(p.y).toBeCloseTo(400, 3);
    }
  });

  it('agree with an anchor + non-uniform scale', () => {
    expectParity(addShape({ x: 700, y: 500, anchorX: 80, anchorY: 45, scaleX: 2.5, scaleY: 0.6 }));
  });

  it('agree with an anchor + rotation + scale together', () => {
    expectParity(addShape({ x: 820, y: 610, anchorX: -70, anchorY: 90, rotation: -24, scaleX: 1.8, scaleY: 1.3 }));
  });

  it('agree for a PARENTED layer whose parent also carries an anchor', () => {
    const parent = addShape({ x: 500, y: 400, anchorX: 60, anchorY: -40, rotation: 15, scaleX: 1.4, scaleY: 1.4 });
    const child = addShape({ x: 120, y: 80, anchorX: -35, anchorY: 55, rotation: -20 }, parent);
    expectParity(parent);
    expectParity(child);
  });

  it('agree when the anchor is ANIMATED, not just stored', () => {
    // The overlay reads animated values (`av.get('anchorX')`) and so does
    // buildSnapshot; a keyframed anchor must not reopen the gap.
    const id = addShape({ x: 640, y: 480, anchorX: 0, anchorY: 0 });
    defaultAnimation.setKeyframe(id, 'anchorX', 0, 250);
    defaultAnimation.setKeyframe(id, 'anchorY', 0, -175);
    try {
      expectParity(id);
      const c = renderCorners(id);
      // Sampled, not stored: the stored anchor is (0,0), so an implementation
      // that read the static prop would land the centre back on Position.
      expect((c[0]!.x + c[2]!.x) / 2).toBeCloseTo(640 - 250, 3);
    } finally {
      defaultAnimation.removeTrack(id, 'anchorX');
      defaultAnimation.removeTrack(id, 'anchorY');
    }
  });
});
