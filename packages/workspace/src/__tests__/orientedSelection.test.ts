/**
 * Acceptance tests for C2 — the oriented, per-layer selection box.
 *
 * Two distinct fixes, tested separately because they can regress separately:
 *   1. the box rotates with its layer instead of being that layer's AABB;
 *   2. N selected layers produce N boxes instead of one merged rectangle.
 *
 * Plus the consequence flagged in review: an oriented box needs polygon/SAT
 * tests, not rect intersection. The point-hit path turned out to ALREADY be
 * oriented (it inverts the world matrix and calls `hitTestLocal`); the marquee
 * path was not. Both are pinned here so neither drifts.
 */

import * as OBox from '../math/OrientedBox';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';
import type { Vec2 } from '../math/Vec2';
import { HitTester } from '../hit/HitTester';
import { SelectionController } from '../selection/SelectionController';
import type { SceneGraphPort, WorkspaceNode, SelectionPort, NodeId } from '../ports';

const DEG = Math.PI / 180;

/** A layer centred at (cx, cy), size w×h, rotated `deg`. */
function makeNode(id: string, cx: number, cy: number, w: number, h: number, deg = 0): WorkspaceNode {
  const local = R.rect(-w / 2, -h / 2, w, h);
  const m = Mat.multiply(Mat.translation(cx, cy), Mat.rotation(deg * DEG));
  return {
    id: id as NodeId,
    parentId: null,
    worldBounds: R.transform(local, m),
    worldCorners: OBox.transformCorners(local, m),
    worldMatrix: m,
    localBounds: local,
    visible: true,
    locked: false,
    zIndex: 0,
    hitTestLocal: (p: Vec2) => Math.abs(p.x) <= w / 2 && Math.abs(p.y) <= h / 2,
  };
}

function sceneOf(nodes: WorkspaceNode[]): SceneGraphPort {
  const byId = new Map(nodes.map((n) => [n.id as string, n]));
  return {
    getNode: (id) => byId.get(id as string),
    getNodes: () => nodes,
    getChildren: () => [],
  } as unknown as SceneGraphPort;
}

function selectionPortOf(): SelectionPort & { ids: string[] } {
  let ids: string[] = [];
  return {
    get ids() { return ids; },
    get: () => ids as NodeId[],
    has: (id) => ids.includes(id as string),
    set: (next) => { ids = [...next] as string[]; },
    add: (id) => { if (!ids.includes(id as string)) ids.push(id as string); },
    remove: (id) => { ids = ids.filter((i) => i !== (id as string)); },
    toggle: (id) => { const s = id as string; ids = ids.includes(s) ? ids.filter((i) => i !== s) : [...ids, s]; },
    clear: () => { ids = []; },
    onChanged: () => () => {},
  } as SelectionPort & { ids: string[] };
}

describe('OrientedBox math', () => {
  it('keeps the rotation an AABB throws away', () => {
    const local = R.rect(-50, -10, 100, 20);
    const m = Mat.rotation(30 * DEG);
    const c = OBox.transformCorners(local, m);
    const aabb = R.transform(local, m);
    // The AABB covers strictly more AREA than the layer it came from. (Not
    // more width: at 30° a 100×20 bar's AABB is 96.6 wide — narrower than the
    // bar. Area is the honest comparison, and the padding is real either way.)
    expect(R.area(aabb)).toBeGreaterThan(100 * 20);
    expect(aabb.height).toBeGreaterThan(20);
    // The oriented box keeps the original edge lengths.
    const edge = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
    const side = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);
    expect(edge).toBeCloseTo(100, 6);
    expect(side).toBeCloseTo(20, 6);
  });

  it('a 30° layer produces a 30° box', () => {
    const c = OBox.transformCorners(R.rect(-50, -25, 100, 50), Mat.rotation(30 * DEG));
    const angle = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x) / DEG;
    expect(angle).toBeCloseTo(30, 6);
  });

  it('cornersBounds reproduces Rect.transform exactly', () => {
    const local = R.rect(-30, -40, 60, 80);
    const m = Mat.multiply(Mat.translation(11, -7), Mat.rotation(37 * DEG));
    expect(OBox.cornersBounds(OBox.transformCorners(local, m))).toEqual(R.transform(local, m));
  });

  it('point-in-box is exact where the AABB is wrong', () => {
    const local = R.rect(-50, -10, 100, 20);
    const c = OBox.transformCorners(local, Mat.rotation(45 * DEG));
    const aabb = OBox.cornersBounds(c);
    // The AABB's top-left corner is dead padding for a 45° layer.
    const padding = { x: aabb.x + 2, y: aabb.y + 2 };
    expect(R.containsPoint(aabb, padding)).toBe(true);
    expect(OBox.cornersContainPoint(c, padding)).toBe(false);
    // The centre is inside both.
    expect(OBox.cornersContainPoint(c, { x: 0, y: 0 })).toBe(true);
  });

  it('handles a mirrored (negative-scale) layer, either winding', () => {
    const local = R.rect(-40, -20, 80, 40);
    const mirrored = OBox.transformCorners(local, Mat.scaling(-1, 1));
    expect(OBox.cornersContainPoint(mirrored, { x: 0, y: 0 })).toBe(true);
    expect(OBox.cornersContainPoint(mirrored, { x: 100, y: 0 })).toBe(false);
  });

  it('a degenerate (zero-area) box does not swallow everything', () => {
    const flat = OBox.transformCorners(R.rect(0, 0, 0, 0), Mat.identity());
    expect(OBox.rectIntersectsCorners(R.rect(50, 50, 10, 10), flat)).toBe(false);
  });

  it('SAT agrees with rect intersection for an unrotated box', () => {
    const local = R.rect(0, 0, 100, 50);
    const c = OBox.transformCorners(local, Mat.identity());
    for (const probe of [R.rect(-10, -10, 20, 20), R.rect(200, 200, 5, 5), R.rect(40, 20, 5, 5), R.rect(99, 49, 4, 4)]) {
      expect(OBox.rectIntersectsCorners(probe, c)).toBe(R.intersects(probe, local));
    }
  });
});

