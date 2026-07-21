/**
 * Rotate + Pan Behind — AE's W and Y tools.
 *
 * Both pivot on the anchor, so these tests pin the two things that make that
 * work: the anchor's world position comes from `worldMatrix · anchor` (not the
 * bounds centre), and pan-behind reports the dragged point in LOCAL space.
 */

import { RotateTool, PanBehindTool } from './builtin';
import {
  WorkspaceCommandType,
  type RotateNodePayload,
  type MoveAnchorPayload,
} from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent, ToolPointerEvent } from './Tool';
import { NO_MODIFIERS } from '../input/events';
import * as Mat from '../math/Mat2D';
import type { Vec2 } from '../math/Vec2';

interface FakeNode {
  id: string;
  worldMatrix: Mat.Mat2D;
  anchor?: Vec2;
}

/**
 * `position` is where the layer sits; `anchor` is its pivot in local space.
 * The matrix mirrors the renderer's model — T(position)·R·S·T(−anchor) — which
 * is what the host binding builds.
 */
function makeNode(
  id: string,
  position: Vec2,
  anchor: Vec2 = { x: 0, y: 0 },
  rotationRad = 0,
  scale: Vec2 = { x: 1, y: 1 },
): FakeNode {
  const tr = Mat.multiply(Mat.translation(position.x, position.y), Mat.rotation(rotationRad));
  const rs = Mat.multiply(tr, Mat.scaling(scale.x, scale.y));
  return { id, worldMatrix: Mat.multiply(rs, Mat.translation(-anchor.x, -anchor.y)), anchor };
}

function makeCtx(nodes: FakeNode[], selection: string[]) {
  const rotates: RotateNodePayload[] = [];
  const anchors: MoveAnchorPayload[] = [];
  const selected = [...selection];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => selected,
    scene: { getNode: (id: string) => nodes.find((n) => n.id === id) },
    selection: {
      get: () => selected,
      select: (id: string) => { selected.splice(0, selected.length, id); },
      clickAt: () => {},
      selectionBounds: () => null,
    },
    camera: { screenDistanceToWorld: (px: number) => px },
    hitTester: { hitTest: () => nodes[0] },
    execute: (cmd: { type: string; payload: unknown }) => {
      if (cmd.type === WorkspaceCommandType.RotateNode) rotates.push(cmd.payload as RotateNodePayload);
      if (cmd.type === WorkspaceCommandType.MoveAnchor) anchors.push(cmd.payload as MoveAnchorPayload);
    },
  } as unknown as ToolContext;
  return { ctx, rotates, anchors };
}

const drag = (sx: number, sy: number, cx: number, cy: number): ToolDragEvent => ({
  startScreen: { x: sx, y: sy }, currentScreen: { x: cx, y: cy },
  startWorld: { x: sx, y: sy }, currentWorld: { x: cx, y: cy },
  deltaScreen: { x: 0, y: 0 }, totalScreen: { x: cx - sx, y: cy - sy },
  deltaWorld: { x: 0, y: 0 }, totalWorld: { x: cx - sx, y: cy - sy },
  modifiers: NO_MODIFIERS, pointer: {} as ToolDragEvent['pointer'],
});

const point = (x: number, y: number): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: NO_MODIFIERS, pointer: {} as ToolPointerEvent['pointer'],
});

describe('RotateTool', () => {
  it('rotates about the anchor, not the bounds centre', () => {
    // Anchor offset 50px left of centre → its world position is the layer's
    // position (100,100). Dragging from +x to +y is a quarter turn about it.
    const node = makeNode('n1', { x: 100, y: 100 }, { x: -50, y: 0 });
    const { ctx, rotates } = makeCtx([node], ['n1']);
    const t = new RotateTool();
    t.onDragStart(drag(200, 100, 200, 100), ctx);
    t.onDrag(drag(200, 100, 100, 200), ctx);

    expect(rotates).toHaveLength(1);
    expect(rotates[0]!.pivot).toEqual({ x: 100, y: 100 });
    expect(rotates[0]!.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it('carries the existing rotation so a drag is relative, not absolute', () => {
    const node = makeNode('n1', { x: 0, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    const { ctx, rotates } = makeCtx([node], ['n1']);
    const t = new RotateTool();
    t.onDragStart(drag(100, 0, 100, 0), ctx);
    t.onDrag(drag(100, 0, 0, 100), ctx); // a further quarter turn
    expect(rotates[0]!.rotation).toBeCloseTo(Math.PI, 6);
  });

  it('ignores a multi-node selection (rotation is a single-node edit)', () => {
    const nodes = [makeNode('n1', { x: 0, y: 0 }), makeNode('n2', { x: 10, y: 10 })];
    const { ctx, rotates } = makeCtx(nodes, ['n1', 'n2']);
    const t = new RotateTool();
    t.onDragStart(drag(0, 0, 0, 0), ctx);
    t.onDrag(drag(0, 0, 50, 50), ctx);
    expect(rotates).toHaveLength(0);
  });
});

describe('PanBehindTool', () => {
  it('reports the dragged point in local space', () => {
    const node = makeNode('n1', { x: 100, y: 100 });
    const { ctx, anchors } = makeCtx([node], ['n1']);
    const t = new PanBehindTool();
    t.onPointerDown(point(100, 100), ctx);
    t.onDrag(drag(100, 100, 130, 120), ctx);

    // Layer sits at (100,100), so world (130,120) is local (30,20).
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.anchor.x).toBeCloseTo(30, 6);
    expect(anchors[0]!.anchor.y).toBeCloseTo(20, 6);
  });

  it('undoes rotation and scale when converting the drag to local space', () => {
    // Quarter-turned and doubled: world +x is local +y, halved by the scale.
    const node = makeNode('n1', { x: 0, y: 0 }, { x: 0, y: 0 }, Math.PI / 2, { x: 2, y: 2 });
    const { ctx, anchors } = makeCtx([node], ['n1']);
    const t = new PanBehindTool();
    t.onPointerDown(point(0, 0), ctx);
    t.onDrag(drag(0, 0, 100, 0), ctx);

    expect(anchors[0]!.anchor.x).toBeCloseTo(0, 6);
    expect(anchors[0]!.anchor.y).toBeCloseTo(-50, 6);
  });

  it('draws the anchor marker at the pivot, offset from the layer origin', () => {
    const node = makeNode('n1', { x: 100, y: 100 }, { x: 25, y: 0 });
    const { ctx } = makeCtx([node], ['n1']);
    const handles = new PanBehindTool().getHandles(ctx);
    expect(handles).toHaveLength(1);
    expect(handles[0]!.kind).toBe('anchor');
    // The anchor's world position is the layer's position, by construction.
    expect(handles[0]!.position.x).toBeCloseTo(100, 6);
    expect(handles[0]!.position.y).toBeCloseTo(100, 6);
  });
});
