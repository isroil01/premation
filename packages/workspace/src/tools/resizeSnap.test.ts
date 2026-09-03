/**
 * Equal-SIZE snapping on a resize drag.
 *
 * `equalSizeCandidates` has always computed the exact delta that makes the
 * dragged layer as wide (or as tall) as a neighbour, but only the overlay read
 * it — the highlight lit up while the drag sailed straight past the match.
 * These pin the hook-up, and the three things it must not fight: the fixed
 * point (anchor / centre under Alt), the aspect lock, and the axes the grabbed
 * handle actually moves.
 */

import { SelectTool } from './builtin';
import { WorkspaceCommandType, type ResizeNodePayload } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent, ToolPointerEvent } from './Tool';
import { NO_MODIFIERS, type Modifiers } from '../input/events';
import { equalSizeCandidates } from '../snap/smartGuides';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';
import type { Rect } from '../math/Rect';

const IDENTITY = Mat.identity();

/** Snap radius the fake context reports, in world units (1:1 with screen). */
const RADIUS = 3;

const HANDLES = [
  { id: 'nw', position: { x: 0, y: 0 } },
  { id: 'n', position: { x: 50, y: 0 } },
  { id: 'ne', position: { x: 100, y: 0 } },
  { id: 'e', position: { x: 100, y: 50 } },
  { id: 'se', position: { x: 100, y: 100 } },
  { id: 's', position: { x: 50, y: 100 } },
  { id: 'sw', position: { x: 0, y: 100 } },
  { id: 'w', position: { x: 0, y: 50 } },
].map((h) => ({ ...h, kind: 'resize' as const }));

/**
 * A single 100×100 layer at the world origin, anchored at its top-left so the
 * resize pivot is (0,0) and the arithmetic in each test is visible.
 *
 * `neighbours` are the OTHER layers' world bounds — what equal-size matches
 * against. `bounds` is the live selection box, which the tool re-reads each
 * tick only to place the neighbour query.
 */
function makeCtx(neighbours: Rect[]) {
  const resizes: ResizeNodePayload[] = [];
  const node = { id: 'n1', worldMatrix: IDENTITY, anchor: { x: 0, y: 0 }, localBounds: R.rect(0, 0, 100, 100) };
  const ctx = {
    requestRender: () => {},
    selectionIds: () => ['n1'],
    scene: { getNode: (id: string) => (id === 'n1' ? node : undefined) },
    selection: {
      selectionBounds: () => R.rect(0, 0, 100, 100),
      handles: () => HANDLES,
      select: () => {},
      clickAt: () => {},
    },
    camera: {
      screenDistanceToWorld: (px: number) => px,
      worldToScreen: (p: { x: number; y: number }) => p,
    },
    cursor: { pushOverride: () => () => {} },
    hitTester: { hitTest: () => null },
    sizeMatches: (rect: Rect) => equalSizeCandidates(rect, neighbours, RADIUS),
    execute: (cmd: { type: string; payload: unknown }) => {
      if (cmd.type === WorkspaceCommandType.ResizeNode) resizes.push(cmd.payload as ResizeNodePayload);
    },
  } as unknown as ToolContext;
  return { ctx, resizes };
}

const mods = (patch: Partial<Modifiers> = {}): Modifiers => ({ ...NO_MODIFIERS, ...patch });

const point = (x: number, y: number): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: NO_MODIFIERS, pointer: {} as ToolPointerEvent['pointer'],
});

const drag = (sx: number, sy: number, cx: number, cy: number, m: Modifiers): ToolDragEvent => ({
  startScreen: { x: sx, y: sy }, currentScreen: { x: cx, y: cy },
  startWorld: { x: sx, y: sy }, currentWorld: { x: cx, y: cy },
  deltaScreen: { x: 0, y: 0 }, totalScreen: { x: cx - sx, y: cy - sy },
  deltaWorld: { x: 0, y: 0 }, totalWorld: { x: cx - sx, y: cy - sy },
  modifiers: m, pointer: {} as ToolDragEvent['pointer'],
});

/**
 * Drive one resize gesture and return the size the last tick wrote.
 *
 * Ctrl/⌘ (`mod`) puts the drag in SIZE mode, where the payload carries the
 * layer's own new box — the snapped number, undivided by any scale ratio.
 */
