/**
 * Sync reconciliation — the chunk-level 3-way merge that makes most
 * multi-device divergence a clean fast-forward and flags only true same-chunk
 * conflicts.
 */

import { diffForPush, reconcile } from './manifestDiff';

describe('diffForPush', () => {
  it('uploads new/changed local chunks and deletes remote-only ones', () => {
    const local = { scene: 'a', animation: 'b2', meta: 'm' };
    const remote = { scene: 'a', animation: 'b1', timeline: 't' };
    const { put, delete: del } = diffForPush(local, remote);
    expect(put).toEqual([{ name: 'animation', hash: 'b2' }, { name: 'meta', hash: 'm' }]);
    expect(del).toEqual(['timeline']);
  });
});

describe('reconcile (3-way)', () => {
  it('does nothing when both sides already agree', () => {
    const m = { scene: 'a', animation: 'b' };
    expect(reconcile(m, m, m)).toEqual({ pull: [], push: [], conflicts: [] });
  });

  it('pulls a chunk only the remote changed', () => {
    const base = { scene: 'a', animation: 'b' };
    const local = { scene: 'a', animation: 'b' };
    const remote = { scene: 'a', animation: 'b2' };
    expect(reconcile(base, local, remote)).toEqual({
      pull: [{ name: 'animation', hash: 'b2' }], push: [], conflicts: [],
    });
  });

  it('pushes a chunk only the local changed', () => {
    const base = { scene: 'a', animation: 'b' };
    const local = { scene: 'a2', animation: 'b' };
    const remote = { scene: 'a', animation: 'b' };
    expect(reconcile(base, local, remote)).toEqual({
      pull: [], push: [{ name: 'scene', hash: 'a2' }], conflicts: [],
    });
  });

  it('fast-forwards disjoint edits (A edits animation, B edits scene) with no conflict', () => {
    const base = { scene: 'a', animation: 'b' };
    const local = { scene: 'a', animation: 'b2' }; // this device changed animation
    const remote = { scene: 'a3', animation: 'b' }; // server changed scene
    const r = reconcile(base, local, remote);
    expect(r.conflicts).toEqual([]);
    expect(r.pull).toEqual([{ name: 'scene', hash: 'a3' }]);
    expect(r.push).toEqual([{ name: 'animation', hash: 'b2' }]);
  });

  it('flags a true conflict when the same chunk changed differently on both sides', () => {
    const base = { animation: 'b' };
    const local = { animation: 'bL' };
    const remote = { animation: 'bR' };
    expect(reconcile(base, local, remote)).toEqual({ pull: [], push: [], conflicts: ['animation'] });
  });

  it('is not a conflict when both sides made the SAME change', () => {
    const base = { animation: 'b' };
    const same = { animation: 'bSame' };
    expect(reconcile(base, same, same)).toEqual({ pull: [], push: [], conflicts: [] });
  });

  it('handles additions and deletions', () => {
    // local added `guides`; remote deleted `meta`
    const base = { scene: 'a', meta: 'm' };
    const local = { scene: 'a', meta: 'm', guides: 'g' };
    const remote = { scene: 'a' };
    const r = reconcile(base, local, remote);
    expect(r.push).toEqual([{ name: 'guides', hash: 'g' }]);
    expect(r.pull).toEqual([{ name: 'meta', hash: undefined }]); // remote deletion → delete locally
    expect(r.conflicts).toEqual([]);
  });
});
