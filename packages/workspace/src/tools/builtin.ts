/**
 * Built-in tools. Each is a self-contained, pluggable state machine that acts
 * only through the `ToolContext`. They cover the core editor verbs; a future AI
 * tool registers the same way with zero engine changes.
 *
 *   SelectTool     — click-select, shift-toggle, marquee, drag-to-move (+snap)
 *   MoveTool       — drag the current selection (no marquee)
 *   HandTool       — pan the camera
 *   ZoomTool       — click to zoom (alt = out), drag a region to frame it
 *   RectangleTool  — drag to create a rectangle
 *   EllipseTool    — drag to create an ellipse
 *   PenTool        — click to place path points, double-click to finish
 *   TextTool       — click to place a text box
 *   CameraTool     — navigate (drag-pan) without touching the scene
 */

import type { Rect } from '../math/Rect';
import * as R from '../math/Rect';
import type { NodeId, OverlayHandle } from '../ports';
import type { Vec2 } from '../math/Vec2';
import type { BezierPoint } from '../math/BezierPoint';
import { corner as bezierCorner } from '../math/BezierPoint';
import { commands } from '../commands/WorkspaceCommands';
import * as Mat from '../math/Mat2D';
import type { HandleId } from '../selection/handles';
import { resizeBounds, rotationDelta } from '../selection/transform';
import { handleCursor } from '../selection/handles';
import type { CursorType } from '../cursor/CursorManager';
import type { Tool, ToolContext, ToolPointerEvent, ToolDragEvent, ToolKeyEvent } from './Tool';

/** Default size used when a create/text tool is clicked without dragging. */
const DEFAULT_CREATE_SIZE = 100;

/** Screen-pixel radius for grabbing a selection handle. */
const HANDLE_PICK_RADIUS = 9;

// ── Select ─────────────────────────────────────────────────────────
export class SelectTool implements Tool {
  readonly id = 'select';
  readonly label = 'Select';
  readonly shortcut = 'v';
  readonly cursor = 'default' as const;

