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
import { computeHandles, type Handle } from './handles';

export class SelectionController {
  readonly marquee = new Marquee();

  constructor(
    private readonly scene: SceneGraphPort,
    private readonly selection: SelectionPort,
    private readonly hit: HitTester,
  ) {}

  /** Handle a click at a world point with modifiers. Returns the hit node id. */
  clickAt(worldPoint: Vec2, mods: Modifiers): NodeId | null {
    const node = this.hit.hitTest(worldPoint);
    const additive = mods.shift || mods.mod || mods.ctrl;
    if (!node) {
      if (!additive) this.selection.clear();
      return null;
    }
    if (additive) {
      this.selection.toggle(node.id);
    } else if (!this.selection.has(node.id)) {
      this.selection.set([node.id]);
    }
    return node.id;
  }

  /** Select a single node explicitly. */
  select(id: NodeId): void {
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
  /** Union of selected nodes' world bounds, or null when empty. */
  selectionBounds(): Rect | null {
    const rects: Rect[] = [];
    for (const id of this.selection.get()) {
      const n = this.scene.getNode(id);
      if (n) rects.push(n.worldBounds);
    }
    return R.bounds(rects);
  }

  /** Resize/rotate handles in world space, or [] when nothing is selected. */
  handles(rotateOffsetWorld = 24): Handle[] {
    const bounds = this.selectionBounds();
    if (!bounds) return [];
    return computeHandles(bounds, { rotateOffset: rotateOffsetWorld });
  }

  get marqueeRect(): Rect | null {
    return this.marquee.rect();
  }
}
