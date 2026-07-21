/**
 * Direct Selection over geometry AND mask outlines.
 *
 * Two bugs this pins down:
 *  1. Masks were invisible to the tool — it only ever read `node.pathPoints` —
 *     so a mask's shape was frozen the moment it was drawn, and mask path
 *     animation (which morphs exactly these points) could never be authored.
 *  2. Handle ids encoded the node id and were parsed back with `split('_')`,
 *     so ANY id containing an underscore ("comp_root", "tab_a1") resolved to
 *     the wrong node. The tool now keeps a handle→ref map instead.
 */

import { DirectSelectionTool } from '../tools/builtin';
import { commands, WorkspaceCommandType } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolPointerEvent, ToolDragEvent } from '../tools/Tool';
import type { WorkspaceCommand, WorkspaceNode } from '../ports';
import { corner } from '../math/BezierPoint';

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A square outline centred on the origin. */
const square = (h: number) => [corner(-h, -h), corner(h, -h), corner(h, h), corner(-h, h)];

function node(over: Partial<WorkspaceNode> = {}): WorkspaceNode {
  return {
    id: 'comp_root_layer' as WorkspaceNode['id'], // underscores on purpose
    parentId: null,
    worldBounds: { x: -50, y: -50, width: 100, height: 100 },
    worldMatrix: IDENTITY,
    localBounds: { x: -50, y: -50, width: 100, height: 100 },
    visible: true,
    locked: false,
    zIndex: 0,
    ...over,
  } as WorkspaceNode;
}

function makeCtx(n: WorkspaceNode): { ctx: ToolContext; executed: WorkspaceCommand[] } {
  const executed: WorkspaceCommand[] = [];
  const ctx = {
    camera: { screenDistanceToWorld: (px: number) => px },
    scene: { getNode: (id: string) => (id === n.id ? n : undefined), getNodes: () => [n], onChanged: () => () => {} },
    selection: { clickAt: () => {} },
    selectionIds: () => [n.id],
    execute: (c: WorkspaceCommand) => executed.push(c),
    requestRender: () => {},
  } as unknown as ToolContext;
  return { ctx, executed };
}

const down = (x: number, y: number, mods: Partial<{ alt: boolean; shift: boolean }> = {}): ToolPointerEvent =>
  ({ world: { x, y }, modifiers: { alt: false, shift: false, ctrl: false, meta: false, mod: false, ...mods } }) as unknown as ToolPointerEvent;

const drag = (x: number, y: number, mods: Partial<{ alt: boolean }> = {}): ToolDragEvent =>
  ({ currentWorld: { x, y }, modifiers: { alt: false, shift: false, ctrl: false, meta: false, mod: false, ...mods } }) as unknown as ToolDragEvent;

describe('DirectSelectionTool — geometry', () => {
  it('moves a vertex on a node whose id contains underscores', () => {
    const n = node({ pathPoints: square(40) });
    const { ctx, executed } = makeCtx(n);
    const tool = new DirectSelectionTool();

    tool.onPointerDown(down(-40, -40), ctx);
    tool.onDrag(drag(-10, -20), ctx);

    // The regression: `split('_')` on "comp_root_layer" yielded node "root".
    expect(executed).toHaveLength(1);
    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateNodePath);
    const p = (executed[0]!.payload as { id: string; points: ReturnType<typeof square> });
    expect(p.id).toBe('comp_root_layer');
    expect(p.points[0]).toMatchObject({ x: -10, y: -20 });
  });
});

describe('DirectSelectionTool — masks', () => {
  const masked = () =>
    node({ maskPaths: [{ id: 'mask_1', points: square(30) }] });

  it('exposes handles for a mask outline', () => {
    const { ctx } = makeCtx(masked());
    // Was zero: the tool bailed on `if (!node?.pathPoints) continue`.
    expect(new DirectSelectionTool().getHandles(ctx).length).toBe(4);
  });

  it('reshapes the mask, not the layer geometry', () => {
    const { ctx, executed } = makeCtx(masked());
    const tool = new DirectSelectionTool();

    tool.onPointerDown(down(-30, -30), ctx);
    tool.onDrag(drag(-5, -5), ctx);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateMaskPath);
    const p = executed[0]!.payload as { id: string; maskId: string; points: ReturnType<typeof square> };
    expect(p).toMatchObject({ id: 'comp_root_layer', maskId: 'mask_1' });
    expect(p.points[0]).toMatchObject({ x: -5, y: -5 });
    // The other vertices are untouched.
    expect(p.points[1]).toMatchObject({ x: 30, y: -30 });
  });

  it('drags a vertex handle-and-all so tangents follow', () => {
    const pts = square(30).map((p) => ({ ...p, inX: p.x - 5, outX: p.x + 5 }));
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: pts }] }));
    const tool = new DirectSelectionTool();

    tool.onPointerDown(down(-30, -30), ctx);
    tool.onDrag(drag(-20, -30), ctx);

    const p = executed[0]!.payload as { points: typeof pts };
    expect(p.points[0]!.x).toBe(-20);
    expect(p.points[0]!.inX).toBe(-25); // moved with the point
    expect(p.points[0]!.outX).toBe(-15);
  });

  it('deletes a mask vertex with Alt+click', () => {
    const { ctx, executed } = makeCtx(masked());
    new DirectSelectionTool().onPointerDown(down(-30, -30, { alt: true }), ctx);

    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateMaskPath);
    expect((executed[0]!.payload as { points: unknown[] }).points).toHaveLength(3);
  });

  it('refuses to delete below a drawable outline', () => {
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: [corner(0, 0), corner(10, 10)] }] }));
    new DirectSelectionTool().onPointerDown(down(0, 0, { alt: true }), ctx);
    expect(executed).toHaveLength(0);
  });

  it('handles geometry and masks on the same layer without confusing them', () => {
    const { ctx, executed } = makeCtx(
      node({ pathPoints: square(40), maskPaths: [{ id: 'm', points: square(30) }] }),
    );
    const tool = new DirectSelectionTool();
    expect(tool.getHandles(ctx).length).toBe(8);

    // Grab the mask corner (30,30), not the geometry corner (40,40).
    tool.onPointerDown(down(30, 30), ctx);
    tool.onDrag(drag(25, 25), ctx);
    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateMaskPath);

    // Now the geometry corner.
    tool.onPointerDown(down(40, 40), ctx);
    tool.onDrag(drag(45, 45), ctx);
    expect(executed[1]!.type).toBe(WorkspaceCommandType.UpdateNodePath);
  });

  it('reveals tangents only for the active vertex of the active outline', () => {
    const { ctx } = makeCtx(masked());
    const tool = new DirectSelectionTool();
    expect(tool.getHandles(ctx).filter((h) => h.kind !== 'point')).toHaveLength(0);

    tool.onPointerDown(down(-30, -30), ctx);
    const handles = tool.getHandles(ctx);
    expect(handles.filter((h) => h.kind === 'tangent-in')).toHaveLength(1);
    expect(handles.filter((h) => h.kind === 'tangent-out')).toHaveLength(1);
  });
});

describe('commands.updateMaskPath', () => {
  it('carries the layer, the mask and the points', () => {
    const c = commands.updateMaskPath('n1' as never, 'm1', square(1));
    expect(c.type).toBe(WorkspaceCommandType.UpdateMaskPath);
    expect(c.payload).toMatchObject({ id: 'n1', maskId: 'm1' });
  });
});