  private mode: 'idle' | 'marquee' | 'move' | 'resize' | 'rotate' = 'idle';
  private downNodeId: NodeId | null = null;
  private downHandle: HandleId | null = null;
  private moveIds: NodeId[] = [];
  private startBounds: Rect | null = null;
  private appliedDelta: Vec2 = { x: 0, y: 0 };
  private excludeIds: Set<string> = new Set();
  // Transform (single-node) state.
  private transformId: NodeId | null = null;
  private transformStartRotation = 0;
  private transformPivot: Vec2 = { x: 0, y: 0 };
  private cursorPop: (() => void) | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    // A handle grab (single selection) takes priority over hit-testing nodes.
    this.downHandle = this.pickHandle(e.screen, ctx);
    this.downNodeId = this.downHandle ? null : ctx.hitTester.hitTest(e.world)?.id ?? null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    // Hover feedback over handles: show the matching resize/rotate cursor.
    if (this.mode !== 'idle') return;
    const handle = this.pickHandle(e.screen, ctx);
    this.cursorPop?.();
    this.cursorPop = handle ? ctx.cursor.pushOverride(handleCursor(handle) as CursorType) : null;
  }

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    // Clicking a handle (no drag) shouldn't change the selection.
    if (this.downHandle) return;
    ctx.selection.clickAt(e.world, e.modifiers);
    ctx.requestRender();
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    const sel = currentSelection(ctx);
    // Handle drag → resize/rotate the single selected node.
    if (this.downHandle && sel.length === 1) {
      this.transformId = sel[0]!;
      this.startBounds = ctx.selection.selectionBounds();
      this.transformPivot = this.startBounds ? R.center(this.startBounds) : e.startWorld;
      if (this.downHandle === 'rotate') {
        this.mode = 'rotate';
        const node = ctx.scene.getNode(this.transformId);
        this.transformStartRotation = node ? Math.atan2(node.worldMatrix.b, node.worldMatrix.a) : 0;
      } else {
        this.mode = 'resize';
      }
      return;
    }
    if (this.downNodeId === null) {
      this.mode = 'marquee';
      ctx.selection.beginMarquee(e.startWorld);
      return;
    }
    if (!isSelected(ctx, this.downNodeId)) {
      ctx.selection.select(this.downNodeId);
    }
    this.mode = 'move';
    this.moveIds = [...currentSelection(ctx)];
    this.startBounds = ctx.selection.selectionBounds();
    this.appliedDelta = { x: 0, y: 0 };
    this.excludeIds = new Set(this.moveIds);
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (this.mode === 'marquee') {
      ctx.selection.updateMarquee(e.currentWorld);
      ctx.requestRender();
      return;
    }
    if (this.mode === 'resize' && this.transformId && this.startBounds && this.downHandle) {
      const bounds = resizeBounds(this.startBounds, this.downHandle, e.currentWorld, e.modifiers.alt);
      ctx.execute(commands.resizeNode(this.transformId, bounds));
      ctx.requestRender();
      return;
    }
    if (this.mode === 'rotate' && this.transformId) {
      const delta = rotationDelta(this.transformPivot, e.startWorld, e.currentWorld);
      ctx.execute(commands.rotateNode(this.transformId, this.transformStartRotation + delta, this.transformPivot));
      ctx.requestRender();
      return;
    }
    if (this.mode === 'move' && this.startBounds && this.moveIds.length) {
      let total = e.totalWorld;
      const movedBounds = R.translate(this.startBounds, total);
      const snap = ctx.snapRect(movedBounds, this.excludeIds);
      total = { x: total.x + snap.delta.x, y: total.y + snap.delta.y };
      const inc = { x: total.x - this.appliedDelta.x, y: total.y - this.appliedDelta.y };
      if (inc.x !== 0 || inc.y !== 0) {
        ctx.execute(commands.moveNodes(this.moveIds, inc));
        this.appliedDelta = total;
      }
      ctx.setSnapLines(snap.lines);
      ctx.requestRender();
    }
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    if (this.mode === 'marquee') {
      ctx.selection.endMarquee(_e.modifiers);
    }
    ctx.setSnapLines([]);
    this.mode = 'idle';
    this.downNodeId = null;
    this.downHandle = null;
    this.transformId = null;
    this.startBounds = null;
    this.moveIds = [];
    ctx.requestRender();
  }

  deactivate(): void {
    this.cursorPop?.();
    this.cursorPop = null;
  }

  /** Which selection handle is under a screen point, if any. */
  private pickHandle(screen: Vec2, ctx: ToolContext): HandleId | null {
    if (ctx.selectionIds().length !== 1) return null;
    const handles = ctx.selection.handles(ctx.camera.screenDistanceToWorld(24));
    let best: HandleId | null = null;
    let bestDist = HANDLE_PICK_RADIUS;
    for (const h of handles) {
      const s = ctx.camera.worldToScreen(h.position);
      const d = Math.hypot(s.x - screen.x, s.y - screen.y);
      if (d <= bestDist) {
        bestDist = d;
        best = h.id;
      }
    }
    return best;
  }
}

// ── Move ───────────────────────────────────────────────────────────
export class MoveTool implements Tool {
  readonly id = 'move';
  readonly label = 'Move';
  readonly shortcut = 'm';
  readonly cursor = 'move' as const;

  private moveIds: NodeId[] = [];
  private startBounds: Rect | null = null;
  private appliedDelta: Vec2 = { x: 0, y: 0 };
  private excludeIds: Set<string> = new Set();

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    ctx.selection.clickAt(e.world, e.modifiers);
    ctx.requestRender();
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    const sel = currentSelection(ctx);
    if (sel.length === 0) {
      const node = ctx.hitTester.hitTest(e.startWorld);
      if (node) ctx.selection.select(node.id);
    }
    this.moveIds = [...currentSelection(ctx)];
    this.startBounds = ctx.selection.selectionBounds();
    this.appliedDelta = { x: 0, y: 0 };
    this.excludeIds = new Set(this.moveIds);
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.startBounds || this.moveIds.length === 0) return;
    let total = e.totalWorld;
    const snap = ctx.snapRect(R.translate(this.startBounds, total), this.excludeIds);
    total = { x: total.x + snap.delta.x, y: total.y + snap.delta.y };
    const inc = { x: total.x - this.appliedDelta.x, y: total.y - this.appliedDelta.y };
    if (inc.x !== 0 || inc.y !== 0) {
      ctx.execute(commands.moveNodes(this.moveIds, inc));
      this.appliedDelta = total;
    }
    ctx.setSnapLines(snap.lines);
    ctx.requestRender();
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    ctx.setSnapLines([]);
    this.startBounds = null;
    this.moveIds = [];
    ctx.requestRender();
  }
}

