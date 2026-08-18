/**
 * Wiring the rigid-body solver to layers.
 *
 * One `SimulationCache` PER COMPOSITION, not per layer: bodies collide with
 * each other, so they share a history. A cache per layer would mean each body
 * simulated in a world where the others did not exist, which is not a cheaper
 * approximation — it is a different, wrong answer that happens to look like
 * physics until two objects pass through one another.
 *
 * The cache is dropped whenever anything that shapes the history changes — a
 * body's mass, the gravity, the set of bodies, the frame rate. Reusing a cache
 * across such a change would replay the OLD history and present it as the new
 * one, which is the same class of bug as serving a cached frame after an edit.
 */

import { SimulationCache } from './simulationCore';
import {
  createRigidBodySim,
  DEFAULT_PHYSICS_BODY,
  type BodySeed,
  type PhysicsBodyConfig,
  type PhysicsState,
  type PhysicsWorld,
} from './rigidBody';
import { renderComponentsOf } from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';

/** Stored on the layer's fx component. */
export const PHYSICS_PROP = '__physics';

/** The physics config on a node, or null when absent/disabled. */
export function readNodePhysics(node: SceneNode | undefined): PhysicsBodyConfig | null {
  if (!node) return null;
  for (const c of renderComponentsOf(node)) {
    const raw = (c.props as Record<string, unknown>)[PHYSICS_PROP];
    if (!raw || typeof raw !== 'object') continue;
    const cfg = { ...DEFAULT_PHYSICS_BODY, ...(raw as Partial<PhysicsBodyConfig>) };
    return cfg.enabled ? cfg : null;
  }
  return null;
}

/** The stored config including a disabled one — for the inspector. */
export function readNodePhysicsRaw(node: SceneNode | undefined): PhysicsBodyConfig {
  if (!node) return DEFAULT_PHYSICS_BODY;
  for (const c of renderComponentsOf(node)) {
    const raw = (c.props as Record<string, unknown>)[PHYSICS_PROP];
    if (raw && typeof raw === 'object') {
      return { ...DEFAULT_PHYSICS_BODY, ...(raw as Partial<PhysicsBodyConfig>) };
    }
  }
  return DEFAULT_PHYSICS_BODY;
}

interface Entry {
  signature: string;
  cache: SimulationCache<PhysicsState>;
}

const caches = new Map<string, Entry>();

/**
 * Everything that shapes the step history.
 *
 * Seed POSITIONS are in here too: a body's start pose is where the whole
 * history begins, so nudging a layer has to restart the sim rather than replay
 * a fall from where it used to be.
 */
function signatureOf(seeds: ReadonlyArray<BodySeed>, world: PhysicsWorld, fps: number): string {
  return JSON.stringify({
    fps,
    g: [world.gravityX, world.gravityY],
    b: world.bounds,
    it: world.iterations,
    s: seeds.map((s) => [s.id, s.x, s.y, s.rotation ?? 0, s.width, s.height, s.cfg.kind, s.cfg.shape, s.cfg.mass, s.cfg.restitution, s.cfg.friction, s.cfg.damping, s.cfg.rotate]),
  });
}

/**
 * Simulated poses at `frame`, keyed by node id. Empty when nothing simulates.
 *
 * `rotation` (degrees, matching the layer property) is present only for bodies
 * that OPTED INTO spin — reporting an angle for a rotation-locked body would
 * overwrite the layer's own keyframed rotation with a constant 0, turning the
 * opt-out into a rotation freeze.
 */
export function physicsPosesAt(
  compKey: string,
  seeds: ReadonlyArray<BodySeed>,
  world: PhysicsWorld,
  fps: number,
  frame: number,
): Map<string, { x: number; y: number; rotation?: number }> {
  const out = new Map<string, { x: number; y: number; rotation?: number }>();
  if (seeds.length === 0) return out;

  const signature = signatureOf(seeds, world, fps);
  let entry = caches.get(compKey);
  if (!entry || entry.signature !== signature) {
    entry = { signature, cache: new SimulationCache(createRigidBodySim(seeds, world, fps)) };
    caches.set(compKey, entry);
  }

  // A seek far past the end is a guard, not a correctness device — clamp to a
  // non-negative frame rather than letting a negative one pre-roll backwards.
  const state = entry.cache.stateAt(Math.max(0, Math.floor(frame)));
  for (const b of state.bodies) {
    // STATIC bodies are deliberately not reported: their pose is whatever the
    // layer's own transform says, including any animation on it. Overriding
    // them with the solver's copy would freeze a keyframed wall in place.
    if (b.invMass === 0) continue;
    out.set(b.id, {
      x: b.x,
      y: b.y,
      ...(b.invInertia !== 0 ? { rotation: (b.angle * 180) / Math.PI } : {}),
    });
  }
  return out;
}

/** Drop every cached simulation. For tests and for a hard scene reset. */
export function resetPhysicsCaches(): void {
  caches.clear();
}
