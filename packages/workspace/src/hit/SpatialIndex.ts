/**
 * SpatialIndex — a quadtree over world-space AABBs for fast point/region hit
 * queries. Designed for 100k+ objects: queries visit only the branches that
 * overlap, so a click resolves against a handful of candidates instead of the
 * whole scene. Rebuilt from the Scene Graph when structure/transform changes.
 *
 * Items store an id + AABB; precise shape testing (path/mask) is layered on top
 * by the HitTester using the candidates this returns.
 */

import type { Rect } from '../math/Rect';
import type { Vec2 } from '../math/Vec2';
import * as R from '../math/Rect';
import type { NodeId } from '../ports';

export interface SpatialItem {
  id: NodeId;
  bounds: Rect;
}

interface QuadNode {
  bounds: Rect;
  depth: number;
  items: SpatialItem[];
  children: QuadNode[] | null;
}

export interface SpatialIndexOptions {
  maxItemsPerNode?: number;
  maxDepth?: number;
}

export class SpatialIndex {
  private root: QuadNode;
  private readonly maxItems: number;
  private readonly maxDepth: number;
  private count = 0;

  constructor(worldBounds: Rect, opts: SpatialIndexOptions = {}) {
    this.maxItems = opts.maxItemsPerNode ?? 8;
    this.maxDepth = opts.maxDepth ?? 8;
    this.root = this.makeNode(worldBounds, 0);
  }

  get size(): number {
    return this.count;
  }

  /** The world region the index covers. */
  get bounds(): Rect {
    return { ...this.root.bounds };
  }

  clear(worldBounds?: Rect): void {
    this.root = this.makeNode(worldBounds ?? this.root.bounds, 0);
    this.count = 0;
  }

  /** Rebuild the whole index from a fresh item list, growing bounds to fit. */
  rebuild(items: readonly SpatialItem[]): void {
    const bounds = this.fitBounds(items) ?? this.root.bounds;
    this.root = this.makeNode(bounds, 0);
    this.count = 0;
    for (const item of items) this.insert(item);
  }

  insert(item: SpatialItem): void {
    // Items outside the root bounds still get stored at the root so they remain
    // queryable (the tree is a query accelerator, not a hard clip).
    this.insertInto(this.root, item);
    this.count += 1;
  }

  /** All item ids whose AABB contains the world point. */
  queryPoint(point: Vec2): SpatialItem[] {
    const out: SpatialItem[] = [];
    this.collectPoint(this.root, point, out);
    return out;
  }

  /** All items whose AABB intersects the world region. */
  queryRect(region: Rect): SpatialItem[] {
    const out: SpatialItem[] = [];
    this.collectRect(this.root, region, out);
    return out;
  }

  private makeNode(bounds: Rect, depth: number): QuadNode {
    return { bounds, depth, items: [], children: null };
  }

  private insertInto(node: QuadNode, item: SpatialItem): void {
    if (node.children) {
      const idx = this.childIndexFor(node, item.bounds);
      if (idx !== -1) {
        this.insertInto(node.children[idx]!, item);
        return;
      }
      // Straddles multiple quadrants → keep at this node.
      node.items.push(item);
      return;
    }
    node.items.push(item);
    if (node.items.length > this.maxItems && node.depth < this.maxDepth) {
      this.subdivide(node);
    }
  }

  private subdivide(node: QuadNode): void {
    const { x, y, width, height } = node.bounds;
    const hw = width / 2;
    const hh = height / 2;
    const d = node.depth + 1;
    node.children = [
      this.makeNode({ x, y, width: hw, height: hh }, d), // NW
      this.makeNode({ x: x + hw, y, width: hw, height: hh }, d), // NE
      this.makeNode({ x, y: y + hh, width: hw, height: hh }, d), // SW
      this.makeNode({ x: x + hw, y: y + hh, width: hw, height: hh }, d), // SE
    ];
    const retained: SpatialItem[] = [];
    for (const item of node.items) {
      const idx = this.childIndexFor(node, item.bounds);
      if (idx !== -1) this.insertInto(node.children[idx]!, item);
      else retained.push(item);
    }
    node.items = retained;
  }

  /** Which single child fully contains `bounds`, or -1 if it straddles. */
  private childIndexFor(node: QuadNode, bounds: Rect): number {
    if (!node.children) return -1;
    for (let i = 0; i < 4; i++) {
      if (R.containsRect(node.children[i]!.bounds, bounds)) return i;
    }
    return -1;
  }

  private collectPoint(node: QuadNode, point: Vec2, out: SpatialItem[]): void {
    for (const item of node.items) {
      if (R.containsPoint(item.bounds, point)) out.push(item);
    }
    if (node.children) {
      for (const child of node.children) {
        if (R.containsPoint(child.bounds, point)) this.collectPoint(child, point, out);
      }
    }
  }

  private collectRect(node: QuadNode, region: Rect, out: SpatialItem[]): void {
    for (const item of node.items) {
      if (R.intersects(item.bounds, region)) out.push(item);
    }
    if (node.children) {
      for (const child of node.children) {
        if (R.intersects(child.bounds, region)) this.collectRect(child, region, out);
      }
    }
  }

  private fitBounds(items: readonly SpatialItem[]): Rect | null {
    if (items.length === 0) return null;
    const union = R.bounds(items.map((i) => i.bounds));
    if (!union) return null;
    // Pad so edge items aren't exactly on the boundary.
    return R.inflate(union, Math.max(1, union.width * 0.05), Math.max(1, union.height * 0.05));
  }
}
