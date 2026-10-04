/**
 * Bounce through the engine API: the Bounce generator (core/animation/
 * bounce.ts) keys Position / Scale member tracks and reads back its own keys
 * to place the rebounds, so it runs on a scratch copy of the layer's stored
 * keyframes and its result is sent as `setMemberKeyframes` — one undo entry,
 * "Bounce" (core/engine/memberEdits.ts).
 */

import { applyBounce, type BounceRequest, type BounceResult } from '@core/animation/bounce';
import { memberKeysEdit } from '@core/engine/memberEdits';

/** Resolves to what was keyed, or null when nothing bounced or the edit was refused (toasted). */
export async function bounceEdit(nodeId: string, req: BounceRequest): Promise<BounceResult | null> {
  const { value, ok } = await memberKeysEdit('Bounce', nodeId, (engine) => applyBounce(nodeId, req, engine));
  return ok ? value ?? null : null;
}
