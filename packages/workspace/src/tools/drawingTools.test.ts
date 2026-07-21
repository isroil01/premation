/**
 * Drawing tools — verify each new tool commits a createNode command with the
 * right kind + geometry, and that the pen commits (rather than discards) on
 * deactivate so switching tools mid-draw keeps the path.
 */

import { PencilTool, LineTool, PolygonTool, StarTool, CurvatureTool, PenTool } from './builtin';
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
