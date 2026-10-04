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

import type { ProtectedRegion } from './responsiveTime';

export interface ResponsiveTimeConfig {
  /** The duration the template's animation was authored against. */
  authoredDurationSec: number;
  /** Spans of AUTHORED time that keep their duration under any stretch. */
  protectedRegions: ProtectedRegion[];
}
