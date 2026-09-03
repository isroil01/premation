/**
 * Multi-select scale/rotate on the group bounding box — AE's behaviour.
 *
 * A multi-selection used to be move-only: `SelectTool.getHandles` returned []
 * for anything but a single node. Now the eight grips sit on the selection's
 * union AABB (axis-aligned on purpose — a group has no single orientation),
 * a handle drag scales every layer about one fixed pivot (opposite corner,
 * Alt = centre), and the rotate ring spins the group about the box centre
 * (anchors orbit, rotations add).
 *
 * These pin the tool's maths the way `resizeRotated.test.ts` pins the single
 * node's: every tick is ABSOLUTE against drag-start state (start × ratio,
 * start + delta), so a repeated tick cannot compound.
 */

import { SelectTool } from '../tools/builtin';
import {
  WorkspaceCommandType,
  type MultiResizeNodesPayload,
  type MultiRotateNodesPayload,
} from '../commands/WorkspaceCommands';
import { scaleAboutPivot, orbitAboutPivot, oppositePivot } from '../selection/transform';
import { computeHandles } from '../selection/handles';
import type { ToolContext, ToolDragEvent, ToolPointerEvent } from '../tools/Tool';
import { NO_MODIFIERS, type Modifiers } from '../input/events';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';
import type { Rect } from '../math/Rect';
import type { Vec2 } from '../math/Vec2';

interface FakeNode {
  id: string;
  worldMatrix: Mat.Mat2D;
  worldBounds: Rect;
  anchor?: Vec2;
  is3D?: boolean;
  device?: boolean;
  locked?: boolean;
}

/** Unrotated, unscaled layer: anchor (0,0) sits at `position`, box centred there. */
function node(id: string, position: Vec2, size = 100, extra: Partial<FakeNode> = {}): FakeNode {
  return {
    id,
    worldMatrix: Mat.translation(position.x, position.y),
    worldBounds: R.rect(position.x - size / 2, position.y - size / 2, size, size),
    ...extra,
  };
}

function makeCtx(nodes: FakeNode[], selection: string[]) {
  const resizes: MultiResizeNodesPayload[] = [];
  const rotates: MultiRotateNodesPayload[] = [];
  const selected = [...selection];
  const bounds = (): Rect | null =>
    R.bounds(selected.map((id) => nodes.find((n) => n.id === id)?.worldBounds).filter((b): b is Rect => !!b));
  const ctx = {
    requestRender: () => {},
    setSnapLines: () => {},
    selectionIds: () => selected,
    scene: { getNode: (id: string) => nodes.find((n) => n.id === id) },
    selection: {
      get: () => selected,
      select: (id: string) => { selected.splice(0, selected.length, id); },
      clickAt: () => {},
      selectionBounds: bounds,
      handles: () => {
        const b = bounds();
        return b ? computeHandles(b) : [];
      },
    },
    camera: {
      screenDistanceToWorld: (px: number) => px,
      worldToScreen: (p: Vec2) => ({ ...p }),
    },
    cursor: { pushOverride: () => () => {} },
    hitTester: { hitTest: () => null },
    execute: (cmd: { type: string; payload: unknown }) => {
      if (cmd.type === WorkspaceCommandType.MultiResizeNodes) resizes.push(cmd.payload as MultiResizeNodesPayload);
      if (cmd.type === WorkspaceCommandType.MultiRotateNodes) rotates.push(cmd.payload as MultiRotateNodesPayload);
    },
  } as unknown as ToolContext;
  return { ctx, resizes, rotates };
}

const drag = (s: Vec2, c: Vec2, modifiers: Modifiers = NO_MODIFIERS): ToolDragEvent => ({
  startScreen: { ...s }, currentScreen: { ...c },
  startWorld: { ...s }, currentWorld: { ...c },
  deltaScreen: { x: 0, y: 0 }, totalScreen: { x: c.x - s.x, y: c.y - s.y },
  deltaWorld: { x: 0, y: 0 }, totalWorld: { x: c.x - s.x, y: c.y - s.y },
  modifiers, pointer: {} as ToolDragEvent['pointer'],
});

const point = (x: number, y: number): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: NO_MODIFIERS, pointer: {} as ToolPointerEvent['pointer'],
});

/** Two layers whose union AABB is (100,100)-(400,300); 'se' grip at (400,300). */
const twoNodes = () => [node('a', { x: 150, y: 150 }), node('b', { x: 350, y: 250 })];

