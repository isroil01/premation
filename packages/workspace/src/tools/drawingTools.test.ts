/**
 * Drawing tools — verify each new tool commits a createNode command with the
 * right kind + geometry, and that the pen commits (rather than discards) on
 * deactivate so switching tools mid-draw keeps the path.
 */

import { PencilTool, LineTool, PolygonTool, StarTool, CurvatureTool, PenTool, MaskPenTool } from './builtin';
import { WorkspaceCommandType, type CreateNodePayload } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent, ToolPointerEvent, ToolKeyEvent } from './Tool';
import { NO_MODIFIERS } from '../input/events';

function makeCtx() {
  const commands: Array<{ kind: string; points?: unknown[] }> = [];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => [] as string[],
    execute: (cmd: { type: string; payload: CreateNodePayload }) => {
      if (cmd.type === WorkspaceCommandType.CreateNode) {
        commands.push({ kind: cmd.payload.kind, points: cmd.payload.points });
      }
    },
  } as unknown as ToolContext;
  return { ctx, commands };
}

const drag = (sx: number, sy: number, cx: number, cy: number): ToolDragEvent => ({
  startScreen: { x: sx, y: sy }, currentScreen: { x: cx, y: cy },
  startWorld: { x: sx, y: sy }, currentWorld: { x: cx, y: cy },
  deltaScreen: { x: 0, y: 0 }, totalScreen: { x: cx - sx, y: cy - sy },
  deltaWorld: { x: 0, y: 0 }, totalWorld: { x: cx - sx, y: cy - sy },
  modifiers: NO_MODIFIERS, pointer: {} as ToolDragEvent['pointer'],
});

const click = (x: number, y: number): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: NO_MODIFIERS, pointer: {} as ToolPointerEvent['pointer'],
});

