/**
 * Built-in tools. Each is a self-contained, pluggable state machine that acts
 * only through the `ToolContext`. They cover the core editor verbs; a future AI
 * tool registers the same way with zero engine changes.
 *
 *   SelectTool — click-select, shift-toggle, marquee, drag-to-move (+snap)
 *   MoveTool — drag the current selection (no marquee)
 *   RotateTool — drag to spin the selection about its anchor
 *   PanBehindTool — drag to place the anchor without moving the layer
 *   HandTool — pan the camera
 *   ZoomTool — click to zoom (alt = out), drag a region to frame it
 *   RectangleTool — drag to create a rectangle
 *   EllipseTool — drag to create an ellipse
 *   PenTool — click to place path points, double-click to finish
 *   TextTool — click to place a text box
 */

import { offsetAlongNormals, closedRibbon } from '@motion/scene';
import type { Rect } from '../math/Rect';
import * as R from '../math/Rect';
import type { NodeId, OverlayHandle, WorkspaceNode } from '../ports';
import type { Vec2 } from '../math/Vec2';
import type { BezierPoint } from '../math/BezierPoint';
import { corner as bezierCorner } from '../math/BezierPoint';
import { commands } from '../commands/WorkspaceCommands';
import * as Mat from '../math/Mat2D';
import type { HandleId } from '../selection/handles';
import { resizeBounds, resizeBoundsAboutPivot, rotationDelta } from '../selection/transform';
import { handleCursor, visibleHandleIds, CORNER_HANDLES } from '../selection/handles';
import type { CursorType } from '../cursor/CursorManager';
import type { Tool, ToolContext, ToolPointerEvent, ToolDragEvent, ToolKeyEvent } from './Tool';

/** Default size used when a create/text tool is clicked without dragging. */
const DEFAULT_CREATE_SIZE = 100;

/** Screen-pixel radius for grabbing a selection handle. */
const HANDLE_PICK_RADIUS = 9;

/**
 * How far OUTSIDE a corner grip the rotate zone reaches, in screen px.
 *
 * `handles.ts` argues against a rotate GRIP floating off a corner, and it is
 * right: a detached grip creates a dead gap between corner and grip, steals
 * clicks meant for the corner, and breaks the read of "eight symmetric grips".
 * None of those apply to a zone that lives entirely OUTSIDE the box — there is
 * nothing between it and the corner to fall into, it is drawn nowhere, and the
 * grips are untouched.
 *
 * The ordering is what makes it safe: `pickHandle` runs FIRST and wins, so the
 * corner dot keeps every pixel it had. Rotation only sees a press the resize
 * handle already declined. That is the "must not interrupt the resize dot"
 * requirement, expressed as precedence rather than as a gap.
 */
const ROTATE_RING_PX = 26;

// ── Select ─────────────────────────────────────────────────────────
export class SelectTool implements Tool {
  readonly id = 'select';
  readonly label = 'Select';
  readonly shortcut = 'v';
  readonly cursor = 'default' as const;

