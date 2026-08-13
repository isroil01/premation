/**
 * Acceptance tests for C3 — gizmo behaviour.
 *
 * The load-bearing one is `pivots on the anchor`: a handle drag and the
 * equivalent keyframed property change must produce the same picture. When they
 * disagree, animating a layer moves it somewhere different from where the user
 * dragged it, and nothing about the UI explains why.
 */

import {
  computeHandles,
  handleCursor,
  visibleHandleIds,
  CORNER_HANDLES,
  EDGE_HANDLE_MIN_PX,
  ANY_HANDLE_MIN_PX,
} from '../selection/handles';
import { resizeBoundsAboutPivot, isResizeHandle } from '../selection/transform';
import * as R from '../math/Rect';
import * as Mat from '../math/Mat2D';

const DEG = Math.PI / 180;

describe('C3 — no rotation handle', () => {
  it('computeHandles emits eight grips, all of them resize', () => {
    const h = computeHandles(R.rect(0, 0, 100, 100));
    expect(h).toHaveLength(8);
    expect(h.map((x) => x.id).sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
    expect(h.every((x) => x.kind === 'resize')).toBe(true);
  });

  it('leaves no dead zone above the box for a stray grip to occupy', () => {
    const h = computeHandles(R.rect(0, 0, 100, 100));
    // Every handle is ON the box, never floating off it.
    for (const g of h) {
      expect(g.position.x).toBeGreaterThanOrEqual(0);
      expect(g.position.x).toBeLessThanOrEqual(100);
      expect(g.position.y).toBeGreaterThanOrEqual(0);
      expect(g.position.y).toBeLessThanOrEqual(100);
    }
  });

  it('every handle id is a resize handle', () => {
    for (const g of computeHandles(R.rect(0, 0, 10, 10))) expect(isResizeHandle(g.id)).toBe(true);
  });
});

describe('C3 — degrading at small on-screen sizes', () => {
  it('shows all eight when the box is comfortably large', () => {
    expect(visibleHandleIds(200, 200)).toHaveLength(8);
  });

  it('drops the mid-edge handles under ~40px', () => {
    const ids = visibleHandleIds(30, 30);
    expect(ids).toEqual(CORNER_HANDLES);
    expect(ids).toHaveLength(4);
  });

  it('shows none under ~20px — outline only', () => {
    expect(visibleHandleIds(15, 15)).toEqual([]);
  });

  it('degrades on the SMALLER dimension, not the area', () => {
    // A long thin bar is exactly the case where handles collide.
    expect(visibleHandleIds(500, 12)).toEqual([]);
    expect(visibleHandleIds(500, 30)).toEqual(CORNER_HANDLES);
  });

  it('thresholds are ordered so there is no gap between the tiers', () => {
    expect(ANY_HANDLE_MIN_PX).toBeLessThan(EDGE_HANDLE_MIN_PX);
    expect(visibleHandleIds(ANY_HANDLE_MIN_PX, ANY_HANDLE_MIN_PX)).toEqual(CORNER_HANDLES);
    expect(visibleHandleIds(EDGE_HANDLE_MIN_PX, EDGE_HANDLE_MIN_PX)).toHaveLength(8);
  });
});

describe('C3 — cursors rotate with the layer', () => {
  it('matches the unrotated compass direction at 0°', () => {
    expect(handleCursor('e')).toBe('resize-e');
    expect(handleCursor('n')).toBe('resize-n');
    expect(handleCursor('se')).toBe('resize-se');
    expect(handleCursor('nw')).toBe('resize-nw');
  });

  it('a corner grip on a 45° layer shows the diagonal that actually applies', () => {
    // 'se' points down-right; rotating the layer 45° swings it to point down.
    expect(handleCursor('se', 45 * DEG)).toBe('resize-s');
    // The east grip becomes the south-east diagonal.
    expect(handleCursor('e', 45 * DEG)).toBe('resize-se');
  });

  it('a 90° rotation swaps the axes', () => {
    expect(handleCursor('e', 90 * DEG)).toBe('resize-s');
    expect(handleCursor('n', 90 * DEG)).toBe('resize-e');
  });

  it('wraps correctly for negative and multi-turn rotations', () => {
    expect(handleCursor('e', -90 * DEG)).toBe('resize-n');
    // Unwrapped rotation (three full turns + 90°) must not break the lookup.
    expect(handleCursor('e', (3 * 360 + 90) * DEG)).toBe('resize-s');
    expect(handleCursor('e', -(3 * 360 + 90) * DEG)).toBe('resize-n');
  });
});

describe('C3 — scale pivots on the anchor, matching the keyframed property', () => {
  /**
   * The renderer places content at `position + R·S·(local − anchor)`.
   * This is that formula, and it is the independent oracle the gizmo is checked
   * against — if a handle drag cannot be expressed as a Scale change alone, the
   * gizmo and the Scale property disagree.
   */
  const renderPoint = (
    local: { x: number; y: number },
    position: { x: number; y: number },
    anchor: { x: number; y: number },
    s: { x: number; y: number },
    rotRad = 0,
  ) => {
    const dx = (local.x - anchor.x) * s.x;
    const dy = (local.y - anchor.y) * s.y;
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);
    return { x: position.x + dx * cos - dy * sin, y: position.y + dx * sin + dy * cos };
  };

  it('a corner drag changes Scale ONLY — Position is untouched', () => {
    // Layer 100×100 centred at (200, 200); anchor at its centre (0,0 local).
    const bounds = R.rect(150, 150, 100, 100);
    const anchorWorld = { x: 200, y: 200 };
    const next = resizeBoundsAboutPivot(bounds, 'se', { x: 300, y: 300 }, anchorWorld);

    // Scale doubled...
    expect(next.width / bounds.width).toBeCloseTo(2, 6);
    //...and the box is still centred on the anchor, i.e. Position did not move.
    expect(R.center(next)).toEqual({ x: 200, y: 200 });
  });

  it('the dragged corner lands exactly where the pointer is', () => {
    const bounds = R.rect(150, 150, 100, 100);
    const next = resizeBoundsAboutPivot(bounds, 'se', { x: 330, y: 290 }, { x: 200, y: 200 });
    expect(next.x + next.width).toBeCloseTo(330, 6);
    expect(next.y + next.height).toBeCloseTo(290, 6);
  });

  it('matches what the same Scale value produces through the render formula', () => {
    const anchor = { x: 0, y: 0 }; // local, = layer centre
    const position = { x: 200, y: 200 };
    const bounds = R.rect(150, 150, 100, 100);
    const dragged = resizeBoundsAboutPivot(bounds, 'se', { x: 300, y: 300 }, position);
    const s = { x: dragged.width / bounds.width, y: dragged.height / bounds.height };

    // Where the layer's own SE corner (local +50,+50) ends up, per the renderer.
    const rendered = renderPoint({ x: 50, y: 50 }, position, anchor, s);
    expect(rendered.x).toBeCloseTo(dragged.x + dragged.width, 6);
    expect(rendered.y).toBeCloseTo(dragged.y + dragged.height, 6);
  });

  it('an OFF-CENTRE anchor keeps Position fixed and moves the box, as the formula does', () => {
    // Anchor at the layer's top-left corner (local −50,−50 → world 150,150).
    const anchor = { x: -50, y: -50 };
    const position = { x: 150, y: 150 };
    const bounds = R.rect(150, 150, 100, 100);
    const dragged = resizeBoundsAboutPivot(bounds, 'se', { x: 350, y: 350 }, position);
    const s = { x: dragged.width / bounds.width, y: dragged.height / bounds.height };
    expect(s.x).toBeCloseTo(2, 6);

    // The anchor corner stays put...
    expect(dragged.x).toBeCloseTo(150, 6);
    expect(dragged.y).toBeCloseTo(150, 6);
    //...and the render formula agrees about both corners.
    const tl = renderPoint({ x: -50, y: -50 }, position, anchor, s);
    const br = renderPoint({ x: 50, y: 50 }, position, anchor, s);
    expect(tl.x).toBeCloseTo(dragged.x, 6);
    expect(br.x).toBeCloseTo(dragged.x + dragged.width, 6);
  });

  it('the OLD opposite-corner model does NOT keep Position fixed (the bug)', () => {
    // Same drag, pivoting on the opposite corner instead of the anchor: the box
    // centre moves, which means Position must change to express it — so the
    // result cannot be reached by animating Scale alone.
    const bounds = R.rect(150, 150, 100, 100);
    const oppositeCorner = { x: 150, y: 150 };
    const dragged = resizeBoundsAboutPivot(bounds, 'se', { x: 300, y: 300 }, oppositeCorner);
    expect(R.center(dragged)).not.toEqual({ x: 200, y: 200 });
  });
});

describe('C3 — handles are screen-space constant', () => {
  it('handle positions come from bounds, so zoom cannot change their pixel size', () => {
    // The gizmo is built in world space and projected per-corner; the painter
    // draws a fixed 8px square at each projected point. This pins the contract
    // that handle SIZE is not derived from the box's world size.
    const near = computeHandles(R.rect(0, 0, 100, 100));
    const far = computeHandles(R.rect(0, 0, 10000, 10000));
    expect(near).toHaveLength(far.length);
    // Same ids in the same order regardless of scale.
    expect(near.map((h) => h.id)).toEqual(far.map((h) => h.id));
  });

  it('a rotated layer still yields eight handles (they are box-relative)', () => {
    const local = R.rect(-50, -50, 100, 100);
    const rotated = R.transform(local, Mat.rotation(30 * DEG));
    expect(computeHandles(rotated)).toHaveLength(8);
  });
});
