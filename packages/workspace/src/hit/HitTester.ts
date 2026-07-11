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

export class HitTester {
  private index: SpatialIndex;

  constructor(
    private readonly scene: SceneGraphPort,
    initialBounds: Rect = { x: -1000, y: -1000, width: 2000, height: 2000 },
  ) {
    this.index = new SpatialIndex(initialBounds);
    this.rebuild();
  }

  /** Rebuild the spatial index from the current scene. Call on scene change. */
  rebuild(): void {
    const items = [];
    for (const node of this.scene.getNodes()) {
      items.push({ id: node.id, bounds: node.worldBounds });
    }
    this.index.rebuild(items);
  }

  get indexSize(): number {
    return this.index.size;
  }

  /** Topmost node at a world point, or null. */
  hitTest(worldPoint: Vec2, opts: HitOptions = {}): WorkspaceNode | null {
    const all = this.hitTestAll(worldPoint, opts);
    return all.length > 0 ? all[0]!.node : null;
  }

  /** Every node under the point, ordered topmost-first. */
  hitTestAll(worldPoint: Vec2, opts: HitOptions = {}): HitResult[] {
    const tolerance = opts.tolerance ?? 0;
    const probe: Rect = {
      x: worldPoint.x - tolerance,
      y: worldPoint.y - tolerance,
      width: tolerance * 2,
      height: tolerance * 2,
    };
    const candidates = tolerance > 0 ? this.index.queryRect(probe) : this.index.queryPoint(worldPoint);
    const hits: HitResult[] = [];
    for (const cand of candidates) {
      const node = this.scene.getNode(cand.id);
      if (!node || !this.eligible(node, opts)) continue;
      if (!this.precisePointHit(node, worldPoint, tolerance)) continue;
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
    const candidates = this.index.queryRect(region);
    const out: WorkspaceNode[] = [];
    for (const cand of candidates) {
      const node = this.scene.getNode(cand.id);
      if (!node || !this.eligible(node, opts)) continue;
      const ok = mode === 'contain' ? R.containsRect(region, node.worldBounds) : R.intersects(region, node.worldBounds);
      if (ok) out.push(node);
    }
    return out;
  }

  private eligible(node: WorkspaceNode, opts: HitOptions): boolean {
    if (!opts.includeHidden && !node.visible) return false;
    if (!opts.includeLocked && node.locked) return false;
    return true;
  }

  private precisePointHit(node: WorkspaceNode, worldPoint: Vec2, tolerance: number): boolean {
    // Broad phase already guarantees AABB overlap for queryPoint; for tolerance
    // queries re-check the AABB (inflated) so far-away candidates are dropped.
    if (tolerance > 0 && !R.containsPoint(R.inflate(node.worldBounds, tolerance), worldPoint)) {
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
