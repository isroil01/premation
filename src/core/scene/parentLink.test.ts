/**
 * Parenting modifiers, After Effects' way round:
 *   plain  → keep the world pose (no jump)
 *   Shift  → Parent & Link JUMP: the child lands on the parent's anchor
 *   Alt    → legacy "keep values": local values reinterpreted under the parent
 */


import {  parentOptionsFor } from './parenting';

describe('parentOptionsFor', () => {
  it('maps Shift to jump, Alt to keep-values, nothing to the default', () => {
    expect(parentOptionsFor(undefined)).toBeUndefined();
    expect(parentOptionsFor({ altKey: false, shiftKey: false })).toBeUndefined();
    expect(parentOptionsFor({ shiftKey: true })).toEqual({ jump: true });
    expect(parentOptionsFor({ altKey: true })).toEqual({ preserveWorld: false });
    // Shift wins when both are held.
    expect(parentOptionsFor({ altKey: true, shiftKey: true })).toEqual({ jump: true });
  });
});
