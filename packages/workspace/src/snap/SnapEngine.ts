/**
 * SnapEngine — resolves a moving point or rectangle onto nearby "snap targets"
 * (grid lines, guides, and other objects' edges/centers/corners) within a
 * pixel-space threshold. Returns the corrected position plus the snap lines to
 * highlight. Pure and stateless per call; the Workspace assembles targets and
 * feeds them in.
 *
 * Everything is computed in **world units**; the caller converts the screen-px
 * threshold to world units at the current zoom so the "magnet" feels constant.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import * as R from '../math/Rect';
import { spacingCandidates, type SpacingCandidate } from './smartGuides';

export interface SnapSettings {
  enabled: boolean;
  toGrid: boolean;
  toGuides: boolean;
  toObjects: boolean;
  /** Also match centers & edges (not just points). */
  toEdges: boolean;
  toCenters: boolean;
  /**
   * Figma-style smart guides: equal-spacing snapping plus the measurement
   * chrome the host draws from it (distance badges, hatch bars, equal-size
   * highlights). Alignment snapping is unaffected either way — turning this off
   * takes away the measuring, not the magnet.
   */
  smartGuides: boolean;
  /** Snap threshold in screen pixels. */
  thresholdPx: number;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  toGrid: true,
  toGuides: true,
  toObjects: true,
  toEdges: true,
  toCenters: true,
  smartGuides: true,
  /*
   * The magnet's reach, in SCREEN px.
   *
   * Every px of this is paid twice on a drag: once as a band the pointer
   * crosses with the layer standing still, and once as the teleport that ends
   * it. At 6 that was a 12px dead zone and two ~6px lurches per target — read
   * by users as the drag "jumping". 3 keeps the assist (a deliberate approach
   * still lands on the edge) and halves both costs; Ctrl/Cmd during the drag
   * suspends it entirely — see SelectTool.onDrag.
   */
  thresholdPx: 3,
};

export type SnapSource = 'grid' | 'guide' | 'object-edge' | 'object-center' | 'object-corner';

/** A 1-D line the geometry can snap to, in world coordinates. */
export interface SnapTarget {
  axis: 'x' | 'y';
  /** World coordinate along the perpendicular axis. */
  position: number;
  source: SnapSource;
  /** Optional extent for drawing an alignment line (world coords). */
  extentFrom?: number;
  extentTo?: number;
}

export interface SnapLine {
  axis: 'x' | 'y';
  position: number;
  from: number;
  to: number;
  source: SnapSource;
}

export interface SnapResult<T> {
  /** The snapped geometry (same shape that was passed in). */
  value: T;
  /** World-space delta applied to reach the snap. */
  delta: Vec2;
  /** Whether any axis snapped. */
  snapped: boolean;
  lines: SnapLine[];
  /**
   * Equal-spacing snaps that were APPLIED (at most one per axis), for the host
   * to draw as hatch bars. Empty unless the caller passed neighbour rects and
   * `smartGuides` is on. Alignment always wins an axis: a box that lines up
   * with an edge must not be nudged off it to even out a gap.
   */
  spacing: readonly SpacingCandidate[];
}

interface AxisMatch {
  target: SnapTarget;
  /** The moving coordinate that matched (for delta computation). */
  movingCoord: number;
  distance: number;
}

export class SnapEngine {
  private settings: SnapSettings = { ...DEFAULT_SNAP_SETTINGS };

