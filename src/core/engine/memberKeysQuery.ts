/**
 * `getMemberKeyframes` (ENGINE_API.md §7, §15.12) — the TypeScript engine's
 * answer: every animated MEMBER track of a layer (AnimationEngine.animatedProps:
 * the keyed tracks, then the expression-only ones) with its keyframe records as
 * stored, and the API property that owns it. The C++ twin is in
 * native/engine/src/core/queries.cpp (`GetMemberKeyframes`).
 */

import type { GetMemberKeyframes, MemberTrack } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { catalogFor } from './props';
import { requireLayer } from './doc';

export function memberTracksAnswer(q: GetMemberKeyframes): MemberTrack[] {
  requireLayer(q.layer);
  const wanted = q.members.length > 0 ? new Set(q.members) : null;
  let byMember: ReadonlyMap<string, { path: string; members: readonly string[] }> = new Map();
  try {
    byMember = catalogFor(q.layer).byMember;
  } catch {
    byMember = new Map();
  }
  const out: MemberTrack[] = [];
  for (const member of defaultAnimation.animatedProps(q.layer)) {
    if (wanted && !wanted.has(member)) continue;
    const keys = defaultAnimation.getTrackKeyframes(q.layer, member) ?? [];
    const owner = byMember.get(member);
    out.push({
      member,
      path: owner?.path ?? '',
      index: owner ? Math.max(0, owner.members.indexOf(member)) : 0,
      keyframes: JSON.stringify(keys),
      count: keys.length,
      hasExpression: defaultAnimation.getExpressionSrc(q.layer, member) !== undefined,
    });
  }
  // B4 round 5: the keyed DATA tracks (text source, path points, gradient stops, puppet pins…), after the scalar ones.
  if (q.includeData === true) {
    for (const member of defaultAnimation.getDataAnimatedPropPaths(q.layer)) {
      if (wanted && !wanted.has(member)) continue;
      const keys = defaultAnimation.getDataTrack(q.layer, member)?.keyframes ?? [];
      const owner = byMember.get(member);
      out.push({
        member,
        path: owner?.path ?? '',
        index: owner ? Math.max(0, owner.members.indexOf(member)) : 0,
        keyframes: JSON.stringify(keys),
        count: keys.length,
        hasExpression: defaultAnimation.getExpressionSrc(q.layer, member) !== undefined,
        data: true,
      });
    }
  }
  return out;
}
