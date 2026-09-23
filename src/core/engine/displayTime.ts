/**
 * READ-side time conversion for display (B3z).
 *
 * The ratchet flags `compToKeyframeTime` in UI code because the UI must not
 * send keyframe-axis times to the engine: commands take composition time
 * (flicks) and the engine converts per layer (B3_PATTERNS §4). Overlays and
 * editors still have to DRAW a layer's animation at the playhead — sample a
 * mask path, a puppet pin or a gradient grip on the layer's keyframe axis —
 * and that read stays direct until B4's mirror serves sampled values.
 *
 * This is that read, and nothing else: the result must never be sent back in a
 * command (send comp time — `compTime(seconds)` — instead).
 */

import { compToKeyframeTime } from '@core/timeline/TimelineController';

/** The layer-local keyframe time (seconds) at which to SAMPLE `nodeId` for drawing at comp time `compSeconds`. */
export function keyAxisTimeForDisplay(nodeId: string, compSeconds: number, prop?: string): number {
  return compToKeyframeTime(nodeId, compSeconds, prop);
}
