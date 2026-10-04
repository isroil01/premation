/**
 * Authoring-id allocation (§12.7) and rest-mesh cache bounding (§12.8).
 */

import { nextRigId, nextRigIds, usedRigIds } from './rigIds';

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
