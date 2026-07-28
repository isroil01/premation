/**
 * HitTester — resolves what's under a world point or inside a world region,
 * honoring z-order, visibility, and locks. Uses the SpatialIndex to narrow
 * candidates, then applies precise per-node testing (local shape/path/mask via
 * `WorkspaceNode.hitTestLocal`, falling back to the AABB).
 *
 * Hit priority: topmost first (highest zIndex, tie-broken by later document
 * order). Locked and hidden nodes are skipped unless explicitly included.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';
import * as OBox from '../math/OrientedBox';
import type { Corners } from '../math/OrientedBox';
import type { SceneGraphPort, WorkspaceNode } from '../ports';
import { SpatialIndex } from './SpatialIndex';

export interface HitOptions {
  /** Include locked nodes (default false). */
  includeLocked?: boolean;
  /** Include hidden nodes (default false). */
  includeHidden?: boolean;
  /** Pixel tolerance around the point, in world units (for thin shapes/edges). */
  tolerance?: number;
}

export interface HitResult {
  node: WorkspaceNode;
  /** Distance-ish rank used to order overlapping hits (lower = closer to top). */
  rank: number;
}

/**
 * A projection is degenerate when its 2×3 affine has no inverse — the layer maps
 * to a line or a point rather than to an area.
 *
 * The case that matters is a flat 3D layer seen edge-on: in the Left / Right /
 * Top / Bottom views a plane of zero thickness projects to zero area, so its X
 * (or Y) basis collapses and `Mat.invert` has nothing to return. Every
 * local-space hit test is expressed as `inverse(worldMatrix)·worldPoint`, so
 * without a separate path such a layer is not merely hard to click — it is
 * unreachable, and the only way to select it is the timeline.
 */
function isDegenerate(m: Mat.Mat2D): boolean {
  return Math.abs(m.a * m.d - m.b * m.c) < 1e-6;
}

export class HitTester {
  private index: SpatialIndex;
  private dirty = false;

  /**
   * @param edgeTolerance World-space slack for degenerate (edge-on) layers,
   *   supplied by the owner so it can track zoom. A hairline is a hairline at
   *   every zoom level, so a FIXED world tolerance would be unclickable zoomed
   *   out and grab half the canvas zoomed in — the caller converts a screen-pixel
   *   budget through the current camera instead. Defaults to 0, which restores
   *   the old behaviour exactly for any embedder that does not supply one.
   */
  constructor(
    private readonly scene: SceneGraphPort,
    initialBounds: Rect = { x: -1000, y: -1000, width: 2000, height: 2000 },
    private readonly edgeTolerance: () => number = () => 0,
  ) {
    this.index = new SpatialIndex(initialBounds);
    this.rebuild();
  }

  /**
   * Note that the scene changed; the index rebuilds on the next query.
   *
   * Scene changes arrive far more often than hit-tests consume them — every
   * keyframe write, every playhead tick, every step of a bulk import bumps the
   * scene, but the index is only read when the pointer interacts with the
   * canvas. Rebuilding eagerly made every bump pay for a full scene enumeration
   * up front (seconds during an import); deferring moves that cost to the next
   * click, where one rebuild answers for any number of bumps.
   */
  markDirty(): void {
    this.dirty = true;
  }

  /** Rebuild the spatial index from the current scene. Call on scene change. */
  rebuild(): void {
    this.dirty = false;
    const items = [];
    for (const node of this.scene.getNodes()) {
      items.push({ id: node.id, bounds: node.worldBounds });
    }
    this.index.rebuild(items);
  }

  private ensureFresh(): void {
    if (this.dirty) this.rebuild();
  }

  get indexSize(): number {
    this.ensureFresh();
    return this.index.size;
  }

  /** Topmost node at a world point, or null. */
  hitTest(worldPoint: Vec2, opts: HitOptions = {}): WorkspaceNode | null {
    const all = this.hitTestAll(worldPoint, opts);
    return all.length > 0 ? all[0]!.node : null;
  }

