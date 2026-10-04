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

import {
  DEFAULT_PHYSICS_BODY,
  type BodySeed,
  type PhysicsBodyConfig,
  type PhysicsState,
  type PhysicsWorld,
} from './rigidBody';
export {
  DEFAULT_PHYSICS_BODY,
  type BodySeed,
  type PhysicsBodyConfig,
  type PhysicsState,
  type PhysicsWorld,
};
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

/** True when the layer carries a physics prop (enabled or not). */
export function nodeHasPhysics(node: SceneNode | undefined): boolean {
  if (!node) return false;
  for (const c of renderComponentsOf(node)) {
    const raw = (c.props as Record<string, unknown>)[PHYSICS_PROP];
    if (raw && typeof raw === 'object') return true;
  }
  return false;
}
