/**
 * Authoring-id allocation (§12.7) and rest-mesh cache bounding (§12.8).
 */

import { nextRigId, nextRigIds, usedRigIds } from './rigIds';
import {
  buildRestMesh,
  getCachedRestMesh,
  clearRestMeshCache,
  restMeshCacheSize,
  type PuppetRig,
} from './puppet';

describe('§12.7 — collision-free rig ids', () => {
  it('allocates the lowest free ordinal', () => {
    expect(nextRigId('pin_', [])).toBe('pin_1');
    expect(nextRigId('pin_', ['pin_1'])).toBe('pin_2');
    expect(nextRigId('pin_', ['pin_1', 'pin_2', 'pin_3'])).toBe('pin_4');
  });

  it('fills gaps left by deletions', () => {
    expect(nextRigId('pin_', ['pin_1', 'pin_3'])).toBe('pin_2');
    expect(nextRigId('bone_', ['bone_2', 'bone_3'])).toBe('bone_1');
  });

  it('never reissues an id already in use', () => {
    const used = new Set(['pin_1', 'pin_2']);
    for (let i = 0; i < 50; i++) {
      const id = nextRigId('pin_', used);
      expect(used.has(id)).toBe(false);
      used.add(id);
    }
    expect(used.size).toBe(52);
  });

  it('a batch does not collide with itself', () => {
    const ids = nextRigIds('pin_', ['pin_1'], 5);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(['pin_2', 'pin_3', 'pin_4', 'pin_5', 'pin_6']);
  });

  it('legacy timestamp ids are respected but do not block short ordinals', () => {
    // A document saved before this change carries `pin_1753600000000` ids.
    const legacy = ['pin_1753600000000', 'pin_1753600000000_1'];
    expect(nextRigId('pin_', legacy)).toBe('pin_1');
    // …and the legacy ids are still treated as taken.
    expect(nextRigId('pin_', [...legacy, 'pin_1'])).toBe('pin_2');
  });

  it('is deterministic — no clock, no randomness', () => {
    const used = ['pin_1', 'pin_4'];
    const a = nextRigIds('pin_', used, 4);
    const b = nextRigIds('pin_', used, 4);
    expect(a).toEqual(b);
  });

  it('usedRigIds is undefined-safe', () => {
    expect(usedRigIds(undefined).size).toBe(0);
    expect(usedRigIds([{ id: 'a' }, { id: 'b' }])).toEqual(new Set(['a', 'b']));
  });

  it('two pins added back to back get distinct ids (the original bug)', () => {
    // Simulates the overlay's click-add twice in the same millisecond.
    const pins: Array<{ id: string }> = [];
    const first = nextRigId('pin_', usedRigIds(pins));
    pins.push({ id: first });
    const second = nextRigId('pin_', usedRigIds(pins));
    expect(second).not.toBe(first);
  });
});

describe('§12.8 — rest-mesh cache is bounded', () => {
  const rigWith = (n: number): PuppetRig => ({
    meshDensity: 6,
    meshExpansion: 0,
    pins: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, x: i * 3, y: 0 })),
  });

  beforeEach(() => clearRestMeshCache());

  it('never exceeds its cap no matter how many rig states are visited', () => {
    for (let i = 1; i <= 60; i++) {
      getCachedRestMesh(`node`, 80, 60, 0, rigWith(i % 5 === 0 ? 2 : 1));
      // Vary the key every iteration via mesh density.
      getCachedRestMesh(`node`, 80, 60, 0, { ...rigWith(1), meshDensity: 4 + (i % 40) });
      expect(restMeshCacheSize()).toBeLessThanOrEqual(16);
    }
  });

  it('still returns a correct mesh after eviction pressure', () => {
    const rig = rigWith(2);
    const fresh = buildRestMesh(80, 60, 0, rig);
    // Blow past the cap with unrelated keys.
    for (let i = 0; i < 40; i++) {
      getCachedRestMesh(`other${i}`, 80, 60, 0, { ...rigWith(1), meshDensity: 5 + i });
    }
    const after = getCachedRestMesh('node', 80, 60, 0, rig);
    expect(after.vertices.length).toBe(fresh.vertices.length);
    for (let i = 0; i < fresh.vertices.length; i++) {
      expect(Object.is(after.vertices[i], fresh.vertices[i])).toBe(true);
    }
  });

  it('LRU keeps the ACTIVE mesh resident under churn', () => {
    const active = rigWith(2);
    const first = getCachedRestMesh('active', 80, 60, 0, active);

    // Churn the cache with 15 other entries, touching the active mesh each time
    // — exactly the render-loop pattern. Under insertion-order eviction the
    // active entry would be dropped; under LRU it must survive by identity.
    for (let i = 0; i < 15; i++) {
      getCachedRestMesh(`churn${i}`, 80, 60, 0, { ...rigWith(1), meshDensity: 5 + i });
      expect(getCachedRestMesh('active', 80, 60, 0, active)).toBe(first);
    }
    expect(getCachedRestMesh('active', 80, 60, 0, active)).toBe(first);
  });
});
