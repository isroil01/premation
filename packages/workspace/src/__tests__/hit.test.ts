import { SpatialIndex } from '../hit/SpatialIndex';
import { HitTester } from '../hit/HitTester';
import { MemoryScene } from '../adapters/memory';
import type { SceneGraphPort, WorkspaceNode } from '../ports';
import * as R from '../math/Rect';

describe('SpatialIndex', () => {
  it('finds items at a point after subdividing', () => {
    const index = new SpatialIndex(R.rect(0, 0, 1000, 1000), { maxItemsPerNode: 2 });
    for (let i = 0; i < 50; i++) {
      index.insert({ id: `n${i}`, bounds: R.rect(i * 10, i * 10, 8, 8) });
    }
    expect(index.size).toBe(50);
    const hits = index.queryPoint({ x: 104, y: 104 });
    expect(hits.some((h) => h.id === 'n10')).toBe(true); // n10 at (100,100,8,8)
  });

  it('queries a region', () => {
    const index = new SpatialIndex(R.rect(0, 0, 1000, 1000));
    index.rebuild([
      { id: 'a', bounds: R.rect(0, 0, 10, 10) },
      { id: 'b', bounds: R.rect(500, 500, 10, 10) },
      { id: 'c', bounds: R.rect(5, 5, 10, 10) },
    ]);
    const ids = index.queryRect(R.rect(0, 0, 20, 20)).map((i) => i.id).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('scales to many objects', () => {
    const index = new SpatialIndex(R.rect(0, 0, 10000, 10000), { maxDepth: 10 });
    const items = [];
    for (let i = 0; i < 10000; i++) {
      const x = (i % 100) * 100;
      const y = Math.floor(i / 100) * 100;
      items.push({ id: `n${i}`, bounds: R.rect(x, y, 20, 20) });
    }
    index.rebuild(items);
    const hits = index.queryPoint({ x: 5005, y: 5005 });
    // Broad-phase should return a small candidate set, not all 10k.
    expect(hits.length).toBeLessThan(20);
  });
});

describe('HitTester', () => {
  function scene() {
    return new MemoryScene([
      { id: 'bottom', bounds: R.rect(0, 0, 100, 100), zIndex: 0 },
      { id: 'top', bounds: R.rect(50, 50, 100, 100), zIndex: 5 },
      { id: 'hidden', bounds: R.rect(0, 0, 200, 200), zIndex: 10, visible: false },
      { id: 'locked', bounds: R.rect(160, 160, 20, 20), zIndex: 1, locked: true },
    ]);
  }

  it('returns the topmost node by zIndex', () => {
    const ht = new HitTester(scene());
    const hit = ht.hitTest({ x: 75, y: 75 });
    expect(hit?.id).toBe('top');
  });

  it('skips hidden and locked nodes by default', () => {
    const ht = new HitTester(scene());
    // Point only over 'hidden' (and nothing else) → no hit.
    expect(ht.hitTest({ x: 175, y: 10 })).toBeNull();
    // Over the locked node only → no hit unless included.
    expect(ht.hitTest({ x: 170, y: 170 })).toBeNull();
    expect(ht.hitTest({ x: 170, y: 170 }, { includeLocked: true })?.id).toBe('locked');
  });

  it('honors precise local hit tests', () => {
    const s = new MemoryScene([
      {
        id: 'circle',
        bounds: R.rect(0, 0, 100, 100),
        // Only the inscribed circle counts as a hit.
        hitTestLocal: (p) => Math.hypot(p.x - 50, p.y - 50) <= 50,
      },
    ]);
    const ht = new HitTester(s);
    expect(ht.hitTest({ x: 50, y: 50 })?.id).toBe('circle'); // center
    expect(ht.hitTest({ x: 2, y: 2 })).toBeNull(); // corner, inside AABB but outside circle
  });

  it('selects a region by contain vs intersect', () => {
    const ht = new HitTester(scene());
    const region = R.rect(-10, -10, 120, 120);
    const contained = ht.hitTestRegion(region, 'contain').map((n) => n.id);
    expect(contained).toContain('bottom');
    expect(contained).not.toContain('top'); // top extends past the region
    const crossing = ht.hitTestRegion(region, 'intersect').map((n) => n.id);
    expect(crossing).toContain('top');
  });

  it('rebuilds when the scene changes', () => {
    const s = scene();
    const ht = new HitTester(s);
    s.put({ id: 'new', bounds: R.rect(300, 300, 50, 50), zIndex: 20 });
    ht.rebuild();
    expect(ht.hitTest({ x: 320, y: 320 })?.id).toBe('new');
  });
});

describe('HitTester lazy rebuild', () => {
  // Scene changes vastly outnumber pointer interactions — every keyframe write
  // and playhead tick invalidates the index, but only a click consumes it.
  // markDirty must defer the (full scene enumeration) rebuild to the next
  // query, and one rebuild must answer for any number of bumps.

  it('markDirty defers the rebuild until a query needs it', () => {
    const s = new MemoryScene([{ id: 'a', bounds: R.rect(0, 0, 10, 10) }]);
    const ht = new HitTester(s);
    let enumerations = 0;
    const orig = s.getNodes.bind(s);
    s.getNodes = () => { enumerations++; return orig(); };

    ht.markDirty();
    ht.markDirty();
    ht.markDirty();
    expect(enumerations).toBe(0); // no query yet — nothing paid

    expect(ht.hitTest({ x: 5, y: 5 })?.id).toBe('a');
    expect(enumerations).toBe(1); // all three bumps answered by ONE rebuild

    expect(ht.hitTest({ x: 5, y: 5 })?.id).toBe('a');
    expect(enumerations).toBe(1); // clean index is not rebuilt again
  });

  it('a query after markDirty sees the changed scene', () => {
    const s = new MemoryScene([{ id: 'a', bounds: R.rect(0, 0, 10, 10) }]);
    const ht = new HitTester(s);
    expect(ht.hitTest({ x: 105, y: 105 })).toBeNull();

    s.put({ id: 'b', bounds: R.rect(100, 100, 10, 10) }, false);
    ht.markDirty();
    expect(ht.hitTest({ x: 105, y: 105 })?.id).toBe('b');
  });

  it('hitTestRegion and indexSize also refresh a dirty index', () => {
    const s = new MemoryScene([{ id: 'a', bounds: R.rect(0, 0, 10, 10) }]);
    const ht = new HitTester(s);
    s.put({ id: 'b', bounds: R.rect(50, 50, 10, 10) }, false);
    ht.markDirty();
    expect(ht.hitTestRegion(R.rect(40, 40, 30, 30)).map((n) => n.id)).toEqual(['b']);
    ht.markDirty();
    expect(ht.indexSize).toBe(2);
  });
});

/**
 * A flat 3D layer seen exactly edge-on (the Left / Right / Top / Bottom views)
 * projects to zero area: its world matrix is singular, so `Mat.invert` has
 * nothing to return and every local-space hit test is unreachable. The layer was
 * therefore unclickable in those views — selectable only from the timeline,
 * which is not how After Effects behaves.
 *
 * The numbers below reproduce the measured real case: a 400×300 layer in Left
 * view, whose four projected corners collapse onto a vertical segment.
 */
describe('HitTester — edge-on (degenerate) layers', () => {
  const EDGE_ON_MATRIX = { a: 0, b: 0, c: 0, d: 1, e: 500, f: 400 };

  /** One layer whose projection has collapsed to the segment x=500, y∈[250,550]. */
  function edgeOnScene(): SceneGraphPort {
    const node: WorkspaceNode = {
      id: 'edge',
      parentId: null,
      worldBounds: R.rect(500, 250, 0, 300), // zero-width: the collapsed axis
      worldCorners: [
        { x: 500, y: 250 },
        { x: 500, y: 250 },
        { x: 500, y: 550 },
        { x: 500, y: 550 },
      ],
      worldMatrix: EDGE_ON_MATRIX,
      localBounds: R.rect(-200, -150, 400, 300),
      visible: true,
      locked: false,
      zIndex: 0,
      is3D: true,
      hitTestLocal: () => true,
    };
    return {
      getNodes: () => [node],
      getNode: (id) => (id === 'edge' ? node : undefined),
      onChanged: () => () => {},
    };
  }

  it('is unreachable without an edge tolerance (the default stays exact)', () => {
    const ht = new HitTester(edgeOnScene());
    expect(ht.hitTest({ x: 500, y: 400 })).toBeNull();
  });

  it('hits the projected hairline when a tolerance is supplied', () => {
    const ht = new HitTester(edgeOnScene(), undefined, () => 5);
    expect(ht.hitTest({ x: 500, y: 400 })?.id).toBe('edge'); // dead on
    expect(ht.hitTest({ x: 503, y: 400 })?.id).toBe('edge'); // within slack
    expect(ht.hitTest({ x: 497, y: 400 })?.id).toBe('edge'); // other side
  });

  it('does not become a wide invisible click target', () => {
    const ht = new HitTester(edgeOnScene(), undefined, () => 5);
    expect(ht.hitTest({ x: 520, y: 400 })).toBeNull(); // past the slack
  });

  it('stays bounded along the line — the layer has ends', () => {
    const ht = new HitTester(edgeOnScene(), undefined, () => 5);
    expect(ht.hitTest({ x: 500, y: 700 })).toBeNull(); // below the segment
    expect(ht.hitTest({ x: 500, y: 100 })).toBeNull(); // above it
  });

  it('marquee selection reaches it too', () => {
    const ht = new HitTester(edgeOnScene(), undefined, () => 5);
    expect(ht.hitTestRegion(R.rect(450, 300, 100, 100)).map((n) => n.id)).toEqual(['edge']);
    expect(ht.hitTestRegion(R.rect(0, 0, 100, 100))).toEqual([]);
  });

  it('the tolerance is read per query, so it tracks a changing zoom', () => {
    let tol = 0;
    const ht = new HitTester(edgeOnScene(), undefined, () => tol);
    expect(ht.hitTest({ x: 503, y: 400 })).toBeNull();
    tol = 5; // as if the user zoomed in
    expect(ht.hitTest({ x: 503, y: 400 })?.id).toBe('edge');
  });

  it('layers WITH projected area are unaffected — still exact', () => {
    const s = new MemoryScene([{ id: 'solid', bounds: R.rect(0, 0, 100, 100) }]);
    const ht = new HitTester(s, undefined, () => 5);
    expect(ht.hitTest({ x: 50, y: 50 })?.id).toBe('solid');
    // A widened BROAD phase must not widen the precise answer: 5px outside the
    // rect is now a candidate, and must still miss.
    expect(ht.hitTest({ x: 103, y: 50 })).toBeNull();
  });
});
