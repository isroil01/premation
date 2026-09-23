/**
 * Keyframe id codec — the single source of truth for how a timeline keyframe
 * diamond is addressed. The track builder encodes ids; the edit handlers decode
 * them. Keeping both in one module means the format can never drift.
 *
 * Node ids and property paths never contain the "::" separator.
 */

const SEP = '::';

/**
 * The pseudo-property the timeline shows when Separate Dimensions is OFF (the
 * default): one "Position" row standing in for the x/y/z tracks.
 *
 * No track by this name exists in the engine, so anything acting on a keyframe
 * id must expand it via `expandKeyframeProp` first. Not doing so is a silent
 * no-op: `getTrackKeyframes(node, 'Position')` returns null, the loop hits
 * `continue`, and the user sees nothing happen — which is exactly how F9 came
 * to do nothing on the most-animated property in the app.
 */
export const POSITION_PSEUDO_PROP = 'Position';

/** The real engine track(s) a (possibly pseudo) property name refers to. */
export function expandKeyframeProp(prop: string): string[] {
  return prop === POSITION_PSEUDO_PROP ? ['x', 'y', 'z'] : [prop];
}

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

// ── Stable keyframe ids (ENGINE_API.md §3.3) ─────────────────────────
//
// The positional id above (`node::prop::t`) names a keyframe by WHERE it is,
// so moving it renames it and a pseudo-prop id names no real track (ENGINE_API
// §2.5 #4). The engine API addresses keys by an id stored ON the keyframe
// (`Keyframe.id`) instead: `k<n>`, minted from one per-document counter by the
// engine and by the 1.9.0 migration, never reused within a document. The
// positional codec stays for the pre-API timeline code until B3 retires it.

/** `k<n>` — the only stable id shape either minter writes. */
export function stableKeyframeId(n: number): string {
  return `k${n}`;
}

/** The counter value behind a stable id (`k17` → 17), or 0 for any other string. */
export function stableKeyframeIdSeq(id: string | undefined): number {
  if (!id) return 0;
  const m = /^k(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