  private mode: 'idle' | 'marquee' | 'move' | 'resize' | 'rotate' = 'idle';
  private downNodeId: NodeId | null = null;
  private downHandle: HandleId | null = null;
  /** Set on press when the pointer was in a corner's rotate ring. */
  private downRotate = false;
  /** Layer rotation (radians) when a rotate drag began. */
  private startRotation = 0;
  /** Pointer angle about the pivot when a rotate drag began. */
  private startAngle = 0;
  private moveIds: NodeId[] = [];
  private startBounds: Rect | null = null;
  /** Scale at the moment a resize drag began — the base the ratio applies to. */
  private startScale: { x: number; y: number } | null = null;
  /** The layer's own box, unrotated and unscaled — the space resize works in. */
  private startLocalBounds: Rect | null = null;
  /** local to world at drag start. Frozen: it must not follow the live edit. */
  private startMatrix: Mat.Mat2D | null = null;
  private appliedDelta: Vec2 = { x: 0, y: 0 };
  private excludeIds: Set<string> = new Set();
  /** Live drag readout (Δ / size / angle) — see Tool.getHud. */
  private hud: { anchorWorld: Vec2; lines: readonly string[] } | null = null;
  /** Grip under the cursor (idle only) — drives the overlay's lit grip. */
  private hoverHandleId: string | null = null;
  // Transform (single-node) state.
  private transformId: NodeId | null = null;
  private transformPivot: Vec2 = { x: 0, y: 0 };
  private cursorPop: (() => void) | null = null;

  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    const sel = ctx.selectionIds();
    if (sel.length !== 1) {
      // Multi-select: the bounding box still draws (buildOverlay), but the
      // transform handles are single-node only — painting them would offer
      // grips that can't be grabbed, so draw none.
      return [];
    }
    // Degrade with on-screen size: eight 8px grips on a 30px box overlap into
    // an unusable blob. Filtering HERE (rather than in the painter) is what
    // keeps hidden handles from staying grabbable as invisible hit targets —
    // `pickHandle` reads the same list.
    const allowed = new Set(this.visibleIds(ctx));
    const out: OverlayHandle[] = ctx.selection
      .handles()
      .filter((h) => allowed.has(h.id))
      .map((h) => ({ id: h.id, position: h.position, kind: h.kind }));
    // AE always shows the layer's pivot on selection — not only under the
    // Pan-Behind tool. Visual-only here; dragging it still needs Y. Drawn as a
    // crosshair, never a square, so it cannot be mistaken for a resize grip.
    const node = ctx.scene.getNode(sel[0]!);
    if (node) out.push({ id: `anchor_${sel[0]!}`, position: anchorWorld(node), kind: 'anchor' });
    return out;
  }

  /** Handle ids large enough to show at the current zoom. */
  private visibleIds(ctx: ToolContext): readonly HandleId[] {
    const b = ctx.selection.selectionBounds();
    if (!b) return [];
    // screenDistanceToWorld is the inverse of what we need (world px per
    // screen px), so invert it to get screen px per world unit.
    const perWorld = 1 / Math.max(1e-9, ctx.camera.screenDistanceToWorld(1));
    return visibleHandleIds(b.width * perWorld, b.height * perWorld);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    // A handle grab (single selection) takes priority over hit-testing nodes.
    this.downHandle = this.pickHandle(e.screen, ctx);
    // Resize wins. The rotate ring only ever sees a press the corner grip has
    // already declined, which is what keeps the grip's hit area intact.
    this.downRotate = !this.downHandle && this.inRotateRing(e.screen, ctx);
    this.downNodeId =
      this.downHandle || this.downRotate ? null : ctx.hitTester.hitTest(e.world)?.id ?? null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    // Hover feedback over handles: the matching resize cursor, ROTATED to match
    // the layer. A corner grip on a 45-degree layer showing the unrotated
    // diagonal promises an axis the drag will not follow.
    if (this.mode !== 'idle') return;
    const handle = this.pickHandle(e.screen, ctx);
    // Feed the overlay too, so the grip itself lights up — cursor-only hover
    // reads as "maybe" where a lit grip reads as "grabbable" (the 3D gizmo's
    // handles have highlighted on hover all along; the 2D grips never did).
    if (handle !== this.hoverHandleId) {
      this.hoverHandleId = handle;
      ctx.requestRender();
    }
    this.cursorPop?.();
    if (handle) {
      this.cursorPop = ctx.cursor.pushOverride(
        handleCursor(handle, this.selectionRotation(ctx)) as CursorType,
      );
      return;
    }
    // Just outside a corner: the rotate cursor, so the gesture is discoverable
    // by hovering rather than by knowing it exists.
    this.cursorPop = this.inRotateRing(e.screen, ctx)
      ? ctx.cursor.pushOverride('rotate' as CursorType)
      : null;
  }

  /** Grip under the cursor while idle — the overlay lights it up. */
  hoveredHandleId(): string | null {
    return this.hoverHandleId;
  }

  /** Rotation (radians) of the single selected layer, 0 for anything else. */
  private selectionRotation(ctx: ToolContext): number {
    const sel = ctx.selectionIds();
    if (sel.length !== 1) return 0;
    const n = ctx.scene.getNode(sel[0]!);
    return n ? Math.atan2(n.worldMatrix.b, n.worldMatrix.a) : 0;
  }

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    // Clicking a handle (no drag) shouldn't change the selection.
    // Clicking a handle OR the rotate ring (no drag) must not change the
    // selection — a click just outside a corner is a rotation the user thought
    // better of, not a click on the empty canvas behind it.
    if (this.downHandle || this.downRotate) return;
    ctx.selection.clickAt(e.world, e.modifiers);
    ctx.requestRender();
  }

  onDoubleClick(e: ToolPointerEvent, ctx: ToolContext): void {
    // Drill into a group: a single click selects the whole group (so it moves as
    // one body), but double-click reaches past that to the individual part under
    // the cursor so it can be edited — recolour one shape of an SVG icon or a
    // UI-kit component. Figma/Illustrator "enter group" behaviour.
    const hit = ctx.hitTester.hitTest(e.world);
    if (hit) {
      ctx.selection.selectExact(hit.id);
      ctx.requestRender();
    }
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    const sel = currentSelection(ctx);
    // Drag from just outside a corner → rotate, no tool change needed.
    //
    // Pivots on the ANCHOR, exactly as `RotateTool` does. That is not a detail:
    // the anchor is what keyframed rotation revolves around, so pivoting on
    // anything else here would make a drag and an equivalent keyframe disagree
    // about where the layer ends up.
    if (this.downRotate && sel.length === 1) {
      this.transformId = sel[0]!;
      const rn = ctx.scene.getNode(this.transformId);
      if (rn) {
        this.mode = 'rotate';
        this.transformPivot = anchorWorld(rn);
        this.startRotation = Math.atan2(rn.worldMatrix.b, rn.worldMatrix.a);
        this.startAngle = Math.atan2(
          e.startWorld.y - this.transformPivot.y,
          e.startWorld.x - this.transformPivot.x,
        );
        return;
      }
    }
    // Handle drag → resize the single selected node.
    if (this.downHandle && sel.length === 1) {
      this.transformId = sel[0]!;
      this.startBounds = ctx.selection.selectionBounds();
      this.mode = 'resize';
      const rn = ctx.scene.getNode(this.transformId);
      // The LAYER's own frame at the moment the drag began. The grips sit on
      // the oriented box now (`orientedHandles`), so `nw` means the layer's
      // top-left rather than the world's -- and the maths has to agree, or the
      // handle would sit in one place and act in another.
      this.startLocalBounds = rn?.localBounds ?? null;
      this.startMatrix = rn ? { ...rn.worldMatrix } : null;
      // Scale happens about the ANCHOR — the one point the renderer leaves
      // fixed when Scale changes (`position + R*S*(local - anchor)`). Scaling
      // about the opposite corner instead moves Position as a side effect, so a
      // handle drag and a keyframed scale of the same magnitude disagree.
      this.transformPivot = rn
        ? anchorWorld(rn)
        : this.startBounds
          ? R.center(this.startBounds)
          : e.startWorld;
      // Capture the scale the drag starts from, so the drag can be applied as
      // a RATIO. Derived from the world matrix because that is what the
      // selection box was measured in; for an unparented layer it equals the
      // node's own scaleX/scaleY.
      this.startScale = rn
        ? { x: Math.hypot(rn.worldMatrix.a, rn.worldMatrix.b), y: Math.hypot(rn.worldMatrix.c, rn.worldMatrix.d) }
        : { x: 1, y: 1 };
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
    if (this.mode === 'rotate' && this.transformId && this.transformPivot) {
      // Angle DELTA from where the drag began, not the raw pointer angle —
      // otherwise the layer snaps to point at the cursor on the first pixel of
      // movement instead of turning with it.
      const angle = Math.atan2(
        e.currentWorld.y - this.transformPivot.y,
        e.currentWorld.x - this.transformPivot.x,
      );
      let next = this.startRotation + (angle - this.startAngle);
      // Shift = 15° increments, the same constraint the Rotate tool uses.
      if (e.modifiers.shift) {
        const step = Math.PI / 12;
        next = Math.round(next / step) * step;
      }
      {
        // Normalized to (-180, 180] so a long spin reads like AE's rotation
        // property rather than an odometer.
        let deg = ((next * 180) / Math.PI) % 360;
        if (deg > 180) deg -= 360;
        if (deg <= -180) deg += 360;
        this.hud = { anchorWorld: e.currentWorld, lines: [`${deg.toFixed(1)}°`] };
      }
      ctx.execute(commands.rotateNode(this.transformId, next, this.transformPivot));
      ctx.requestRender();
      return;
    }
    if (this.mode === 'resize' && this.transformId && this.startBounds && this.downHandle) {
      const base = this.startScale ?? { x: 1, y: 1 };

      /*
       * Resize runs in the LAYER's local frame.
       *
       * It used to run in world axis-aligned bounds. That was survivable while
       * the grips were axis-aligned too, but they now sit on the layer's
       * oriented box — so dragging the visual `nw` corner of a 30-degree layer
       * has to widen it along ITS axis, not along world x. That same drag also
       * changes the world AABB's other dimension, so in the old space a pure
       * sideways pull silently resized both.
       *
       * Local space makes the handle honest: map the pointer through the
       * inverse of the start matrix, resize there, and the ratio comes out in
       * the layer's own units. `resizeRotated.test.ts` pins that ratio contract
       * and is space-agnostic, so it still holds.
       */
      if (this.startLocalBounds && this.startMatrix && this.startLocalBounds.width > 0) {
        const inv = Mat.invert(this.startMatrix);
        const pointerLocal = Mat.apply(inv, e.currentWorld);
        const from = this.startLocalBounds;

        // Alt keeps its old meaning: scale about the BOX CENTRE rather than the
        // anchor, so the modifier still does something distinct.
        const pivotLocal = e.modifiers.alt
          ? { x: from.x + from.width / 2, y: from.y + from.height / 2 }
          : Mat.apply(inv, this.transformPivot ?? e.startWorld);

        const local = e.modifiers.alt
          ? resizeBounds(from, this.downHandle, pointerLocal, true, undefined, e.modifiers.shift)
          : resizeBoundsAboutPivot(
              from, this.downHandle, pointerLocal, pivotLocal, undefined, e.modifiers.shift,
            );

        /*
         * Ctrl (⌘ on macOS) switches the drag from SCALE to SIZE.
         *
         * Both make the layer bigger on screen; they differ in which property
         * records it, and that difference is real — Size reflows a text box and
         * re-cuts a solid, where Scale stretches whatever was already drawn.
         * Scale stays the default because this editor's muscle memory is After
         * Effects', where a corner handle is Scale and Scale is what you
         * keyframe; Ctrl is for the Figma/Illustrator reflex of resizing the
         * thing itself.
         *
         * The geometry is IDENTICAL either way — same pivot, same new box — so
         * the gesture feels the same and only the numbers land elsewhere. In
         * size mode Scale is left exactly as the drag found it, so one gesture
         * never writes both and the two can never disagree about how big the
         * layer is.
         */
        const resizesSize = e.modifiers.mod;
        const scale = resizesSize
          ? base
          : {
              x: base.x * (local.width / from.width),
              y: from.height > 0 ? base.y * (local.height / from.height) : base.y,
            };

        /*
         * Where the resized box's centre lands in the world.
         *
         * The renderer places a layer as `pos + R*S*(local - anchor)`, and
         * scaling about the pivot leaves the PIVOT's world position fixed. So
         * the new centre is the pivot's world point, plus the local offset from
         * pivot to centre, scaled by the NEW scale and turned by the layer's
         * rotation. Pushing the new centre through the START matrix instead
         * would apply the OLD scale, and the box would creep a little further
         * on every tick.
         */
        const m = this.startMatrix;
        const rot = Math.atan2(m.b, m.a);
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const cl = { x: local.x + local.width / 2, y: local.y + local.height / 2 };
        const d = { x: (cl.x - pivotLocal.x) * scale.x, y: (cl.y - pivotLocal.y) * scale.y };
        const pivotWorld = e.modifiers.alt
          ? Mat.apply(m, pivotLocal)
          : (this.transformPivot ?? e.startWorld);
        const center = {
          x: pivotWorld.x + d.x * cos - d.y * sin,
          y: pivotWorld.y + d.x * sin + d.y * cos,
        };

        // `bounds` is only the fallback for callers that send no scale, so it
        // carries the new size around the new centre rather than a second
        // derivation that could disagree with the one above.
        const w = Math.abs(local.width * scale.x);
        const h = Math.abs(local.height * scale.y);
        const bounds = R.rect(center.x - w / 2, center.y - h / 2, w, h);
        // The new box in the layer's OWN units — which is what its width/height
        // are. Only sent in size mode; the handler falls back to scaling when
        // the layer has no authored size to write (an image, a video, a precomp).
        const size = resizesSize ? { x: local.width, y: local.height } : undefined;
        // Size mode reads in the layer's own units (what it writes); scale
        // mode reads as the Scale percentage the drag is recording.
        this.hud = {
          anchorWorld: e.currentWorld,
          lines: resizesSize
            ? [`${Math.round(local.width)} × ${Math.round(local.height)}`]
            : [`${Math.round(scale.x * 100)}% × ${Math.round(scale.y * 100)}%`],
        };
        ctx.execute(commands.resizeNode(this.transformId, bounds, scale, center, size));
        ctx.requestRender();
        return;
      }

      // No local box to work in (a node kind that reports none). Falls back to
      // the world-AABB path every layer used before, still correct unrotated.
      // (HUD set below, after the new bounds exist.)
      const bounds = e.modifiers.alt
        ? resizeBounds(this.startBounds, this.downHandle, e.currentWorld, true, undefined, e.modifiers.shift)
        : resizeBoundsAboutPivot(
            this.startBounds,
            this.downHandle,
            e.currentWorld,
            this.transformPivot,
            undefined,
            e.modifiers.shift,
          );
      const from = this.startBounds;
      const scale = {
        x: from.width > 0 ? base.x * (bounds.width / from.width) : base.x,
        y: from.height > 0 ? base.y * (bounds.height / from.height) : base.y,
      };
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      this.hud = {
        anchorWorld: e.currentWorld,
        lines: [`${Math.round(bounds.width)} × ${Math.round(bounds.height)}`],
      };
      ctx.execute(commands.resizeNode(this.transformId, bounds, scale, center));
      ctx.requestRender();
      return;
    }
    if (this.mode === 'move' && this.startBounds && this.moveIds.length) {
      let total = e.totalWorld;
      /*
       * Shift = axis lock (AE/Figma/Illustrator): the move constrains to the
       * DOMINANT axis of the total travel, re-evaluated live so crossing the
       * 45° diagonal flips the lock — hold Shift and steer, no release
       * needed. Applied before snapping, and the locked axis is re-zeroed
       * after it, so a guide on the free axis still snaps while the locked
       * axis cannot be dragged off zero by a nearby target.
       */
      const lockAxis = e.modifiers.shift
        ? (Math.abs(total.x) >= Math.abs(total.y) ? 'x' : 'y')
        : null;
      if (lockAxis === 'x') total = { x: total.x, y: 0 };
      else if (lockAxis === 'y') total = { x: 0, y: total.y };
      const movedBounds = R.translate(this.startBounds, total);
      /*
       * Ctrl/Cmd SUSPENDS snapping for as long as it is held.
       *
       * A snap is a teleport twice over: the layer lurches onto the target when
       * the pointer comes within the threshold, sits still for the ~12px the
       * pointer crosses that band, and lurches off again on the far side. That
       * is what "a few drag movements resemble jumping" is — motion stopping
       * and then catching up, not a dropped frame. It is also the correct
       * behaviour for a magnet, so the fix is an escape hatch (the same one
       * Figma and Illustrator bind) plus a tighter band, not a magnet that
       * cannot hold.
       */
      const snap = e.modifiers.mod
        ? { delta: { x: 0, y: 0 }, lines: [] }
        : ctx.snapRect(movedBounds, this.excludeIds);
      total = { x: total.x + snap.delta.x, y: total.y + snap.delta.y };
      // Locked axis stays locked — see the Shift note above.
      if (lockAxis === 'x') total = { x: total.x, y: 0 };
      else if (lockAxis === 'y') total = { x: 0, y: total.y };
      const inc = { x: total.x - this.appliedDelta.x, y: total.y - this.appliedDelta.y };
      if (inc.x !== 0 || inc.y !== 0) {
        ctx.execute(commands.moveNodes(this.moveIds, inc));
        this.appliedDelta = total;
      }
      const fmt = (v: number): string => `${v >= 0 ? '+' : ''}${Math.round(v)}`;
      this.hud = { anchorWorld: e.currentWorld, lines: [`${fmt(total.x)}, ${fmt(total.y)}`] };
      ctx.setSnapLines(snap.lines);
      ctx.requestRender();
    }
  }

  getHud(): { anchorWorld: Vec2; lines: readonly string[] } | null {
    return this.hud;
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    if (this.mode === 'marquee') {
      ctx.selection.endMarquee(_e.modifiers);
    }
    ctx.setSnapLines([]);
    this.hud = null;
    this.mode = 'idle';
    this.downNodeId = null;
    this.downHandle = null;
    // Left set, a stale `downRotate` makes the NEXT plain click on the canvas
    // silently refuse to change the selection (see `onClick`).
    this.downRotate = false;
    this.transformId = null;
    this.startBounds = null;
    this.startLocalBounds = null;
    this.startMatrix = null;
    this.moveIds = [];
    ctx.requestRender();
  }

  deactivate(): void {
    this.cursorPop?.();
    this.cursorPop = null;
  }

  /** Which selection handle is under a screen point, if any. */
  /**
   * True when `screen` is in a corner's rotate ring: near a corner, and further
   * from the box centre than that corner is.
   *
   * The "further from the centre" half is what makes this OUTSIDE-only, and it
   * is expressed as a distance comparison rather than as a rectangle test on
   * purpose — a rotated layer's corners are not axis-aligned, so an AABB test
   * would put the zone in the wrong place for exactly the layers most likely to
   * be rotated again.
   *
   * Requires the corner to be VISIBLE (`visibleIds`): on a box too small to draw
   * grips, a rotate zone hovering around it would be a gesture with nothing on
   * screen to explain it.
   */
  private inRotateRing(screen: Vec2, ctx: ToolContext): boolean {
    if (ctx.selectionIds().length !== 1) return false;
    const bounds = ctx.selection.selectionBounds();
    if (!bounds) return false;
    const allowed = new Set(this.visibleIds(ctx));
    const centre = ctx.camera.worldToScreen(R.center(bounds));
    const distFromCentre = Math.hypot(screen.x - centre.x, screen.y - centre.y);

    for (const h of ctx.selection.handles()) {
      if (!CORNER_HANDLES.includes(h.id) || !allowed.has(h.id)) continue;
      const s = ctx.camera.worldToScreen(h.position);
      const d = Math.hypot(s.x - screen.x, s.y - screen.y);
      if (d > ROTATE_RING_PX) continue;
      // Outside the corner, not inside the box.
      const cornerFromCentre = Math.hypot(s.x - centre.x, s.y - centre.y);
      if (distFromCentre > cornerFromCentre) return true;
    }
    return false;
  }

  private pickHandle(screen: Vec2, ctx: ToolContext): HandleId | null {
    if (ctx.selectionIds().length !== 1) return null;
    // Only the handles that are actually drawn — an invisible grip that still
    // resizes is worse than no grip at all.
    const allowed = new Set(this.visibleIds(ctx));
    const handles = ctx.selection.handles().filter((h) => allowed.has(h.id));
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

  deactivate(ctx: ToolContext): void {
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
/**
 * The Pen builds a PATH LAYER. It does not quietly turn into a mask tool.
 *
 * It used to: `finish` passed the single selected node as `maskTargetId`, so
 * with one layer selected the drawn path became a MASK on that layer instead of
 * a layer of its own. Two things made that destructive rather than clever:
 *
 *  1. **Every drawing tool selects what it just made** (`ports.ts` createNode
 *     ends with `selection.set([node.id])`). So after drawing anything at all,
 *     exactly one layer is selected — the one you just drew — and the pen was
 *     therefore in mask mode essentially always, without ever being put there.
 *  2. **An `add` mask clips its layer to the mask shape.** So the previous
 *     stroke was cut down to whatever the new path enclosed, and the new path
 *     never appeared as a layer. Both read as "my drawing was deleted", which is
 *     exactly what it looked like.
 *
 * There was no indication of which mode the tool was in and no way to choose.
 * Meanwhile this editor already says how masking is selected: it is a separate
 * TOOL (`mask-rect`, `mask-ellipse`, and now `mask-pen`), never a hidden mode of
 * a drawing tool. So the pen follows that rule like everything else, and the
 * bezier-mask capability keeps a home in `MaskPenTool` below.
 */
export class PenTool implements Tool {
  readonly id: string = 'pen';
  readonly label: string = 'Pen';
  readonly shortcut: string = 'g';
  readonly cursor = 'pen' as const;

  /**
   * When true the finished path becomes a mask on the selected layer instead of
   * a new layer. Only `MaskPenTool` sets it — and it is still gated on a single
   * selection, because a mask needs exactly one layer to belong to.
   */
  protected readonly maskMode: boolean = false;

  /** Committed bezier points in WORLD space (converted to local on finish). */
  private points: BezierPoint[] = [];
  /** Preview: mouse position for rubber-band display. */
  private mouse: Vec2 | null = null;
  /** Drag state: we're pulling the tangent for the most recent point. */
  private draggingHandle = false;

  deactivate(ctx: ToolContext): void {
    // Switching tools mid-draw should KEEP the path, not silently discard it —
    // commit whatever has been drawn so far (finish no-ops for < 2 points).
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

  onPointerLeave(_e: ToolPointerEvent, ctx: ToolContext): void {
    this.mouse = null;
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    // Close by clicking near the first point (AE pen), once we have enough
    // vertices for a real polygon. Threshold is in world px — small enough
    // not to steal intentional nearby clicks, large enough to hit easily.
    if (this.maskMode && this.points.length >= 3) {
      const first = this.points[0]!;
      const dx = e.world.x - first.x;
      const dy = e.world.y - first.y;
      if (dx * dx + dy * dy <= 10 * 10) {
        this.finish(ctx);
        return;
      }
    }
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

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    // Only with an outline in progress. With none, Escape is the viewport's own
    // — clear the selection — and claiming it here would break that everywhere
    // the pen happens to be the active tool.
    if (this.points.length === 0) return false;
    if (e.key === 'Enter') {
      this.finish(ctx);
      return true;
    }
    if (e.key === 'Escape') {
      this.points = [];
      this.mouse = null;
      ctx.requestRender();
      return true;
    }
    return false;
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
      // A mask target ONLY in mask mode. In plain pen mode this is always
      // undefined, so the path is always a layer — see the class comment.
      const selection = ctx.selectionIds();
      const maskTargetId =
        this.maskMode && selection.length === 1 ? selection[0] : undefined;
      ctx.execute(commands.createNode('Path', bounds, localPoints, maskTargetId));
    }
    this.points = [];
    ctx.requestRender();
  }
}

/**
 * The bezier mask tool — the pen, aimed at the selected layer's mask list.
 *
 * This is where the behaviour that used to be hidden inside `PenTool` lives, so
 * nothing was lost by taking it out of there: it is now something the user picks
 * from the mask group beside Rectangle Mask and Ellipse Mask, rather than
 * something that happened to them because a layer was selected.
 *
 * With nothing selected it falls back to creating a path layer, exactly as the
 * pen does — a mask with no layer to belong to is not a thing that can exist,
 * and refusing the stroke would throw away the user's work.
 */
export class MaskPenTool extends PenTool {
  override readonly id = 'mask-pen';
  override readonly label = 'Pen Mask';
  override readonly shortcut = '';
  protected override readonly maskMode = true;
}

// ── Freehand pencil (drag to scribble an open stroked path) ─────────
export class PencilTool implements Tool {
  readonly id = 'pencil';
  readonly label = 'Pencil';
  readonly shortcut = 'n';
  readonly cursor = 'pencil' as const;

  private pts: Vec2[] = [];
  private drawing = false;

  /** Live preview via the shared overlay — smoothed like the final stroke,
   *  so what you see while dragging is what commits. */
  get pendingPoints(): readonly BezierPoint[] {
    return smoothBezier(this.pts, false);
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
      // Catmull-Rom tangents: freehand ink commits as a smooth curve, not the
      // jagged polyline the raw corner points produced.
      const local = smoothBezier(
        simplified.map((p) => ({ x: p.x - cx, y: p.y - cy })),
        false,
      );
      ctx.execute(commands.createNode('Pencil', bounds, local));
    }
    this.pts = [];
    this.drawing = false;
    ctx.requestRender();
  }
}

// ── Brush (pressure-sensitive variable-width ink) ────────────────────

/**
 * Live-tunable options for the drawing tools. A plain mutable singleton so the
 * host app's tool-options bar can drive the framework-free engine without a
 * store dependency; tools read it at draw/commit time.
 */
export const drawToolOptions = {
  /** Brush: stroke width at full pressure (world px). */
  brushSize: 14,
  /** Brush: 0–100, how much of each stroke end tapers to a point. */
  brushTaper: 35,
  /** Brush: scale width by stylus pressure (mouse input reports ~0.5 flat). */
  brushPressure: true,
  /** Brush: ink colour (the committed ribbon's fill). */
  brushColor: '#2b7eff',
  /** Pencil / Line: stroke width (world px). */
  pencilWidth: 4,
  /** Pencil / Line: stroke colour. */
  pencilColor: '#2b7eff',
  /** Polygon tool: number of sides (3–12). */
  polygonSides: 6,
  /** Star tool: number of points (3–12). */
  starPoints: 5,
  /** Star tool: inner/outer radius ratio (0.1–0.9). */
  starInnerRatio: 0.42,
};

interface BrushSample extends Vec2 {
  pressure: number;
}

/**
 * Stylus pressure that should paint exactly `brushSize`.
 *
 * Raw pressure used to be a direct multiplier, so the configured size was only
 * ever reached by pressing all the way down — every normal stroke came out
 * thinner than advertised. Normalising against the neutral value makes "Size:
 * 14 px" mean 14 px, with lighter/heavier pressure deviating around it.
 */
const NEUTRAL_PRESSURE = 0.5;

/**
 * Build the closed outline of a variable-width stroke: offset each centreline
 * point along its normal by half the local width (pressure × taper), walk the
 * left side forward and the right side back. Returned smoothed, so the ink
 * commits as flowing curves.
 */
export function ribbonOutline(samples: readonly BrushSample[], size: number, taperPct: number, usePressure: boolean): BezierPoint[] {
  if (samples.length < 2) return [];

  // Densify a 2–3 sample flick before building the taper profile.
  //
  // The taper ramps from 0 at each end to full width in the middle. With only
  // two samples there IS no middle sample: both points sit at taper 0, get
  // clamped to the 0.05 floor, and the whole stroke collapses to the width floor
  // — a hairline instead of a mark. Any quick flick produced one. Interpolating
  // gives the profile somewhere to reach full width. Strokes of 4+ samples
  // already have an interior point and are left untouched.
  const MIN_SAMPLES = 9;
  let work: BrushSample[] = [...samples];
  if (work.length < 4) {
    const dense: BrushSample[] = [];
    const segs = work.length - 1;
    const per = Math.ceil((MIN_SAMPLES - 1) / segs);
    for (let s = 0; s < segs; s++) {
      const a = work[s]!;
      const b = work[s + 1]!;
      for (let k = 0; k < per; k++) {
        const u = k / per;
        dense.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, pressure: a.pressure + (b.pressure - a.pressure) * u });
      }
    }
    dense.push(work[work.length - 1]!);
    work = dense;
  }
  samples = work;
  const n = samples.length;

  // Cumulative arc length for the taper profile.
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    arc.push(arc[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = arc[n - 1]! || 1;
  const taperLen = (Math.max(0, Math.min(100, taperPct)) / 100) * total * 0.5;

  const widthAt = (i: number): number => {
    // Neighbour-averaged pressure — raw stylus pressure is jittery.
    const p0 = samples[Math.max(0, i - 1)]!.pressure;
    const p1 = samples[i]!.pressure;
    const p2 = samples[Math.min(n - 1, i + 1)]!.pressure;
    // Normalized so a stylus at its NEUTRAL pressure paints the size the user
    // set, and only lighter/heavier pressure deviates from it. Raw pressure was
    // used as a direct multiplier, so even a real stylus never reached the
    // configured width unless the user pressed all the way down.
    const p = usePressure
      ? Math.max(0.15, Math.min(1.4, ((p0 + p1 + p2) / 3 || 0.5) / NEUTRAL_PRESSURE))
      : 1;
    let taper = 1;
    if (taperLen > 0) {
      taper = Math.min(1, arc[i]! / taperLen, (total - arc[i]!) / taperLen);
      taper = Math.max(0.05, taper);
    }
    // Floor proportional to the brush, not a fixed half-pixel. A 0.5px absolute
    // floor is invisible for any realistic brush size and is what made tapered
    // ends and short strokes read as a thin outline rather than ink.
    return Math.max(Math.min(size, 0.5), Math.min(size * 1.4, size * p * taper));
  };

  // The offset walk itself now lives in `@motion/scene` (DECISION D4): it is the
  // same arithmetic stroke taper and variable-width feather need, and leaving it
  // here would make the rasterizer depend on the interaction package. Everything
  // ABOVE this line — pressure normalisation, the arc-length taper profile, the
  // width floor and the 1.4x clamp — stays, because it is brush policy rather
  // than geometry.
  //
  // `widthAt` is a WIDTH and the primitive takes a DISTANCE, hence the halving.
  return smoothBezier(closedRibbon(offsetAlongNormals(samples, (i) => widthAt(i) / 2)), true);
}

/**
 * Freehand ink with pressure-driven width and end tapers — commits as a FILLED
 * closed ribbon (the Pencil stays the uniform-width stroked line).
 */
export class BrushTool implements Tool {
  readonly id = 'brush';
  readonly label = 'Brush';
  readonly shortcut = '';
  readonly cursor = 'brush' as const;

  private pts: BrushSample[] = [];
  private drawing = false;
  /**
   * Whether THIS stroke came from a stylus.
   *
   * Pressure must only modulate width for a real pen. A mouse reports a flat
   * 0.5 (Chromium) or 0, and the Pressure option defaults ON — so with a mouse
   * every stroke was silently painted at half the configured size, and a fast
   * flick collapsed to a hairline. Gating on the device, not on the number,
   * keeps genuine stylus sensitivity intact (including a deliberately light,
   * constant-pressure stroke) while a mouse always paints the size that is set.
   */
  private isPen = false;

  private get pressureActive(): boolean {
    return drawToolOptions.brushPressure && this.isPen;
  }

  /** Live preview: the actual ribbon outline (painted filled by the host). */
  get pendingPoints(): readonly BezierPoint[] {
    const o = drawToolOptions;
    return ribbonOutline(this.pts, o.brushSize, o.brushTaper, this.pressureActive);
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    this.drawing = true;
    this.isPen = e.pointer.pointerType === 'pen';
    this.pts = [{ x: e.startWorld.x, y: e.startWorld.y, pressure: e.pointer.pressure }];
    ctx.requestRender();
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.drawing) return;
    const last = this.pts[this.pts.length - 1]!;
    if (Math.hypot(e.currentWorld.x - last.x, e.currentWorld.y - last.y) >= 2) {
      this.pts.push({ x: e.currentWorld.x, y: e.currentWorld.y, pressure: e.pointer.pressure });
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
      // Simplify the CENTERLINE (keeping pressure by index) then outline it.
      const keepIdx = simplifyPathIndices(this.pts, 1.25);
      const centre = keepIdx.map((i) => this.pts[i]!);
      const o = drawToolOptions;
      const outline = ribbonOutline(centre, o.brushSize, o.brushTaper, this.pressureActive);
      if (outline.length >= 3) {
        const bounds = R.bounds(outline.map((p) => R.rect(p.x, p.y, 0, 0))) ?? R.rect();
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y + bounds.height / 2;
        const local = outline.map((p) => ({
          x: p.x - cx, y: p.y - cy,
          inX: p.inX - cx, inY: p.inY - cy,
          outX: p.outX - cx, outY: p.outY - cy,
        }));
        ctx.execute(commands.createNode('Brush', bounds, local));
      }
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
    const sides = Math.max(3, Math.min(12, Math.round(drawToolOptions.polygonSides)));
    const pts: BezierPoint[] = [];
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (i / sides) * Math.PI * 2;
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
    const points = Math.max(3, Math.min(12, Math.round(drawToolOptions.starPoints)));
    const inner = Math.max(0.1, Math.min(0.9, drawToolOptions.starInnerRatio));
    const total = points * 2;
    const pts: BezierPoint[] = [];
    for (let i = 0; i < total; i++) {
      const a = -Math.PI / 2 + (i / total) * Math.PI * 2;
      const r = i % 2 === 0 ? 1 : inner;
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

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    // See PenTool.onKeyDown — claimed only while there is a draft to act on.
    if (this.pts.length === 0) return false;
    if (e.key === 'Enter') {
      this.finish(ctx);
      return true;
    }
    if (e.key === 'Escape') {
      this.pts = [];
      this.mouse = null;
      ctx.requestRender();
      return true;
    }
    return false;
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

// ── Rotate (AE: W) ─────────────────────────────────────────────────
/**
 * Drag anywhere to spin the selected layer about its anchor point. AE keeps
 * rotation on its own tool so that dragging near a corner scales rather than
 * rotates; the Select tool's corner rotate-handle stays available too.
 */
export class RotateTool implements Tool {
  readonly id = 'rotate';
  readonly label = 'Rotation';
  readonly shortcut = 'w';
  readonly cursor = 'rotate' as const;

  private rotateId: NodeId | null = null;
  private startRotation = 0;
  private pivot: Vec2 = { x: 0, y: 0 };

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    ctx.selection.clickAt(e.world, e.modifiers);
    ctx.requestRender();
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    if (currentSelection(ctx).length === 0) {
      const hit = ctx.hitTester.hitTest(e.startWorld);
      if (hit) ctx.selection.select(hit.id);
    }
    const sel = currentSelection(ctx);
    // Rotation is a single-node edit, matching the Select tool's rotate handle.
    if (sel.length !== 1) return;
    this.rotateId = sel[0]!;
    const node = ctx.scene.getNode(this.rotateId);
    if (!node) {
      this.rotateId = null;
      return;
    }
    this.pivot = anchorWorld(node);
    this.startRotation = Math.atan2(node.worldMatrix.b, node.worldMatrix.a);
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.rotateId) return;
    const delta = rotationDelta(this.pivot, e.startWorld, e.currentWorld);
    ctx.execute(commands.rotateNode(this.rotateId, this.startRotation + delta, this.pivot));
    ctx.requestRender();
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    this.rotateId = null;
    ctx.requestRender();
  }
}

// ── Pan Behind / Anchor Point (AE: Y) ──────────────────────────────
/**
 * Place a layer's pivot visually, relative to its artwork, instead of typing
 * anchor X/Y. The host compensates position so the layer doesn't jump, which
 * leaves `worldMatrix` invariant — so dragging against the live matrix is
 * stable frame to frame.
 */
export class PanBehindTool implements Tool {
  readonly id = 'pan-behind';
  readonly label = 'Pan Behind (Anchor Point)';
  readonly shortcut = 'y';
  readonly cursor = 'move' as const;

  private dragId: NodeId | null = null;

  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    const out: OverlayHandle[] = [];
    for (const id of ctx.selectionIds()) {
      const node = ctx.scene.getNode(id);
      if (!node) continue;
      out.push({ id: `anchor_${id}`, position: anchorWorld(node), kind: 'anchor' });
    }
    return out;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    // Grabbing the marker itself takes priority over hit-testing the artwork.
    const radius = ctx.camera.screenDistanceToWorld(HANDLE_PICK_RADIUS);
    for (const id of currentSelection(ctx)) {
      const node = ctx.scene.getNode(id);
      if (!node) continue;
      const p = anchorWorld(node);
      if (Math.hypot(p.x - e.world.x, p.y - e.world.y) <= radius) {
        this.dragId = id;
        return;
      }
    }
    this.dragId = null;
  }

  onClick(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.dragId) return;
    ctx.selection.clickAt(e.world, e.modifiers);
    ctx.requestRender();
  }

  onDragStart(e: ToolDragEvent, ctx: ToolContext): void {
    if (this.dragId) return;
    // Dragging the layer body moves its anchor too — AE's behaviour.
    const hit = ctx.hitTester.hitTest(e.startWorld);
    if (!hit) return;
    if (!isSelected(ctx, hit.id)) ctx.selection.select(hit.id);
    this.dragId = hit.id;
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    if (!this.dragId) return;
    const node = ctx.scene.getNode(this.dragId);
    if (!node) return;
    const local = Mat.apply(Mat.invert(node.worldMatrix), e.currentWorld);
    ctx.execute(commands.moveAnchor(this.dragId, local));
    ctx.requestRender();
  }

  onDragEnd(_e: ToolDragEvent, ctx: ToolContext): void {
    this.dragId = null;
    ctx.requestRender();
  }
}

/** World position of a node's pivot. worldMatrix already folds the anchor in. */
function anchorWorld(node: { worldMatrix: Mat.Mat2D; anchor?: Vec2 }): Vec2 {
  return Mat.apply(node.worldMatrix, node.anchor ?? { x: 0, y: 0 });
}

// The CameraTool that used to live here is deleted. It was registered in the
// engine and unreachable from the app: no 'camera' member in the UI Tool
// union, no TOOL_MAP entry. Viewport navigation is served by guidesStore
// cameraTool (orbit/pan/dolly) plus the space-drag transport, so this was a
// second implementation of the same idea that nothing could select.

/** Which outline a handle belongs to: the layer's geometry, or one of its masks. */
interface OutlineRef {
  nodeId: NodeId;
  /** null = the node's own `pathPoints`; otherwise a mask id. */
  maskId: string | null;
  index: number;
  kind: 'point' | 'tangent-in' | 'tangent-out';
}

export class DirectSelectionTool implements Tool {
  readonly id = 'direct-select';
  readonly label = 'Direct Selection';
  readonly shortcut = 'a';
  readonly cursor = 'default' as const;

  /**
   * handle id → what it edits.
   *
   * Handle ids used to encode this and be parsed back with `split('_')`, which
   * silently picked the wrong node for any id containing an underscore (every
   * `comp_root`, every `tab_x`). A map has no such ambiguity — and it carries
   * the mask id, which a positional string couldn't.
   */
  private refs = new Map<string, OutlineRef>();
  private drag: OutlineRef | null = null;
  /** Which vertex is expanded to show tangents, and on which outline. */
  private active: { maskId: string | null; index: number } | null = null;

  /** Every editable outline on a node: its geometry, then each of its masks. */
  private outlinesOf(node: WorkspaceNode): Array<{ maskId: string | null; points: readonly BezierPoint[] }> {
    const out: Array<{ maskId: string | null; points: readonly BezierPoint[] }> = [];
    if (node.pathPoints) out.push({ maskId: null, points: node.pathPoints });
    for (const m of node.maskPaths ?? []) out.push({ maskId: m.id, points: m.points });
    return out;
  }

  private pointsFor(node: WorkspaceNode, maskId: string | null): readonly BezierPoint[] | undefined {
    return maskId === null
      ? node.pathPoints
      : node.maskPaths?.find((m) => m.id === maskId)?.points;
  }

  private commit(ctx: ToolContext, ref: OutlineRef, points: BezierPoint[]): void {
    ctx.execute(
      ref.maskId === null
        ? commands.updateNodePath(ref.nodeId, points)
        : commands.updateMaskPath(ref.nodeId, ref.maskId, points),
    );
  }

  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    this.refs.clear();
    const handles: OverlayHandle[] = [];
    const add = (id: string, position: Vec2, kind: OverlayHandle['kind'], ref: OutlineRef): void => {
      handles.push({ id, position, kind });
      this.refs.set(id, ref);
    };

    for (const id of ctx.selectionIds()) {
      const node = ctx.scene.getNode(id);
      if (!node) continue;
      for (const outline of this.outlinesOf(node)) {
        const scope = outline.maskId ?? 'geom';
        outline.points.forEach((pt, i) => {
          const base = { nodeId: id, maskId: outline.maskId, index: i } as const;
          add(`vert:${id}:${scope}:${i}`, Mat.apply(node.worldMatrix, { x: pt.x, y: pt.y }), 'point', { ...base, kind: 'point' });

          // Tangents only for the active vertex of the active outline.
          if (this.active?.index === i && this.active.maskId === outline.maskId) {
            add(`tin:${id}:${scope}:${i}`, Mat.apply(node.worldMatrix, { x: pt.inX, y: pt.inY }), 'tangent-in', { ...base, kind: 'tangent-in' });
            add(`tout:${id}:${scope}:${i}`, Mat.apply(node.worldMatrix, { x: pt.outX, y: pt.outY }), 'tangent-out', { ...base, kind: 'tangent-out' });
          }
        });
      }
    }
    return handles;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const pickRadius = ctx.camera.screenDistanceToWorld(9);
    const handles = this.getHandles(ctx);
    for (const h of handles) {
      if (Math.hypot(h.position.x - e.world.x, h.position.y - e.world.y) < pickRadius) {
        const ref = this.refs.get(h.id);
        if (!ref) continue;
        if (ref.kind === 'point') {
          if (e.modifiers.alt) {
            // Delete the point.
            const node = ctx.scene.getNode(ref.nodeId);
            const pts = node ? this.pointsFor(node, ref.maskId) : undefined;
            if (pts && pts.length > 2) {
              const next = pts.map((p) => ({ ...p }));
              next.splice(ref.index, 1);
              this.commit(ctx, ref, next);
            }
            this.drag = null;
            this.active = null;
            ctx.requestRender();
            return;
          }
          this.active = { maskId: ref.maskId, index: ref.index };
        }
        this.drag = ref;
        ctx.requestRender();
        return;
      }
    }
    // No handle hit — Shift+Click appends a point to the active outline.
    if (e.modifiers.shift && ctx.selectionIds().length === 1) {
      const selectedId = ctx.selectionIds()[0]!;
      const node = ctx.scene.getNode(selectedId);
      const maskId = this.active?.maskId ?? null;
      const pts = node ? this.pointsFor(node, maskId) : undefined;
      if (node && pts) {
        const inv = Mat.invert(node.worldMatrix);
        const localPt = Mat.apply(inv, e.world);
        const next = [...pts.map((p) => ({ ...p })), bezierCorner(localPt.x, localPt.y)];
        this.commit(ctx, { nodeId: selectedId, maskId, index: next.length - 1, kind: 'point' }, next);
        ctx.requestRender();
        return;
      }
    }
    // Otherwise, click selects node, clears active vertex
    this.drag = null;
    this.active = null;
    ctx.selection.clickAt(e.world, e.modifiers);
    ctx.requestRender();
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    const ref = this.drag;
    if (!ref) return;
    const node = ctx.scene.getNode(ref.nodeId);
    if (!node) return;
    const source = this.pointsFor(node, ref.maskId);
    if (!source) return;

    const inv = Mat.invert(node.worldMatrix);
    const localPt = Mat.apply(inv, e.currentWorld);
    const pts = source.map((p) => ({ ...p }));
    const pt = pts[ref.index];
    if (!pt) return;
    if (ref.kind === 'point') {
      const dx = localPt.x - pt.x;
      const dy = localPt.y - pt.y;
      pt.x += dx;    pt.y += dy;
      pt.inX += dx;  pt.inY += dy;
      pt.outX += dx; pt.outY += dy;
    } else if (ref.kind === 'tangent-out') {
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

    this.commit(ctx, ref, pts as BezierPoint[]);
    ctx.requestRender();
  }
}

/** All built-in tools, ready to register with a ToolManager. */
export function createBuiltinTools(): Tool[] {
  return [
    new SelectTool(),
    new DirectSelectionTool(),
    new MoveTool(),
    new RotateTool(),
    new PanBehindTool(),
    new HandTool(),
    new ZoomTool(),
    new RectangleTool(),
    new EllipseTool(),
    new MaskRectangleTool(),
    new MaskEllipseTool(),
    new MaskPenTool(),
    new PolygonTool(),
    new StarTool(),
    new LineTool(),
    new PenTool(),
    new PencilTool(),
    new BrushTool(),
    new CurvatureTool(),
    new TextTool(),
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

/** RDP simplify returning the KEPT INDICES — for strokes whose points carry
 *  extra per-sample data (brush pressure) that must survive the thinning. */
function simplifyPathIndices(points: readonly Vec2[], tolerance: number): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
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
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(i);
  return out;
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