// ── Hand (pan) ─────────────────────────────────────────────────────
export class HandTool implements Tool {
  readonly id = 'hand';
  readonly label = 'Hand';
  readonly shortcut = 'h';
  readonly cursor = 'grab' as const;

  private popCursor: (() => void) | null = null;

  onDragStart(_e: ToolDragEvent, ctx: ToolContext): void {
    this.popCursor = ctx.cursor.pushOverride('grabbing');
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    ctx.camera.panByScreen(e.deltaScreen.x, e.deltaScreen.y);
    ctx.requestRender();
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    this.popCursor?.();
    this.popCursor = null;
    ctx.requestRender();
  }
}

// ── Zoom ───────────────────────────────────────────────────────────
export class ZoomTool implements Tool {
  readonly id = 'zoom';
  readonly label = 'Zoom';
  readonly shortcut = 'z';
  readonly cursor = 'zoom-in' as const;

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    const factor = e.modifiers.alt ? 1 / 1.6 : 1.6;
    ctx.camera.zoomToCursor(factor, ctx.screenToViewport(e.screen));
    ctx.requestRender();
  }

  onDragEnd(e: ToolDragEvent, ctx: ToolContext): void {
    // Drag a region → frame it.
    const rect = R.fromPoints(e.startWorld, e.currentWorld);
    if (rect.width > 1e-3 && rect.height > 1e-3) {
      ctx.camera.zoomToRect(rect, 0);
      ctx.requestRender();
    }
  }
}

// ── Shape creation (rectangle / ellipse) ───────────────────────────
abstract class CreateShapeTool implements Tool {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly kind: string;
  abstract readonly shortcut: string;
  readonly cursor = 'crosshair' as const;

  protected preview: Rect | null = null;

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    this.preview = R.fromPoints(e.startWorld, e.currentWorld);
    ctx.requestRender();
  }

  onDragEnd(e: ToolDragEvent, ctx: ToolContext): void {
    const rect = R.fromPoints(e.startWorld, e.currentWorld);
    this.preview = null;
    if (rect.width < 1e-3 || rect.height < 1e-3) return;
    ctx.execute(commands.createNode(this.kind, rect));
    ctx.requestRender();
  }

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    // Click without drag → default-sized shape centered on the point.
    const rect = R.fromCenter(e.world, DEFAULT_CREATE_SIZE, DEFAULT_CREATE_SIZE);
    ctx.execute(commands.createNode(this.kind, rect));
    ctx.requestRender();
  }

  /** Current drag preview (screen conversion done by the overlay). */
  get previewRect(): Rect | null {
    return this.preview;
  }
}

export class RectangleTool extends CreateShapeTool {
  readonly id = 'rectangle';
  readonly label = 'Rectangle';
  readonly kind = 'Rectangle';
  readonly shortcut = 'r';
}

export class EllipseTool extends CreateShapeTool {
  readonly id = 'ellipse';
  readonly label = 'Ellipse';
  readonly kind = 'Ellipse';
  readonly shortcut = 'q';
}