describe('drawing tools commit the right nodes', () => {
  it('LineTool creates a 2-point Line', () => {
    const { ctx, commands } = makeCtx();
    const t = new LineTool();
    t.onDragStart(drag(0, 0, 0, 0), ctx);
    t.onDrag(drag(0, 0, 100, 60), ctx);
    t.onDragEnd(drag(0, 0, 100, 60), ctx);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('Line');
    expect(commands[0]!.points).toHaveLength(2);
  });

  it('PencilTool creates a Pencil path from a freehand drag', () => {
    const { ctx, commands } = makeCtx();
    const t = new PencilTool();
    t.onDragStart(drag(0, 0, 0, 0), ctx);
    for (let i = 1; i <= 20; i++) t.onDrag(drag(0, 0, i * 5, Math.sin(i) * 30), ctx);
    t.onDragEnd(drag(0, 0, 100, 0), ctx);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('Pencil');
    expect((commands[0]!.points as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('PolygonTool creates a 6-point Polygon', () => {
    const { ctx, commands } = makeCtx();
    const t = new PolygonTool();
    t.onDrag(drag(0, 0, 100, 100), ctx);
    t.onDragEnd(drag(0, 0, 100, 100), ctx);
    expect(commands[0]!.kind).toBe('Polygon');
    expect(commands[0]!.points).toHaveLength(6);
  });

  it('StarTool creates a 10-point Star', () => {
    const { ctx, commands } = makeCtx();
    const t = new StarTool();
    t.onDrag(drag(0, 0, 100, 100), ctx);
    t.onDragEnd(drag(0, 0, 100, 100), ctx);
    expect(commands[0]!.kind).toBe('Star');
    expect(commands[0]!.points).toHaveLength(10);
  });

  it('CurvatureTool smooths clicked points into a Path with bezier handles', () => {
    const { ctx, commands } = makeCtx();
    const t = new CurvatureTool();
    t.onClick(click(0, 0), ctx);
    t.onClick(click(50, 40), ctx);
    t.onClick(click(100, 0), ctx);
    t.onKeyDown({ key: 'Enter' } as ToolKeyEvent, ctx);
    expect(commands[0]!.kind).toBe('Path');
    const pts = commands[0]!.points as Array<{ x: number; outX: number }>;
    // Middle anchor should carry a non-trivial out-tangent (curve, not corner).
    expect(pts[1]!.outX).not.toBe(pts[1]!.x);
  });

  it('PenTool commits (does not discard) the in-progress path on deactivate', () => {
    const { ctx, commands } = makeCtx();
    const t = new PenTool();
    t.onPointerDown(click(0, 0), ctx);
    t.onPointerUp(click(0, 0), ctx);
    t.onPointerDown(click(80, 40), ctx);
    t.onPointerUp(click(80, 40), ctx);
    // Switching tools mid-draw triggers deactivate — the path must be kept.
    t.deactivate(ctx);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('Path');
  });
});

/**
 * The reported bug, pinned down.
 *
 * "I draw with another pen, then draw with the Pen, then pick another tool, and
 * the stroke I already had is deleted." It was: `finish` passed the single
 * selected node as `maskTargetId`, so the path became an `add` MASK on that
 * layer — clipping the layer to the new outline — instead of becoming a layer
 * of its own. Both halves of the drawing vanish that way.
 *
 * The condition was met permanently rather than occasionally, because
 * `createNode` selects whatever it just created. So after drawing ANYTHING the
 * pen was in mask mode, with no way to see that and no way to turn it off.
 *
 * A selection is the trigger, which is why nothing above catches it: every test
 * there uses a context whose selection is empty. These use a populated one.
 */
function makeCtxWithSelection(ids: string[]) {
  const commands: Array<{ kind: string; maskTargetId?: string }> = [];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => ids,
    execute: (cmd: { type: string; payload: CreateNodePayload }) => {
      if (cmd.type === WorkspaceCommandType.CreateNode) {
        commands.push({ kind: cmd.payload.kind, maskTargetId: cmd.payload.maskTargetId });
      }
    },
  } as unknown as ToolContext;
  return { ctx, commands };
}

const drawTwoPoints = (t: PenTool, ctx: ToolContext): void => {
  t.onPointerDown(click(0, 0), ctx);
  t.onPointerUp(click(0, 0), ctx);
  t.onPointerDown(click(80, 40), ctx);
  t.onPointerUp(click(80, 40), ctx);
  t.deactivate(ctx);
};

describe('the Pen draws a layer, not a mask', () => {
  it('does NOT mask the selected layer', () => {
    const { ctx, commands } = makeCtxWithSelection(['layer_the_user_just_drew']);
    drawTwoPoints(new PenTool(), ctx);

    expect(commands).toHaveLength(1);
    // The whole bug in one assertion: a mask target here meant the previous
    // stroke was clipped away and this path never became a layer.
    expect(commands[0]!.maskTargetId).toBeUndefined();
    expect(commands[0]!.kind).toBe('Path');
  });

  it('MaskPenTool still masks — the capability moved, it was not removed', () => {
    const { ctx, commands } = makeCtxWithSelection(['layer_a']);
    drawTwoPoints(new MaskPenTool(), ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0]!.maskTargetId).toBe('layer_a');
  });

  it('MaskPenTool with nothing selected falls back to a path layer', () => {
    const { ctx, commands } = makeCtxWithSelection([]);
    drawTwoPoints(new MaskPenTool(), ctx);

    // A mask needs a layer to belong to. Refusing the stroke would throw away
    // what the user just drew, so it lands as a layer instead.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.maskTargetId).toBeUndefined();
    expect(commands[0]!.kind).toBe('Path');
  });

  it('MaskPenTool does not guess which layer to mask from a multi-selection', () => {
    const { ctx, commands } = makeCtxWithSelection(['layer_a', 'layer_b']);
    drawTwoPoints(new MaskPenTool(), ctx);

    expect(commands[0]!.maskTargetId).toBeUndefined();
  });
});