function resizeTo(
  neighbours: Rect[],
  handle: { x: number; y: number },
  to: { x: number; y: number },
  extra: Partial<Modifiers> = {},
): { size: ResizeNodePayload['size']; center: ResizeNodePayload['center'] } {
  const { ctx, resizes } = makeCtx(neighbours);
  const t = new SelectTool();
  const m = mods({ mod: true, ...extra });
  t.onPointerDown(point(handle.x, handle.y), ctx);
  t.onDragStart(drag(handle.x, handle.y, handle.x, handle.y, m), ctx);
  t.onDrag(drag(handle.x, handle.y, to.x, to.y, m), ctx);
  const last = resizes[resizes.length - 1];
  return { size: last?.size, center: last?.center };
}

describe('SelectTool resize — equal-size snapping', () => {
  it('snaps the dragged edge onto a neighbour of nearly the same width', () => {
    // Pointer at 148 → a 148-wide box; a 150-wide neighbour is 2 away, inside
    // the 3-unit radius, so the edge lands on 150.
    const { size } = resizeTo([R.rect(400, 400, 150, 60)], { x: 100, y: 50 }, { x: 148, y: 50 });
    expect(size?.x).toBeCloseTo(150);
    // The untouched axis is untouched.
    expect(size?.y).toBeCloseTo(100);
  });

  it('leaves the drag alone when no neighbour is near that size', () => {
    const { size } = resizeTo([R.rect(400, 400, 190, 60)], { x: 100, y: 50 }, { x: 148, y: 50 });
    expect(size?.x).toBeCloseTo(148);
  });

  it('ignores a match on an axis the grabbed handle does not move', () => {
    // The `e` grip changes width only. A neighbour 101 tall is within reach of
    // the box's 100 height, but snapping it would resize an axis the user is
    // not dragging.
    const { size } = resizeTo([R.rect(400, 400, 40, 101)], { x: 100, y: 50 }, { x: 148, y: 50 });
    expect(size?.x).toBeCloseTo(148);
    expect(size?.y).toBeCloseTo(100);
  });

  it('keeps the fixed anchor edge fixed', () => {
    // Anchored at (0,0): the left edge must not move when the right one snaps.
    // In size mode the centre is the layer's own new centre, so a 150-wide box
    // that still starts at x=0 has its centre at 75.
    const { center } = resizeTo([R.rect(400, 400, 150, 60)], { x: 100, y: 50 }, { x: 148, y: 50 });
    expect(center?.x).toBeCloseTo(75);
  });

  it('stays centred when Alt makes the resize centre-anchored', () => {
    // Alt grows both ways: pointer at 148 → 196 wide about the centre (50,50).
    // A 198-wide neighbour is 2 away → 198 wide, still centred on 50.
    const { size, center } = resizeTo(
      [R.rect(400, 400, 198, 60)],
      { x: 100, y: 50 },
      { x: 148, y: 50 },
      { alt: true },
    );
    expect(size?.x).toBeCloseTo(198);
    expect(center?.x).toBeCloseTo(50);
  });

  it('does not fight the Shift aspect lock — both axes take the same factor', () => {
    // Corner drag under Shift: the dominant axis (x, 1.48) drives both, so the
    // box is 148×148 before snapping. Landing width on 150 must carry the
    // height to 150 too, or the lock the user is holding would be broken.
    const { size } = resizeTo(
      [R.rect(400, 400, 150, 150)],
      { x: 100, y: 100 },
      { x: 148, y: 130 },
      { shift: true },
    );
    expect(size?.x).toBeCloseTo(150);
    expect(size?.y).toBeCloseTo(150);
  });

  it('does not match the layer against itself', () => {
    // The dragged layer's own bounds are excluded from the neighbour query; if
    // they were not, every size would "match" and the drag would never move.
    const { ctx } = makeCtx([]);
    const seen: Array<ReadonlySet<string> | undefined> = [];
    const spy = {
      ...ctx,
      sizeMatches: (_r: Rect, ex?: ReadonlySet<string>) => { seen.push(ex); return []; },
    } as ToolContext;
    const t = new SelectTool();
    const m = mods({ mod: true });
    t.onPointerDown(point(100, 50), spy);
    t.onDragStart(drag(100, 50, 100, 50, m), spy);
    t.onDrag(drag(100, 50, 148, 50, m), spy);
    expect(seen).not.toHaveLength(0);
    expect(seen[0]?.has('n1')).toBe(true);
  });
});