describe('C2 acceptance — the box rotates with the layer', () => {
  it('a layer at 30° gets a 30° box that still encloses it', () => {
    const n = makeNode('a', 0, 0, 200, 40, 30);
    const c = n.worldCorners!;
    expect(Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x) / DEG).toBeCloseTo(30, 6);
    // Every local corner maps inside the drawn box.
    for (const p of R.corners(n.localBounds)) {
      expect(OBox.cornersContainPoint(c, Mat.apply(n.worldMatrix, p), 1e-6)).toBe(true);
    }
  });
});

describe('C2 acceptance — one box per selected layer', () => {
  const nodes = [makeNode('a', 0, 0, 100, 100), makeNode('b', 500, 0, 100, 100), makeNode('c', 0, 500, 100, 100)];
  const scene = sceneOf(nodes);

  it('three layers selected gives three boxes, not one merged rectangle', () => {
    const sel = selectionPortOf();
    const ctrl = new SelectionController(scene, sel, new HitTester(scene));
    sel.set(['a', 'b', 'c'] as NodeId[]);
    expect(ctrl.selectionBoxes()).toHaveLength(3);
  });

  it('each box belongs to its own layer, not to the group', () => {
    const sel = selectionPortOf();
    const ctrl = new SelectionController(scene, sel, new HitTester(scene));
    sel.set(['a', 'b'] as NodeId[]);
    const boxes = ctrl.selectionBoxes();
    for (const box of boxes) {
      const b = OBox.cornersBounds(box.corners);
      expect(b.width).toBeCloseTo(100, 6);
      expect(b.height).toBeCloseTo(100, 6);
    }
    // Each box names the layer it came from, which is what lets the painter
    // tint it with that layer's label colour. Without the id the drawn boxes
    // are anonymous and the timeline-row linkage is unbuildable.
    expect(boxes.map((b) => b.id)).toEqual(['a', 'b']);
    // The union AABB is still available for the tools that need one, and it is
    // much bigger than any individual box — which is exactly why it must not be
    // what gets drawn.
    expect(ctrl.selectionBounds()!.width).toBeCloseTo(600, 6);
  });

  it('no selection gives no boxes', () => {
    const sel = selectionPortOf();
    const ctrl = new SelectionController(scene, sel, new HitTester(scene));
    expect(ctrl.selectionBoxes()).toEqual([]);
  });
});

describe('C2 consequence — hit-testing against an oriented box', () => {
  // A 100×20 bar rotated 45°: its AABB is ~85×85, so the AABB corners are a
  // large region that looks selectable and is not.
  const bar = makeNode('bar', 0, 0, 100, 20, 45);
  const scene = sceneOf([bar]);

  /** A point well inside the AABB's corner padding but outside the bar. */
  const padding: Vec2 = { x: -38, y: -38 };

  it('the padding point really is inside the AABB (the premise)', () => {
    expect(R.containsPoint(bar.worldBounds, padding)).toBe(true);
  });

  it('clicking the layer selects it', () => {
    const hit = new HitTester(scene);
    expect(hit.hitTest({ x: 0, y: 0 })?.id).toBe('bar');
  });

  it('clicking the former AABB padding does NOT select it', () => {
    // VERIFIED, not assumed: the point-hit path was already oriented — it
    // inverts worldMatrix and defers to `hitTestLocal`. The AABB is broad phase
    // only. This test exists to keep it that way.
    const hit = new HitTester(scene);
    expect(hit.hitTest(padding)).toBeNull();
  });

  it('a marquee over only the padding does NOT select it', () => {
    // This one WAS broken: hitTestRegion compared rect-to-AABB, so a rubber
    // band that never touched the bar still caught it.
    const hit = new HitTester(scene);
    // The dead region for a 45° bar is the small triangle between its short end
    // edge and the AABB corner. This band sits entirely inside it: the end edge
    // lies on x + y = -70.7, and every corner of the band is below that.
    const band = R.rect(-42, -42, 5, 5);
    expect(R.intersects(band, bar.worldBounds)).toBe(true); // old behaviour would select
    expect(hit.hitTestRegion(band, 'intersect')).toEqual([]);
  });

  it('a marquee that does touch the layer still selects it', () => {
    const hit = new HitTester(scene);
    expect(hit.hitTestRegion(R.rect(-5, -5, 10, 10), 'intersect').map((n) => n.id)).toEqual(['bar']);
  });

  it('contain-mode needs the whole oriented box inside, not its AABB', () => {
    const hit = new HitTester(scene);
    const snug = OBox.cornersBounds(bar.worldCorners!);
    expect(hit.hitTestRegion(R.inflate(snug, 1), 'contain').map((n) => n.id)).toEqual(['bar']);
    // Half the layer is not the whole layer.
    expect(hit.hitTestRegion(R.rect(snug.x, snug.y, snug.width / 2, snug.height), 'contain')).toEqual([]);
  });

  it('falls back to the AABB for an adapter with no worldCorners', () => {
    const legacy: WorkspaceNode = { ...makeNode('legacy', 0, 0, 100, 20, 45), worldCorners: undefined };
    const hit = new HitTester(sceneOf([legacy]));
    // Degrades to the old axis-aligned behaviour rather than breaking.
    expect(hit.hitTestRegion(R.rect(-46, -46, 12, 12), 'intersect').map((n) => n.id)).toEqual(['legacy']);
  });
});