describe('multi-select handles', () => {
  it('offers the eight grips on the union AABB for a multi-selection', () => {
    const { ctx } = makeCtx(twoNodes(), ['a', 'b']);
    const handles = new SelectTool().getHandles(ctx);
    expect(handles).toHaveLength(8);
    expect(handles.find((h) => h.id === 'nw')!.position).toEqual({ x: 100, y: 100 });
    expect(handles.find((h) => h.id === 'se')!.position).toEqual({ x: 400, y: 300 });
  });

  it('still transforms the 2D layers when a device rides along, but not the device', () => {
    const nodes = [...twoNodes(), node('cam', { x: 600, y: 600 }, 48, { device: true })];
    const { ctx, resizes } = makeCtx(nodes, ['a', 'b', 'cam']);
    const t = new SelectTool();
    expect(t.getHandles(ctx)).toHaveLength(8);
    // Union now spans to the camera's box; grab its 'se' corner and drag.
    t.onPointerDown(point(624, 624), ctx);
    t.onDragStart(drag({ x: 624, y: 624 }, { x: 624, y: 624 }), ctx);
    t.onDrag(drag({ x: 624, y: 624 }, { x: 700, y: 700 }), ctx);
    const items = resizes.at(-1)!.items;
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('offers nothing when no selected layer can take a 2D transform', () => {
    const nodes = [
      node('c1', { x: 0, y: 0 }, 48, { device: true }),
      node('c2', { x: 100, y: 0 }, 48, { is3D: true }),
    ];
    const { ctx } = makeCtx(nodes, ['c1', 'c2']);
    expect(new SelectTool().getHandles(ctx)).toHaveLength(0);
  });
});

describe('multi-select resize', () => {
  it('scales every layer about the opposite corner: scale multiplies, anchors move by the ratio', () => {
    const { ctx, resizes } = makeCtx(twoNodes(), ['a', 'b']);
    const t = new SelectTool();
    t.onPointerDown(point(400, 300), ctx); // grab 'se'
    t.onDragStart(drag({ x: 400, y: 300 }, { x: 400, y: 300 }), ctx);
    t.onDrag(drag({ x: 400, y: 300 }, { x: 700, y: 500 }), ctx); // 300×200 → 600×400

    const items = resizes.at(-1)!.items;
    const a = items.find((i) => i.id === 'a')!;
    const b = items.find((i) => i.id === 'b')!;
    // Pivot is the opposite (nw) corner (100,100); ratio is 2 on both axes.
    expect(a.scale.x).toBeCloseTo(2, 6);
    expect(a.scale.y).toBeCloseTo(2, 6);
    expect(a.position).toEqual(scaleAboutPivot({ x: 150, y: 150 }, { x: 100, y: 100 }, { x: 2, y: 2 }));
    expect(a.position.x).toBeCloseTo(200, 6);
    expect(a.position.y).toBeCloseTo(200, 6);
    expect(b.position.x).toBeCloseTo(600, 6);
    expect(b.position.y).toBeCloseTo(400, 6);
  });

  it('is idempotent — repeating the same tick resolves the same absolute values', () => {
    const { ctx, resizes } = makeCtx(twoNodes(), ['a', 'b']);
    const t = new SelectTool();
    t.onPointerDown(point(400, 300), ctx);
    t.onDragStart(drag({ x: 400, y: 300 }, { x: 400, y: 300 }), ctx);
    t.onDrag(drag({ x: 400, y: 300 }, { x: 550, y: 400 }), ctx);
    t.onDrag(drag({ x: 400, y: 300 }, { x: 550, y: 400 }), ctx);
    const [first, second] = [resizes[0]!.items, resizes[1]!.items];
    expect(second.find((i) => i.id === 'a')!.scale.x).toBeCloseTo(first.find((i) => i.id === 'a')!.scale.x, 10);
    expect(second.find((i) => i.id === 'b')!.position.x).toBeCloseTo(first.find((i) => i.id === 'b')!.position.x, 10);
  });

  it('Alt scales about the group box centre instead', () => {
    const { ctx, resizes } = makeCtx(twoNodes(), ['a', 'b']);
    const t = new SelectTool();
    const alt: Modifiers = { ...NO_MODIFIERS, alt: true };
    t.onPointerDown(point(400, 300), ctx);
    t.onDragStart(drag({ x: 400, y: 300 }, { x: 400, y: 300 }), ctx);
    // Centre (250,200) fixed; dragging 'se' to (550,400) doubles both axes.
    t.onDrag(drag({ x: 400, y: 300 }, { x: 550, y: 400 }, alt), ctx);
    const a = resizes.at(-1)!.items.find((i) => i.id === 'a')!;
    // a's anchor (150,150) is (-100,-50) from the centre → doubles outward.
    expect(a.position.x).toBeCloseTo(50, 6);
    expect(a.position.y).toBeCloseTo(100, 6);
  });

  it('Shift locks the aspect ratio (dominant axis drives both)', () => {
    const { ctx, resizes } = makeCtx(twoNodes(), ['a', 'b']);
    const t = new SelectTool();
    const shift: Modifiers = { ...NO_MODIFIERS, shift: true };
    t.onPointerDown(point(400, 300), ctx);
    t.onDragStart(drag({ x: 400, y: 300 }, { x: 400, y: 300 }), ctx);
    // x doubles, y barely moves → uniform 2× on both.
    t.onDrag(drag({ x: 400, y: 300 }, { x: 700, y: 310 }, shift), ctx);
    const a = resizes.at(-1)!.items.find((i) => i.id === 'a')!;
    expect(a.scale.x).toBeCloseTo(2, 6);
    expect(a.scale.y).toBeCloseTo(2, 6);
  });

  it('shows a scale readout while the drag is live and clears it after', () => {
    const { ctx } = makeCtx(twoNodes(), ['a', 'b']);
    const t = new SelectTool();
    t.onPointerDown(point(400, 300), ctx);
    t.onDragStart(drag({ x: 400, y: 300 }, { x: 400, y: 300 }), ctx);
    t.onDrag(drag({ x: 400, y: 300 }, { x: 700, y: 500 }), ctx);
    // Today's HUD contract is `{ anchorWorld, lines }` (WorkspaceOverlay
    // .dragHud), and the group readout uses the same wording the single-layer
    // scale drag already prints.
    expect(t.getHud()?.lines).toEqual(['200% × 200%']);
    t.onDragEnd(drag({ x: 400, y: 300 }, { x: 700, y: 500 }), ctx);
    expect(t.getHud()).toBeNull();
  });
});

describe('multi-select rotate (ring outside a corner)', () => {
  it('rotates each layer about the group centre: anchors orbit, rotations add', () => {
    const { ctx, rotates } = makeCtx(twoNodes(), ['a', 'b']);
    const t = new SelectTool();
    // Just outside the 'se' corner (400,300), further from the centre (250,200).
    t.onPointerDown(point(418, 315), ctx);
    t.onDragStart(drag({ x: 418, y: 315 }, { x: 418, y: 315 }), ctx);
    // Sweep the start vector (168,115) a quarter turn about the centre.
    t.onDrag(drag({ x: 418, y: 315 }, { x: 250 - 115, y: 200 + 168 }), ctx);

    const items = rotates.at(-1)!.items;
    const a = items.find((i) => i.id === 'a')!;
    expect(a.rotation).toBeCloseTo(Math.PI / 2, 6);
    // a's anchor (150,150) is (-100,-50) from the centre → (50,-100) after 90°.
    expect(a.position.x).toBeCloseTo(300, 4);
    expect(a.position.y).toBeCloseTo(100, 4);
    expect(a.position.x).toBeCloseTo(orbitAboutPivot({ x: 150, y: 150 }, { x: 250, y: 200 }, Math.PI / 2).x, 8);
    // The group readout is the signed SWEEP — the layers went in at different
    // angles, so there is no single absolute angle to print.
    expect(t.getHud()?.lines).toEqual(['+90.0°']);
  });

  it('Shift snaps the SWEEP to 15° so differently-rotated layers stay a rigid group', () => {
    const { ctx, rotates } = makeCtx(twoNodes(), ['a', 'b']);
    const t = new SelectTool();
    const shift: Modifiers = { ...NO_MODIFIERS, shift: true };
    t.onPointerDown(point(418, 315), ctx);
    t.onDragStart(drag({ x: 418, y: 315 }, { x: 418, y: 315 }), ctx);
    // A sweep of ~40° must land every layer at exactly start + 45°.
    const a0 = Math.atan2(115, 168);
    const sw = a0 + (40 * Math.PI) / 180;
    t.onDrag(drag({ x: 418, y: 315 }, { x: 250 + 210 * Math.cos(sw), y: 200 + 210 * Math.sin(sw) }, shift), ctx);
    const items = rotates.at(-1)!.items;
    expect(items[0]!.rotation).toBeCloseTo(Math.PI / 4, 6);
    expect(items[1]!.rotation).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe('pivot helpers', () => {
  const rect = R.rect(100, 100, 300, 200);

  it('oppositePivot holds the corner/edge opposite the grabbed handle', () => {
    expect(oppositePivot(rect, 'se')).toEqual({ x: 100, y: 100 });
    expect(oppositePivot(rect, 'nw')).toEqual({ x: 400, y: 300 });
    expect(oppositePivot(rect, 'n')).toEqual({ x: 250, y: 300 });
    expect(oppositePivot(rect, 'e')).toEqual({ x: 100, y: 200 });
  });

  it('scaleAboutPivot leaves the pivot itself fixed', () => {
    const p = { x: 40, y: 60 };
    expect(scaleAboutPivot(p, p, { x: 3, y: 0.5 })).toEqual(p);
  });

  it('orbitAboutPivot sweeps the expected quarter turn', () => {
    const q = orbitAboutPivot({ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(q.x).toBeCloseTo(0, 10);
    expect(q.y).toBeCloseTo(10, 10);
  });
});