abstract class CreateMaskShapeTool extends CreateShapeTool {
  override onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    const selection = ctx.selectionIds();
    const maskTargetId = selection.length === 1 ? selection[0] : undefined;
    if (maskTargetId) {
      const rect = R.fromCenter(e.world, DEFAULT_CREATE_SIZE, DEFAULT_CREATE_SIZE);
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const rx = rect.width / 2;
      const ry = rect.height / 2;
      let localPoints: BezierPoint[] = [];
      if (this.kind === 'Rectangle') {
        localPoints = [
          bezierCorner(rect.x - cx, rect.y - cy),
          bezierCorner(rect.x + rect.width - cx, rect.y - cy),
          bezierCorner(rect.x + rect.width - cx, rect.y + rect.height - cy),
          bezierCorner(rect.x - cx, rect.y + rect.height - cy)
        ];
      } else {
        // Ellipse
        const k = 0.5522848;
        localPoints = [
          { x: 0, y: -ry, inX: -rx * k, inY: -ry, outX: rx * k, outY: -ry },
          { x: rx, y: 0, inX: rx, inY: -ry * k, outX: rx, outY: ry * k },
          { x: 0, y: ry, inX: rx * k, inY: ry, outX: -rx * k, outY: ry },
          { x: -rx, y: 0, inX: -rx, inY: ry * k, outX: -rx, outY: -ry * k },
        ];
      }
      ctx.execute(commands.createNode('Path', rect, localPoints, maskTargetId));
    }
    ctx.requestRender();
  }

  override onDragEnd(e: ToolDragEvent, ctx: ToolContext): void {
    const rect = R.fromPoints(e.startWorld, e.currentWorld);
    this.preview = null;
    if (rect.width < 1e-3 || rect.height < 1e-3) return;
    const selection = ctx.selectionIds();
    const maskTargetId = selection.length === 1 ? selection[0] : undefined;
    if (maskTargetId) {
      // Create a Path mask. We need to convert the rect/ellipse to BezierPoint[].
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const rx = rect.width / 2;
      const ry = rect.height / 2;
      let localPoints: BezierPoint[] = [];
      if (this.kind === 'Rectangle') {
        localPoints = [
          bezierCorner(rect.x - cx, rect.y - cy),
          bezierCorner(rect.x + rect.width - cx, rect.y - cy),
          bezierCorner(rect.x + rect.width - cx, rect.y + rect.height - cy),
          bezierCorner(rect.x - cx, rect.y + rect.height - cy)
        ];
      } else {
        // Ellipse
        const k = 0.5522848;
        localPoints = [
          { x: 0, y: -ry, inX: -rx * k, inY: -ry, outX: rx * k, outY: -ry },
          { x: rx, y: 0, inX: rx, inY: -ry * k, outX: rx, outY: ry * k },
          { x: 0, y: ry, inX: rx * k, inY: ry, outX: -rx * k, outY: ry },
          { x: -rx, y: 0, inX: -rx, inY: ry * k, outX: -rx, outY: -ry * k },
        ];
      }
      ctx.execute(commands.createNode('Path', rect, localPoints, maskTargetId));
    }
    ctx.requestRender();
  }
}

export class MaskRectangleTool extends CreateMaskShapeTool {
  readonly id = 'mask-rect';
  readonly label = 'Rectangle Mask';
  readonly kind = 'Rectangle';
  readonly shortcut = '';
}

export class MaskEllipseTool extends CreateMaskShapeTool {
  readonly id = 'mask-ellipse';
  readonly label = 'Ellipse Mask';
  readonly kind = 'Ellipse';
  readonly shortcut = '';
}

// ── Pen (AE-style bezier path builder) ──────────────────────────
export class PenTool implements Tool {
  readonly id = 'pen';
  readonly label = 'Pen';
  readonly shortcut = 'g';
  readonly cursor = 'pen' as const;

  /** Committed bezier points in WORLD space (converted to local on finish). */
  private points: BezierPoint[] = [];
  /** Preview: mouse position for rubber-band display. */
  private mouse: Vec2 | null = null;
  /** Drag state: we're pulling the tangent for the most recent point. */
  private draggingHandle = false;

  deactivate(ctx: ToolContext): void {
    // Switching tools mid-draw should KEEP the path, not silently discard it —
    // commit whatever has been drawn so far (finish() no-ops for < 2 points).
    this.finish(ctx);
    this.mouse = null;
    this.draggingHandle = false;
  }

  /** Expose pending bezier path so the Workspace can draw a live preview. */
  get pendingPoints(): readonly BezierPoint[] {
    return this.points;
  }

  /** Current mouse position for rubber-banding. */
  get pendingMouse(): Vec2 | null {
    return this.mouse;
  }

  onPointerMove(e: ToolPointerEvent, _ctx: ToolContext): void {
    this.mouse = e.world;
  }

