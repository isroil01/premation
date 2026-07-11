import { SpatialIndex } from '../hit/SpatialIndex';
import { HitTester } from '../hit/HitTester';
import { MemoryScene } from '../adapters/memory';
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