  getSettings(): SnapSettings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<SnapSettings>): void {
    this.settings = { ...this.settings, ...patch };
  }

  /** Grid targets covering a world region, at the given spacing. */
  static gridTargets(region: Rect, spacing: number): SnapTarget[] {
    if (spacing <= 0) return [];
    const targets: SnapTarget[] = [];
    const startX = Math.floor(region.x / spacing) * spacing;
    const endX = region.x + region.width;
    for (let x = startX; x <= endX; x += spacing) {
      targets.push({ axis: 'x', position: x, source: 'grid' });
    }
    const startY = Math.floor(region.y / spacing) * spacing;
    const endY = region.y + region.height;
    for (let y = startY; y <= endY; y += spacing) {
      targets.push({ axis: 'y', position: y, source: 'grid' });
    }
    return targets;
  }

  /** Edge/center/corner targets derived from a set of object world bounds. */
  static objectTargets(bounds: readonly Rect[]): SnapTarget[] {
    const targets: SnapTarget[] = [];
    for (const b of bounds) {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const yFrom = b.y;
      const yTo = b.y + b.height;
      const xFrom = b.x;
      const xTo = b.x + b.width;
      // Vertical lines (x positions): left, center, right.
      targets.push({ axis: 'x', position: b.x, source: 'object-edge', extentFrom: yFrom, extentTo: yTo });
      targets.push({ axis: 'x', position: xTo, source: 'object-edge', extentFrom: yFrom, extentTo: yTo });
      targets.push({ axis: 'x', position: cx, source: 'object-center', extentFrom: yFrom, extentTo: yTo });
      // Horizontal lines (y positions): top, middle, bottom.
      targets.push({ axis: 'y', position: b.y, source: 'object-edge', extentFrom: xFrom, extentTo: xTo });
      targets.push({ axis: 'y', position: yTo, source: 'object-edge', extentFrom: xFrom, extentTo: xTo });
      targets.push({ axis: 'y', position: cy, source: 'object-center', extentFrom: xFrom, extentTo: xTo });
    }
    return targets;
  }

  /** Snap a single world point. */
  snapPoint(point: Vec2, targets: readonly SnapTarget[], thresholdWorld: number): SnapResult<Vec2> {
    if (!this.settings.enabled) {
      return { value: point, delta: { x: 0, y: 0 }, snapped: false, lines: [], spacing: [] };
    }
    const xMatch = this.bestMatch([point.x], targets, 'x', thresholdWorld);
    const yMatch = this.bestMatch([point.y], targets, 'y', thresholdWorld);
    const dx = xMatch ? xMatch.target.position - xMatch.movingCoord : 0;
    const dy = yMatch ? yMatch.target.position - yMatch.movingCoord : 0;
    return this.buildResult({ x: point.x + dx, y: point.y + dy }, { x: dx, y: dy }, xMatch, yMatch, point);
  }

  /**
   * Snap a moving world rect. Considers its left/center/right (x) and
   * top/middle/bottom (y) against the targets, choosing the closest per axis.
   */
  snapRect(
    rect: Rect,
    targets: readonly SnapTarget[],
    thresholdWorld: number,
    /**
     * The other objects' world bounds, for equal-SPACING snapping. Optional:
     * callers that only want alignment (the behaviour that shipped) pass
     * nothing and get byte-identical results.
     */
    others?: readonly Rect[],
  ): SnapResult<Rect> {
    if (!this.settings.enabled) {
      return { value: rect, delta: { x: 0, y: 0 }, snapped: false, lines: [], spacing: [] };
    }
    const xCoords: number[] = [rect.x];
    const yCoords: number[] = [rect.y];
    if (this.settings.toEdges) {
      xCoords.push(rect.x + rect.width);
      yCoords.push(rect.y + rect.height);
    }
    if (this.settings.toCenters) {
      xCoords.push(rect.x + rect.width / 2);
      yCoords.push(rect.y + rect.height / 2);
    }
    const xMatch = this.bestMatch(xCoords, targets, 'x', thresholdWorld);
    const yMatch = this.bestMatch(yCoords, targets, 'y', thresholdWorld);
    let dx = xMatch ? xMatch.target.position - xMatch.movingCoord : 0;
    let dy = yMatch ? yMatch.target.position - yMatch.movingCoord : 0;
    /*
     * Equal spacing, on the axes alignment did not claim.
     *
     * An axis that already snapped to an edge/center/guide is LEFT ALONE: two
     * magnets pulling the same axis in different directions is a fight the user
     * feels as jitter, and alignment is the stronger promise of the two (it is
     * what the pink line is already claiming on screen).
     */
    const spacing: SpacingCandidate[] = [];
    if (this.settings.smartGuides && this.settings.toObjects && others && others.length) {
      const free = R.translate(rect, { x: dx, y: dy });
      for (const c of spacingCandidates(free, others, thresholdWorld)) {
        if (c.axis === 'x' && !xMatch && !spacing.some((s) => s.axis === 'x')) {
          dx += c.delta;
          spacing.push(c);
        } else if (c.axis === 'y' && !yMatch && !spacing.some((s) => s.axis === 'y')) {
          dy += c.delta;
          spacing.push(c);
        }
      }
    }
    const snappedRect = R.translate(rect, { x: dx, y: dy });
    const result = this.buildResult(snappedRect, { x: dx, y: dy }, xMatch, yMatch, R.center(rect));
    return { ...result, snapped: result.snapped || spacing.length > 0, spacing };
  }

  private allowed(source: SnapSource): boolean {
    if (source === 'grid') return this.settings.toGrid;
    if (source === 'guide') return this.settings.toGuides;
    return this.settings.toObjects;
  }

  private bestMatch(
    movingCoords: number[],
    targets: readonly SnapTarget[],
    axis: 'x' | 'y',
    threshold: number,
  ): AxisMatch | null {
    let best: AxisMatch | null = null;
    for (const target of targets) {
      if (target.axis !== axis || !this.allowed(target.source)) continue;
      for (const mc of movingCoords) {
        const distance = Math.abs(target.position - mc);
        if (distance <= threshold && (best === null || distance < best.distance)) {
          best = { target, movingCoord: mc, distance };
        }
      }
    }
    return best;
  }

  private buildResult<T>(
    value: T,
    delta: Vec2,
    xMatch: AxisMatch | null,
    yMatch: AxisMatch | null,
    anchor: Vec2,
  ): SnapResult<T> {
    const lines: SnapLine[] = [];
    if (xMatch) lines.push(this.matchToLine(xMatch, anchor));
    if (yMatch) lines.push(this.matchToLine(yMatch, anchor));
    return { value, delta, snapped: xMatch !== null || yMatch !== null, lines, spacing: [] };
  }

  private matchToLine(match: AxisMatch, anchor: Vec2): SnapLine {
    const t = match.target;
    // Draw along the target's extent if known, else a short mark around anchor.
    const perp = t.axis === 'x' ? anchor.y : anchor.x;
    const from = t.extentFrom ?? perp - 40;
    const to = t.extentTo ?? perp + 40;
    return { axis: t.axis, position: t.position, from, to, source: t.source };
  }
}