  onPointerDown(e: ToolPointerEvent, _ctx: ToolContext): void {
    // We commit the new point on pointer-down, and set draggingHandle=true
    // so that onDrag can stretch the out-handle.
    this.points.push(bezierCorner(e.world.x, e.world.y));
    this.draggingHandle = true;
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    this.draggingHandle = false;
    ctx.requestRender();
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.draggingHandle || this.points.length === 0) return;
    const last = this.points[this.points.length - 1]!;
    // Out-handle mirrors in-handle (smooth symmetric bezier like AE)
    const dx = e.currentWorld.x - last.x;
    const dy = e.currentWorld.y - last.y;
    this.points[this.points.length - 1] = {
      ...last,
      outX: last.x + dx,
      outY: last.y + dy,
      inX:  last.x - dx,
      inY:  last.y - dy,
    };
    ctx.requestRender();
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    this.draggingHandle = false;
    ctx.requestRender();
  }

  onDoubleClick(_e: ToolPointerEvent, ctx: ToolContext): void {
    // Remove the extra point added by the click part of doubleclick
    if (this.points.length > 0) this.points.pop();
    this.finish(ctx);
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): void {
    if (e.key === 'Enter') this.finish(ctx);
    else if (e.key === 'Escape') {
      this.points = [];
      this.mouse = null;
      ctx.requestRender();
    }
  }

  private finish(ctx: ToolContext): void {
    if (this.points.length >= 2) {
      const bounds = R.bounds(this.points.map((p) => R.rect(p.x, p.y, 0, 0))) ?? R.rect();
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      const localPoints: BezierPoint[] = this.points.map((p) => ({
        x: p.x - cx, y: p.y - cy,
        inX: p.inX - cx, inY: p.inY - cy,
        outX: p.outX - cx, outY: p.outY - cy,
      }));
      // If exactly one node is selected, create this path as a mask for it
      const selection = ctx.selectionIds();
      const maskTargetId = selection.length === 1 ? selection[0] : undefined;
      ctx.execute(commands.createNode('Path', bounds, localPoints, maskTargetId));
    }
    this.points = [];
    ctx.requestRender();
  }
}

// ── Freehand pencil (drag to scribble an open stroked path) ─────────
export class PencilTool implements Tool {
  readonly id = 'pencil';
  readonly label = 'Pencil';
  readonly shortcut = 'n';
  readonly cursor = 'pen' as const;

  private pts: Vec2[] = [];
  private drawing = false;

  /** Live preview via the shared overlay (drawn as connected segments). */
  get pendingPoints(): readonly BezierPoint[] {
    return this.pts.map((p) => bezierCorner(p.x, p.y));
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    this.drawing = true;
    this.pts = [{ x: e.startWorld.x, y: e.startWorld.y }];
    ctx.requestRender();
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.drawing) return;
    const last = this.pts[this.pts.length - 1]!;
    // Drop near-duplicate samples so the path isn't needlessly dense.
    if (Math.hypot(e.currentWorld.x - last.x, e.currentWorld.y - last.y) >= 2) {
      this.pts.push({ x: e.currentWorld.x, y: e.currentWorld.y });
      ctx.requestRender();
    }
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    this.commit(ctx);
  }

  deactivate(ctx: ToolContext): void {
    this.commit(ctx);
  }

  private commit(ctx: ToolContext): void {
    if (this.pts.length >= 2) {
      const simplified = simplifyPath(this.pts, 1.5);
      const bounds = R.bounds(simplified.map((p) => R.rect(p.x, p.y, 0, 0))) ?? R.rect();
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      const local = simplified.map((p) => bezierCorner(p.x - cx, p.y - cy));
      ctx.execute(commands.createNode('Pencil', bounds, local));
    }
    this.pts = [];
    this.drawing = false;
    ctx.requestRender();
  }
}

// ── Line (drag a single straight stroked segment) ───────────────────
export class LineTool implements Tool {
  readonly id = 'line';
  readonly label = 'Line';
  readonly shortcut = 'l';
  readonly cursor = 'crosshair' as const;

  private start: Vec2 | null = null;
  private end: Vec2 | null = null;

  get pendingPoints(): readonly BezierPoint[] {
    if (!this.start || !this.end) return [];
    return [bezierCorner(this.start.x, this.start.y), bezierCorner(this.end.x, this.end.y)];
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    this.start = { x: e.startWorld.x, y: e.startWorld.y };
    this.end = { x: e.currentWorld.x, y: e.currentWorld.y };
    ctx.requestRender();
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.start) return;
    this.end = { x: e.currentWorld.x, y: e.currentWorld.y };
    ctx.requestRender();
  }

  onDragEnd(e: ToolDragEvent, ctx: ToolContext): void {
    if (this.start) {
      const a = this.start;
      const b = { x: e.currentWorld.x, y: e.currentWorld.y };
      if (Math.hypot(b.x - a.x, b.y - a.y) >= 1) {
        const bounds = R.fromPoints(a, b);
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y + bounds.height / 2;
        const local = [bezierCorner(a.x - cx, a.y - cy), bezierCorner(b.x - cx, b.y - cy)];
        ctx.execute(commands.createNode('Line', bounds, local));
      }
    }
    this.start = null;
    this.end = null;
    ctx.requestRender();
  }

  deactivate(): void {
    this.start = null;
    this.end = null;
  }
}

