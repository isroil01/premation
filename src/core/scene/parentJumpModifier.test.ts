/**
 * Alt-parenting — After Effects' "jump" variant of the parent gesture.
 *
 * The default compensates, so the layer does not move when you parent it. Alt
 * says "keep my values", so the layer moves into the parent's coordinate space
 * instead. Both are correct; which one you want depends on whether the child's
 * numbers were authored in comp space or already in the parent's.
 *
 * `parentOptionsFor` is the single translation from a held modifier to the
 * option, shared by all four parenting surfaces (the inspector picker, the
 * compositing panel, the timeline's Parent & Link column, and the pick-whip on
 * each). It is unit-tested here because a modifier that means different things
 * on different surfaces is worse than no modifier at all.
 */


import {  parentOptionsFor } from './parenting';

beforeEach(() => {
});

describe('parentOptionsFor — modifier to option', () => {
  test('no modifier keeps the default (compensate, layer stays put)', () => {
    expect(parentOptionsFor(undefined)).toBeUndefined();
    expect(parentOptionsFor({ altKey: false })).toBeUndefined();
  });

  test('Alt asks for the jump variant', () => {
    expect(parentOptionsFor({ altKey: true })).toEqual({ preserveWorld: false });
  });
});
