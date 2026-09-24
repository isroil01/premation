/**
 * One DIMENSION's expression of a property, over the document MIRROR (B4).
 * Pure: it reads a `PropertyInfo` and nothing else.
 *
 * The API keeps one expression per property (`expression`,
 * `expressionEnabled`, `expressionError`) and, when the dimensions of an
 * UNSEPARATED vector do not all carry the same one, lists every dimension that
 * has its own in `memberExpressions` (setExpression `member`). This answers the
 * legacy per-track question ("does Y of Position carry an expression?",
 * `defaultAnimation.hasExpression(id, 'y')`) from that record.
 */

import type { LayerInfo, PropertyInfo } from '@motion/engine-api';
import { trackRefIn, type MirrorTreeLike } from './trackIndex';

export interface MemberExpressionFacts {
  source: string;
  enabled: boolean;
  error: string;
}

/** The expression dimension `member` of `info` carries, or null when it has none. */
export function memberExpressionOf(info: PropertyInfo | undefined, member: number): MemberExpressionFacts | null {
  if (!info) return null;
  const per = info.memberExpressions ?? [];
  if (per.length > 0) {
    const e = per.find((x) => x.member === member);
    return e && e.source !== '' ? { source: e.source, enabled: e.enabled, error: e.error } : null;
  }
  // One shared expression (or none) for every dimension.
  return info.expression !== '' ? { source: info.expression, enabled: info.expressionEnabled, error: info.expressionError } : null;
}

/** Whether dimension `member` of `info` carries an expression (enabled or not). */
export function memberHasExpression(info: PropertyInfo | undefined, member: number): boolean {
  return memberExpressionOf(info, member) !== null;
}

/**
 * The expression one legacy TRACK carries (`x` → Position's member 0, a
 * scalar → its property), or null when it has none or the layer has no such
 * track — the mirror twin of `defaultAnimation.hasExpression` /
 * `isExpressionEnabled` for a row's context menu.
 */
export function trackExpressionFacts(
  m: { layer(id: string): LayerInfo | undefined; tree(id: string): MirrorTreeLike | undefined },
  nodeId: string,
  track: string,
): MemberExpressionFacts | null {
  if (!m.layer(nodeId)) return null;
  const ref = trackRefIn(m.tree(nodeId), track);
  return ref ? memberExpressionOf(ref.info, ref.member) : null;
}