// ── Polygon / Star (drag to size a regular filled shape) ────────────
abstract class CreatePolyTool implements Tool {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly kind: string;
  abstract readonly shortcut: string;
  readonly cursor = 'crosshair' as const;

  private rect: Rect | null = null;

  /** WORLD-space outline for the given centre + radii. */
  protected abstract makePoints(cx: number, cy: number, rx: number, ry: number): BezierPoint[];

  get pendingPoints(): readonly BezierPoint[] {
    if (!this.rect) return [];
    const cx = this.rect.x + this.rect.width / 2;
    const cy = this.rect.y + this.rect.height / 2;
    const pts = this.makePoints(cx, cy, Math.max(this.rect.width / 2, 1), Math.max(this.rect.height / 2, 1));
    // Close the preview loop so it reads as a full shape.
    return pts.length ? [...pts, pts[0]!] : pts;
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    this.rect = R.fromPoints(e.startWorld, e.currentWorld);
    ctx.requestRender();
  }

  onDragEnd(e: ToolDragEvent, ctx: ToolContext): void {
    const rect = R.fromPoints(e.startWorld, e.currentWorld);
    this.rect = null;
    this.commit(rect.width < 2 || rect.height < 2 ? R.fromCenter(e.currentWorld, DEFAULT_CREATE_SIZE, DEFAULT_CREATE_SIZE) : rect, ctx);
  }

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    this.commit(R.fromCenter(e.world, DEFAULT_CREATE_SIZE, DEFAULT_CREATE_SIZE), ctx);
  }

  private commit(rect: Rect, ctx: ToolContext): void {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const world = this.makePoints(cx, cy, Math.max(rect.width / 2, 1), Math.max(rect.height / 2, 1));
    const local = world.map((p) => ({
      x: p.x - cx, y: p.y - cy,
      inX: p.inX - cx, inY: p.inY - cy,
      outX: p.outX - cx, outY: p.outY - cy,
    }));
    ctx.execute(commands.createNode(this.kind, rect, local));
    ctx.requestRender();
  }
}

export class PolygonTool extends CreatePolyTool {
  readonly id = 'polygon';
  readonly label = 'Polygon';
  readonly kind = 'Polygon';
  readonly shortcut = '';
  protected makePoints(cx: number, cy: number, rx: number, ry: number): BezierPoint[] {
    const pts: BezierPoint[] = [];
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
      pts.push(bezierCorner(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
    }
    return pts;
  }
}

export class StarTool extends CreatePolyTool {
  readonly id = 'star';
  readonly label = 'Star';
  readonly kind = 'Star';
  readonly shortcut = '';
  protected makePoints(cx: number, cy: number, rx: number, ry: number): BezierPoint[] {
    const pts: BezierPoint[] = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const r = i % 2 === 0 ? 1 : 0.42;
      pts.push(bezierCorner(cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r));
    }
    return pts;
  }
}

// ── Curvature pen (click points; curves auto-smooth between them) ────
export class CurvatureTool implements Tool {
  readonly id = 'curvature';
  readonly label = 'Curvature Pen';
  readonly shortcut = '';
  readonly cursor = 'pen' as const;

  private pts: Vec2[] = [];
  private mouse: Vec2 | null = null;

  get pendingPoints(): readonly BezierPoint[] {
    const preview = this.mouse ? [...this.pts, this.mouse] : this.pts;
    return smoothBezier(preview, false);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.mouse = e.world;
    if (this.pts.length > 0) ctx.requestRender();
  }

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    this.pts.push({ x: e.world.x, y: e.world.y });
    ctx.requestRender();
  }

  onDoubleClick(_e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.pts.length > 0) this.pts.pop();
    this.finish(ctx);
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): void {
    if (e.key === 'Enter') this.finish(ctx);
    else if (e.key === 'Escape') {
      this.pts = [];
      this.mouse = null;
      ctx.requestRender();
    }
  }

  deactivate(ctx: ToolContext): void {
    this.finish(ctx);
  }

  private finish(ctx: ToolContext): void {
    if (this.pts.length >= 2) {
      const closed = false;
      const smooth = smoothBezier(this.pts, closed);
      const bounds = R.bounds(smooth.map((p) => R.rect(p.x, p.y, 0, 0))) ?? R.rect();
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      const local = smooth.map((p) => ({
        x: p.x - cx, y: p.y - cy,
        inX: p.inX - cx, inY: p.inY - cy,
        outX: p.outX - cx, outY: p.outY - cy,
      }));
      ctx.execute(commands.createNode('Path', bounds, local));
    }
    this.pts = [];
    this.mouse = null;
    ctx.requestRender();
  }
}

