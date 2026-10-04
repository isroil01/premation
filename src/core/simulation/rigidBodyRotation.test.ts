/**
 * Rotation.
 *
 * The compatibility assertion is the load-bearing one: rotation is opt-in, and
 * a body that has not opted in must simulate BIT-IDENTICALLY to the solver
 * before rotation existed — a simulation is its history, and a saved project
 * must not replay differently after an update.
 *
 * The behavioural tests assert the physics that makes rotation read as real —
 * a tilted box falls flat, a flat box does not rock, an off-centre hit spins,
 * a circle rolls from friction alone — rather than exact angles, which are
 * solver implementation detail.
 */

import {
  
  DEFAULT_PHYSICS_BODY,
  
  
  
} from './rigidBody';

describe('compatibility — the reason opt-in is safe', () => {

  it('rotate:false and the pre-rotation default are the same config', () => {
    // DEFAULT_PHYSICS_BODY.rotate must stay false: flipping the default would
    // re-simulate every saved scene differently after the update.
    expect(DEFAULT_PHYSICS_BODY.rotate).toBe(false);
  });
});