  /** Every node under the point, ordered topmost-first. */
  hitTestAll(worldPoint: Vec2, opts: HitOptions = {}): HitResult[] {
    this.ensureFresh();
    const tolerance = opts.tolerance ?? 0;
    const edgeTol = this.edgeTolerance();
    // The broad phase must widen for edge-on layers too: their AABB is a
    // zero-width sliver, so an exact `queryPoint` almost never lands on it and
    // the precise test below would never even be consulted. Widening only
    // enlarges the CANDIDATE set — every non-degenerate node still faces the
    // same exact `hitTestLocal` it always did, so nothing else becomes clickable.
    const probeTol = Math.max(tolerance, edgeTol);
    const probe: Rect = {
      x: worldPoint.x - probeTol,
      y: worldPoint.y - probeTol,
      width: probeTol * 2,
      height: probeTol * 2,
    };
    const candidates = probeTol > 0 ? this.index.queryRect(probe) : this.index.queryPoint(worldPoint);
    const hits: HitResult[] = [];
    for (const cand of candidates) {
      const node = this.scene.getNode(cand.id);
      if (!node || !this.eligible(node, opts)) continue;
      if (!this.precisePointHit(node, worldPoint, tolerance, edgeTol)) continue;
      hits.push({ node, rank: 0 });
    }
    this.sortTopmost(hits);
    return hits;
  }

  /**
   * Nodes intersecting a world region. `mode: 'contain'` requires full
   * containment (window-select); `'intersect'` accepts any overlap (crossing).
   */
  hitTestRegion(region: Rect, mode: 'intersect' | 'contain' = 'intersect', opts: HitOptions = {}): WorkspaceNode[] {
    this.ensureFresh();
    // Broad phase stays on the AABB — a superset is exactly what an index
    // should return. The decision is then made against the ORIENTED box, so a
    // rotated layer is not selected by a marquee that only ever touched the
    // dead padding in its bounding box's corner.
    const candidates = this.index.queryRect(region);
    const out: WorkspaceNode[] = [];
    for (const cand of candidates) {
      const node = this.scene.getNode(cand.id);
      if (!node || !this.eligible(node, opts)) continue;
      const c = cornersOf(node);
      const ok = mode === 'contain'
        ? OBox.rectContainsCorners(region, c)
        : OBox.rectIntersectsCorners(region, c);
      if (ok) out.push(node);
    }
    return out;
  }

  private eligible(node: WorkspaceNode, opts: HitOptions): boolean {
    if (!opts.includeHidden && !node.visible) return false;
    if (!opts.includeLocked && node.locked) return false;
    return true;
  }

  private precisePointHit(
    node: WorkspaceNode,
    worldPoint: Vec2,
    tolerance: number,
    edgeTolerance = 0,
  ): boolean {
    // ── Edge-on layers: test the projected outline, not the local space ──
    //
    // `worldCorners` is already the honest answer here — for a flat layer seen
    // edge-on the four projected corners collapse onto the hairline the viewport
    // draws, which is exactly the thing the user is aiming at. So hit-test that
    // segment directly with a screen-derived slack, and skip the inverse that
    // does not exist. This is what makes a layer selectable in Left / Right /
    // Top / Bottom view at all, and it matches AE, where the wireframe IS the
    // click target once a layer has no projected area.
    if (isDegenerate(node.worldMatrix)) {
      const tol = Math.max(tolerance, edgeTolerance);
      if (tol <= 0) return false;
      // Bounds first: collapsed on one axis but still the layer's true extent on
      // the other, so this is what stops a click far along the line from hitting.
      if (!R.containsPoint(R.inflate(node.worldBounds, tol), worldPoint)) return false;
      return OBox.cornersContainPoint(cornersOf(node), worldPoint, tol);
    }
    // Re-check the AABB against the CALLER's tolerance, always.
    //
    // This used to be skipped when `tolerance === 0`, because `queryPoint`
    // already guaranteed containment. It no longer does: the broad phase now
    // widens by the edge tolerance to reach hairlines, so a point just outside a
    // normal layer arrives here as a candidate. Without this check a node with no
    // `hitTestLocal` would fall through to the `return true` below and be hit
    // from several pixels away.
    if (!R.containsPoint(R.inflate(node.worldBounds, tolerance), worldPoint)) {
      return false;
    }
    if (!node.hitTestLocal) return true;
    const local = Mat.apply(Mat.invert(node.worldMatrix), worldPoint);
    return node.hitTestLocal(local);
  }

  private sortTopmost(hits: HitResult[]): void {
    hits.sort((a, b) => b.node.zIndex - a.node.zIndex);
  }
}

/**
 * A node's oriented box, falling back to its AABB's corners for an adapter that
 * does not supply one. The fallback is the OLD behaviour exactly, so a partial
 * adapter degrades to axis-aligned rather than breaking.
 */
function cornersOf(node: WorkspaceNode): Corners {
  return node.worldCorners ?? (R.corners(node.worldBounds) as Corners);
}