// ── Text ───────────────────────────────────────────────────────────
export class TextTool implements Tool {
  readonly id = 'text';
  readonly label = 'Text';
  readonly shortcut = 't';
  readonly cursor = 'text' as const;

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    const rect = R.rect(e.world.x, e.world.y, 200, 40);
    ctx.execute(commands.createNode('Text', rect));
    ctx.requestRender();
  }
}

// ── Camera (viewport navigation) ───────────────────────────────────
export class CameraTool implements Tool {
  readonly id = 'camera';
  readonly label = 'Camera';
  readonly shortcut = 'c';
  readonly cursor = 'grab' as const;

  private popCursor: (() => void) | null = null;

  onDragStart(_e: ToolDragEvent, ctx: ToolContext): void {
    this.popCursor = ctx.cursor.pushOverride('grabbing');
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    ctx.camera.panByScreen(e.deltaScreen.x, e.deltaScreen.y);
    ctx.requestRender();
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    this.popCursor?.();
    this.popCursor = null;
    ctx.requestRender();
  }
}

export class DirectSelectionTool implements Tool {
  readonly id = 'direct-select';
  readonly label = 'Direct Selection';
  readonly shortcut = 'a';
  readonly cursor = 'default' as const;

  // Drag state
  private dragNodeId: NodeId | null = null;
  private dragKind: 'point' | 'tangent-in' | 'tangent-out' | null = null;
  private dragIndex: number | null = null;
  /** Which vertex is expanded to show tangents */
  private activeVertex: number | null = null;

  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    const handles: OverlayHandle[] = [];
    for (const id of ctx.selectionIds()) {
      const node = ctx.scene.getNode(id);
      if (!node?.pathPoints) continue;
      node.pathPoints.forEach((pt, i) => {
        // Convert local to world
        const wp = Mat.apply(node.worldMatrix, { x: pt.x, y: pt.y });
        handles.push({ id: `vert_${id}_${i}`, position: wp, kind: 'point' });

        // Show tangent handles for the active vertex
        if (this.activeVertex === i) {
          const wIn  = Mat.apply(node.worldMatrix, { x: pt.inX,  y: pt.inY  });
          const wOut = Mat.apply(node.worldMatrix, { x: pt.outX, y: pt.outY });
          handles.push({ id: `tin_${id}_${i}`,  position: wIn,  kind: 'tangent-in'  });
          handles.push({ id: `tout_${id}_${i}`, position: wOut, kind: 'tangent-out' });
        }
      });
    }
    return handles;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const pickRadius = ctx.camera.screenDistanceToWorld(9);
    const handles = this.getHandles(ctx);
    for (const h of handles) {
      if (Math.hypot(h.position.x - e.world.x, h.position.y - e.world.y) < pickRadius) {
        const parts = h.id.split('_');
        this.dragNodeId = parts[1] as NodeId;
        this.dragIndex  = parseInt(parts[2]!, 10);
        if (h.kind === 'point') {
          if (e.modifiers.alt) {
            // Delete the point
            const node = ctx.scene.getNode(this.dragNodeId);
            if (node?.pathPoints && node.pathPoints.length > 2) {
              const pts = [...node.pathPoints];
              pts.splice(this.dragIndex, 1);
              ctx.execute(commands.updateNodePath(this.dragNodeId, pts));
            }
            this.dragNodeId = null;
            this.activeVertex = null;
            ctx.requestRender();
            return;
          }
          this.dragKind = 'point';
          this.activeVertex = this.dragIndex;
        } else if (h.kind === 'tangent-in')  {
          this.dragKind = 'tangent-in';
        } else {
          this.dragKind = 'tangent-out';
        }
        ctx.requestRender();
        return;
      }
    }
    // No handle hit — check for Shift+Click to append a point
    if (e.modifiers.shift && ctx.selectionIds().length === 1) {
      const selectedId = ctx.selectionIds()[0]!;
      const node = ctx.scene.getNode(selectedId);
      if (node?.pathPoints) {
        const inv = Mat.invert(node.worldMatrix);
        const localPt = Mat.apply(inv, e.world);
        const pts = [...node.pathPoints];
        pts.push(bezierCorner(localPt.x, localPt.y));
        ctx.execute(commands.updateNodePath(selectedId, pts));
        ctx.requestRender();
        return;
      }
    }
    // Otherwise, click selects node, clears active vertex
    this.dragNodeId = null;
    this.dragIndex  = null;
    this.dragKind   = null;
    this.activeVertex = null;
    ctx.selection.clickAt(e.world, e.modifiers);
    ctx.requestRender();
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.dragNodeId || this.dragIndex === null || !this.dragKind) return;
    const node = ctx.scene.getNode(this.dragNodeId);
    if (!node?.pathPoints) return;

    const inv = Mat.invert(node.worldMatrix);
    const localPt = Mat.apply(inv, e.currentWorld);
    const pts = node.pathPoints.map((p) => ({ ...p }));
    const pt = pts[this.dragIndex]!;

    if (this.dragKind === 'point') {
      const dx = localPt.x - pt.x;
      const dy = localPt.y - pt.y;
      pt.x += dx;    pt.y += dy;
      pt.inX += dx;  pt.inY += dy;
      pt.outX += dx; pt.outY += dy;
    } else if (this.dragKind === 'tangent-out') {
      pt.outX = localPt.x;
      pt.outY = localPt.y;
      // Mirror in-handle for smooth symmetric bezier (hold Alt to break)
      if (!e.modifiers.alt) {
        const dx = pt.outX - pt.x;
        const dy = pt.outY - pt.y;
        pt.inX = pt.x - dx;
        pt.inY = pt.y - dy;
      }
    } else {
      pt.inX = localPt.x;
      pt.inY = localPt.y;
      if (!e.modifiers.alt) {
        const dx = pt.inX - pt.x;
        const dy = pt.inY - pt.y;
        pt.outX = pt.x - dx;
        pt.outY = pt.y - dy;
      }
    }

    ctx.execute(commands.updateNodePath(this.dragNodeId, pts as BezierPoint[]));
    ctx.requestRender();
  }
}

