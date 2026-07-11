/**
 * Keyframe id codec — the single source of truth for how a timeline keyframe
 * diamond is addressed. The track builder encodes ids; the edit handlers decode
 * them. Keeping both in one module means the format can never drift.
 *
 * Node ids and property paths never contain the "::" separator.
 */

const SEP = '::';

export interface KeyframeRefParts {
  nodeId: string;
  prop: string;
  t: number;
}

export function makeKeyframeId(nodeId: string, prop: string, t: number): string {
  return `${nodeId}${SEP}${prop}${SEP}${t}`;
}

export function parseKeyframeId(id: string): KeyframeRefParts | null {
  const parts = id.split(SEP);
  if (parts.length !== 3) return null;
  const t = Number(parts[2]);
  if (!Number.isFinite(t)) return null;
  return { nodeId: parts[0]!, prop: parts[1]!, t };
}
