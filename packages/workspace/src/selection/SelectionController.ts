/**
 * SelectionController — translates pointer intent into selection changes and
 * computes the selection overlay (bounds + handles). It drives the `SelectionPort`
 * (the app owns selection truth) and reads geometry from the Scene Graph and
 * HitTester. Modifier semantics match professional tools:
 *
 *   plain click        → select topmost (or clear on empty)
 *   shift / mod click  → toggle into the current selection
 *   marquee            → replace (or add with shift) by region
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import * as R from '../math/Rect';
import type { Modifiers } from '../input/events';
import type { NodeId, SceneGraphPort, SelectionPort } from '../ports';
import type { HitTester } from '../hit/HitTester';
import { Marquee, type MarqueeMode } from './Marquee';
import type { Corners } from '../math/OrientedBox';

/**
 * One selected layer's drawn outline, with the layer it belongs to.
 *
 * The id is what lets the painter tint each outline by that layer's label
 * colour, so a selected layer's box matches its timeline row.
 */
export interface SelectionBox {
  id: NodeId;
  corners: Corners;
}
import { computeHandles, orientedHandles, type Handle } from './handles';

export class SelectionController {
  readonly marquee = new Marquee();

  constructor(
    private readonly scene: SceneGraphPort,
    private readonly selection: SelectionPort,
    private readonly hit: HitTester,
  ) {}

  /**
   * Expand a node to the group of ids that must select/move as one body (an
   * imported SVG icon's leaf parts, a user group). Falls back to `[id]` when the
   * binding has no grouping or the node stands alone.
   */
  private expand(id: NodeId): NodeId[] {
    const group = this.scene.selectionGroup?.(id);
    return group && group.length > 0 ? [...group] : [id];
  }

  /** Handle a click at a world point with modifiers. Returns the hit node id. */
  clickAt(worldPoint: Vec2, mods: Modifiers): NodeId | null {
    const node = this.hit.hitTest(worldPoint);
    const additive = mods.shift || mods.mod || mods.ctrl;
    if (!node) {
      if (!additive) this.selection.clear();
      return null;
    }
    const group = this.expand(node.id);
    if (additive) {
      // Toggle the whole group as a unit — clicking any part of an already
      // selected icon deselects the entire icon.
      const allSelected = group.every((g) => this.selection.has(g));
      for (const g of group) {
        if (allSelected) this.selection.remove(g);
        else this.selection.add(g);
      }
    } else if (!this.selection.has(node.id)) {
      this.selection.set(group);
    }
    return node.id;
  }

  /** Select a single node explicitly (expanded to its group when it has one). */
  select(id: NodeId): void {
    this.selection.set(this.expand(id));
  }

  /**
   * Select exactly this node, WITHOUT expanding to its group. This is how the
   * user drills into a group (double-click) to edit one part — e.g. recolour a
   * single shape of an imported SVG icon or a UI-kit component.
   */
  selectExact(id: NodeId): void {
    this.selection.set([id]);
  }

  selectAll(): void {
    const ids: NodeId[] = [];
    for (const n of this.scene.getNodes()) {
      if (n.visible && !n.locked) ids.push(n.id);
    }
    this.selection.set(ids);
  }

  clear(): void {
    this.selection.clear();
  }

  // ── Marquee flow ─────────────────────────────────────────────────
  beginMarquee(worldPoint: Vec2): void {
    this.marquee.begin(worldPoint);
  }

  updateMarquee(worldPoint: Vec2): void {
    this.marquee.update(worldPoint);
  }

  /** Finish the marquee and commit the selection. */
  endMarquee(mods: Modifiers): NodeId[] {
    const rect = this.marquee.rect();
    const mode: MarqueeMode = this.marquee.mode();
    this.marquee.end();
    if (!rect || (rect.width < 1e-6 && rect.height < 1e-6)) return [];
    const nodes = this.hit.hitTestRegion(rect, mode);
    const ids = nodes.map((n) => n.id);
    if (mods.shift || mods.mod) {
      for (const id of ids) this.selection.add(id);
    } else {
      this.selection.set(ids);
    }
    return ids;
  }

  cancelMarquee(): void {
    this.marquee.cancel();
  }

  // ── Overlay geometry (world space) ───────────────────────────────
  /**
   * Union AABB of the selected nodes, or null when empty.
   *
   * This is the TOOL's box — resize math, move snapping and fit-to-selection
   * all need one axis-aligned rectangle to work in. It is deliberately NOT what
   * gets drawn: see `selectionBoxes`.
   */
  selectionBounds(): Rect | null {
    const rects: Rect[] = [];
    for (const id of this.selection.get()) {
      const n = this.scene.getNode(id);
      if (n) rects.push(n.worldBounds);
    }
    return R.bounds(rects);
  }

  /**
   * One ORIENTED box per selected layer — what the overlay draws.
   *
   * Two separate fixes in one list. Each box is the layer's own rotated
   * rectangle rather than its axis-aligned bounds, and selecting three layers
   * yields three boxes rather than one merged rectangle that belongs to none of
   * them and encloses whatever happens to lie between them.
   */
  selectionBoxes(): SelectionBox[] {
    const out: SelectionBox[] = [];
    for (const id of this.selection.get()) {
      const n = this.scene.getNode(id);
      // The id rides along so the painter can colour each outline by its own
      // layer's label. Bare `Corners` made the drawn boxes anonymous: with
      // three layers selected there was no way to tell which outline belonged
      // to which timeline row, which is exactly what label colours are for.
      if (n) out.push({ id, corners: n.worldCorners ?? (R.corners(n.worldBounds) as Corners) });
    }
    return out;
  }

  /**
   * Resize/rotate handles in world space, or [] when nothing is selected.
   *
   * Also [] for a single 3D layer: its transform belongs to the 3D gizmo, and
   * these handles work in axis-aligned world bounds, which do not describe a
   * projected 3D layer. Returning none here means the tool cannot grab them
   * either — hiding them in the painter alone would leave invisible hit targets.
   *
   * Always all eight. Which of them are SHOWN (and therefore grabbable) at the
   * current zoom is the tool's call, since only it knows the on-screen size —
   * see `visibleHandleIds`.
   */
  handles(): Handle[] {
    const bounds = this.selectionBounds();
    if (!bounds) return [];
    const ids = this.selection.get();
    if (ids.length === 1) {
      const only = this.scene.getNode(ids[0]!);
      if (only?.is3D) return [];
      // ONE layer: put the grips on its own ORIENTED box.
      //
      // They used to come from the axis-aligned bounds even here, so rotating a
      // layer turned the artwork and the hairline outline (`selectionBoxes`,
      // which has always been oriented) while the eight grips stayed in an
      // upright rectangle around them. That upright rectangle is what reads as
      // "the selection border did not rotate" — the outline had, but the grips
      // are the louder shape.
      //
      // The tool resizes in LOCAL space to match (see `SelectTool.onDrag`), so
      // a grip drawn on the rotated corner also drags along the layer's own
      // axes. Moving the grips without that would be worse than leaving them:
      // the handle would sit in one place and act in another.
      if (only?.worldCorners) return orientedHandles(only.worldCorners);
    }
    // A MULTI-selection has no single orientation to honour, so its grips stay
    // on the union AABB — which is also the box the move/marquee math uses.
    return computeHandles(bounds);
  }

  get marqueeRect(): Rect | null {
    return this.marquee.rect();
  }
}
