/**
 * The Knife tool's job is targeting and gating, not geometry — the cut itself
 * lives app-side (`core/geometry/pathCut`) and is tested there. What this file
 * pins is the set of decisions the tool alone makes, each of which was a real
 * hazard while it was being written:
 *
 *   • a TAP must not cut. Below the drag threshold the line's direction is
 *     pointer noise, and the submitted line is infinite — so a stray click on
 *     the canvas would slice every layer along an arbitrary angle.
 *   • the SELECTION wins. "Cut these two" has to be expressible.
 *   • with nothing selected, only layers the line actually passes THROUGH are
 *     cut — by the corners, not the AABB, so a diagonal near-miss stays a miss.
 *   • `k` is free across the builtin set.
 */

import { KnifeTool, createBuiltinTools } from './builtin';
import { WorkspaceCommandType, type CutPathsPayload } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent } from './Tool';
import type { WorkspaceNode } from '../ports';
import { NO_MODIFIERS } from '../input/events';

function node(id: string, x: number, y: number, w: number, h: number): WorkspaceNode {
  return {
    id,
    name: id,
    worldBounds: { x, y, width: w, height: h },
    visible: true,
    locked: false,
    zIndex: 0,
    worldMatrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  } as unknown as WorkspaceNode;
}

function makeCtx(nodes: WorkspaceNode[] = [], selection: string[] = []) {
  const cuts: CutPathsPayload[] = [];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => selection,
    scene: { getNodes: () => nodes },
    execute: (cmd: { type: string; payload: CutPathsPayload }) => {
      if (cmd.type === WorkspaceCommandType.CutPaths) cuts.push(cmd.payload);
    },
  } as unknown as ToolContext;
  return { ctx, cuts };
}

const drag = (
  sx: number, sy: number, cx: number, cy: number,
  modifiers = NO_MODIFIERS,
): ToolDragEvent => ({
  startScreen: { x: sx, y: sy }, currentScreen: { x: cx, y: cy },
  startWorld: { x: sx, y: sy }, currentWorld: { x: cx, y: cy },
  deltaScreen: { x: 0, y: 0 }, totalScreen: { x: cx - sx, y: cy - sy },
  deltaWorld: { x: 0, y: 0 }, totalWorld: { x: cx - sx, y: cy - sy },
  modifiers, pointer: {} as ToolDragEvent['pointer'],
});

describe('KnifeTool', () => {
  it('claims `k`, which no other builtin tool does', () => {
    const shortcuts = createBuiltinTools()
      .map((t) => t.shortcut)
      .filter((s): s is string => !!s);
    expect(shortcuts.filter((s) => s === 'k')).toEqual(['k']);
  });

  it('submits one cut for the selection, in world coordinates', () => {
    const { ctx, cuts } = makeCtx([], ['a', 'b']);
    const t = new KnifeTool();
    t.onDragStart(drag(0, -50, 0, -50), ctx);
    t.onDrag(drag(0, -50, 0, 50), ctx);
    t.onDragEnd(drag(0, -50, 0, 50), ctx);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.ids).toEqual(['a', 'b']);
    expect(cuts[0]!.a).toEqual({ x: 0, y: -50 });
    expect(cuts[0]!.b).toEqual({ x: 0, y: 50 });
  });

  it('does not cut on a tap — the direction would be noise', () => {
    const { ctx, cuts } = makeCtx([], ['a']);
    const t = new KnifeTool();
    t.onDragStart(drag(0, 0, 0, 0), ctx);
    t.onDragEnd(drag(0, 0, 1, 0), ctx);
    expect(cuts).toEqual([]);
  });

  it('with nothing selected, cuts only the layers the line passes through', () => {
    const hit = node('hit', -50, -50, 100, 100);
    const miss = node('miss', 200, 200, 100, 100);
    const { ctx, cuts } = makeCtx([hit, miss], []);
    const t = new KnifeTool();
    t.onDragStart(drag(0, -80, 0, -80), ctx);
    t.onDragEnd(drag(0, -80, 0, 80), ctx);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.ids).toEqual(['hit']);
  });

  it('skips locked layers when falling back to the whole scene', () => {
    const locked = { ...node('locked', -50, -50, 100, 100), locked: true } as WorkspaceNode;
    const { ctx, cuts } = makeCtx([locked], []);
    const t = new KnifeTool();
    t.onDragStart(drag(0, -80, 0, -80), ctx);
    t.onDragEnd(drag(0, -80, 0, 80), ctx);
    expect(cuts).toEqual([]);
  });

  it('Shift snaps the cut to the nearest 45°', () => {
    const { ctx, cuts } = makeCtx([], ['a']);
    const t = new KnifeTool();
    const shift = { ...NO_MODIFIERS, shift: true };
    t.onDragStart(drag(0, 0, 0, 0, shift), ctx);
    // 5° off horizontal — a hand-drawn "straight" cut.
    t.onDragEnd(drag(0, 0, 100, 8.75, shift), ctx);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.b.y).toBeCloseTo(0, 9);
    expect(cuts[0]!.b.x).toBeCloseTo(Math.hypot(100, 8.75), 9);
  });

  it('previews the live line and drops it on deactivate', () => {
    const { ctx } = makeCtx([], ['a']);
    const t = new KnifeTool();
    expect(t.pendingPoints).toHaveLength(0);
    t.onDragStart(drag(0, 0, 0, 0), ctx);
    t.onDrag(drag(0, 0, 40, 40), ctx);
    expect(t.pendingPoints).toHaveLength(2);
    t.deactivate();
    expect(t.pendingPoints).toHaveLength(0);
  });
});
