/**
 * The physics WORLD — gravity, walls, solver passes.
 *
 * Per-composition settings would be the tidier home, but the world is read by
 * `buildSnapshot` on every frame and has to be reachable without threading it
 * through the snapshot signature; a store is how motion blur, draft 3D and
 * preview resolution already do exactly that. Per-BODY settings (mass,
 * restitution, shape) live on the layer, where they belong.
 *
 * Not persisted, for the same reason `onionSkinStore` is not: these are working
 * values, and coming back to an editor whose gravity is mysteriously sideways
 * because of a session last week is worse than a predictable default.
 */

import { create } from 'zustand';
import { DEFAULT_PHYSICS_WORLD } from '@core/simulation/rigidBody';

interface PhysicsState {
  gravityX: number;
  gravityY: number;
  /** Use the composition rectangle as walls. Off lets things leave the shot —
   *  a legitimate thing to want, and the only way to get an object to exit. */
  useCompBounds: boolean;
  iterations: number;
  set(patch: Partial<Omit<PhysicsState, 'set'>>): void;
}

export const usePhysicsStore = create<PhysicsState>((set) => ({
  gravityX: DEFAULT_PHYSICS_WORLD.gravityX,
  gravityY: DEFAULT_PHYSICS_WORLD.gravityY,
  useCompBounds: true,
  iterations: DEFAULT_PHYSICS_WORLD.iterations,
  set: (patch) =>
    set((s) => ({
      ...s,
      ...patch,
      // Clamped here rather than at the call sites: iterations is a per-frame
      // O(n²) sweep, so a slider that could ask for 500 passes would stall the
      // viewport long before the solver got a chance to be sensible about it.
      ...(patch.iterations !== undefined
        ? { iterations: Math.max(1, Math.min(20, Math.round(patch.iterations))) }
        : {}),
    })),
}));
