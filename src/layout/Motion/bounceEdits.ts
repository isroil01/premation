/**
 * Bounce through the engine API (B3z): the Bounce generator (core/animation/
 * bounce.ts) keys Position / Scale member tracks and reads back its own keys
 * to place the rebounds, so it runs off-document and its result is sent as
 * `setKeyframes` per property — one undo entry, "Bounce"
 * (core/engine/assistantKeys.ts).
 */

import { applyBounce, type BounceRequest, type BounceResult } from '@core/animation/bounce';
import { assistantKeyframesEdit } from '@core/engine/assistantKeys';

/** Resolves to what was keyed, or null when nothing bounced or the edit was refused (toasted). */
export async function bounceEdit(nodeId: string, req: BounceRequest): Promise<BounceResult | null> {
  const { value, ok } = await assistantKeyframesEdit('Bounce', [nodeId], () => applyBounce(nodeId, req));
  return ok ? value ?? null : null;
}