/** All built-in tools, ready to register with a ToolManager. */
export function createBuiltinTools(): Tool[] {
  return [
    new SelectTool(),
    new DirectSelectionTool(),
    new MoveTool(),
    new HandTool(),
    new ZoomTool(),
    new RectangleTool(),
    new EllipseTool(),
    new MaskRectangleTool(),
    new MaskEllipseTool(),
    new PolygonTool(),
    new StarTool(),
    new LineTool(),
    new PenTool(),
    new PencilTool(),
    new CurvatureTool(),
    new TextTool(),
    new CameraTool(),
  ];
}

// ── Path helpers (freehand simplify + Catmull-Rom smoothing) ────────

/** Perpendicular distance from p to the line through a→b. */
function perpDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Ramer–Douglas–Peucker: thin a dense freehand stroke to its salient points. */
function simplifyPath(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const a = points[s]!;
    const b = points[e]!;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(points[i]!, a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx !== -1) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Convert a polyline into smooth bezier anchors (Catmull-Rom → cubic handles).
 * Each anchor's in/out tangents come from its neighbours, so straight clicks
 * become flowing curves. `closed` wraps the ends around.
 */
function smoothBezier(points: readonly Vec2[], closed: boolean): BezierPoint[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [bezierCorner(points[0]!.x, points[0]!.y)];
  const k = 1 / 6;
  const out: BezierPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    const tx = (next.x - prev.x) * k;
    const ty = (next.y - prev.y) * k;
    out.push({ x: p.x, y: p.y, inX: p.x - tx, inY: p.y - ty, outX: p.x + tx, outY: p.y + ty });
  }
  return out;
}

// ── helpers ────────────────────────────────────────────────────────
function currentSelection(ctx: ToolContext): readonly NodeId[] {
  // The controller exposes bounds; selection ids come from the port it wraps.
  return ctx.selectionIds();
}

function isSelected(ctx: ToolContext, id: NodeId): boolean {
  return currentSelection(ctx).includes(id);
}
