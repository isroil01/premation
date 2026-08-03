/**
 * Where a composition's responsive-time configuration lives, and how the time
 * axis reads it (M7).
 *
 * Stored as `__responsiveTime` on the comp root's meta component — the same
 * `__`-prefixed convention `__templateFields` uses, so it travels with the scene
 * like any other node data and stays out of the generic inspector.
 *
 * Read through `readResponsiveTime` ONLY. It is consulted per keyframe sample on
 * the hot path, so the miss case (no config, which is every non-template comp)
 * must cost one property lookup and nothing else — no allocation, no walk.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { bumpScene } from '@stores/sceneStore';
import type { ProtectedRegion } from './responsiveTime';

const PROP = '__responsiveTime';

export interface ResponsiveTimeConfig {
  /** The duration the template's animation was authored against. */
  authoredDurationSec: number;
  /** Spans of AUTHORED time that keep their duration under any stretch. */
  protectedRegions: ProtectedRegion[];
}

function isConfig(v: unknown): v is ResponsiveTimeConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as ResponsiveTimeConfig;
  return typeof c.authoredDurationSec === 'number' && Array.isArray(c.protectedRegions);
}

/** The comp's responsive-time config, or undefined when it has none. */
export function readResponsiveTime(rootId: string): ResponsiveTimeConfig | undefined {
  const node = defaultSceneGraph.getNode(rootId);
  if (!node) return undefined;
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[PROP];
    if (isConfig(v)) return v;
  }
  return undefined;
}

/**
 * Mark the comp's protected regions.
 *
 * `authoredDurationSec` is captured at the moment of marking, NOT read live from
 * the comp: it is the length the animation was designed against, and the whole
 * point is that it stays fixed while the comp's actual duration changes around
 * it. Re-deriving it from the comp would make the map an identity forever.
 */
export function setResponsiveTime(
  rootId: string,
  config: ResponsiveTimeConfig | undefined,
): void {
  const node = defaultSceneGraph.getNode(rootId);
  const componentId = node?.components[0]?.id;
  if (!componentId) return;
  // MUST go through `writeProp`. `getNode` hands back a copy, so mutating
  // `component.props` in place is silently discarded — the value never reaches
  // the graph, `readResponsiveTime` keeps returning undefined, and the control
  // looks like it does nothing. Caught by driving the real UI, not by types:
  // the in-place version compiled and passed every unit test, because the tests
  // mocked the graph with a plain object that DOES retain mutations.
  defaultSceneGraph.writeProp(rootId, componentId, PROP, config ?? undefined);
  bumpScene();
}

/** Convenience for the active composition. */
export function readActiveResponsiveTime(): ResponsiveTimeConfig | undefined {
  return readResponsiveTime(activeCompRootId());
}
