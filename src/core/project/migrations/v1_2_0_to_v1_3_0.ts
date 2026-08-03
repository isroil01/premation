/* eslint-disable no-restricted-syntax -- SAFE, verified.
 * Mutates a `structuredClone(doc)` — migrations must be pure, and the clone is
 * taken precisely so the caller's document is untouched. Never a graph node. */
/**
 * 1.2.0 → 1.3.0 — the path operator becomes a CHAIN.
 *
 * Before: `fx.pathOp` — one object, one operator per layer.
 * After:  `fx.pathOps` — an ordered array, as AE's shape contents list has
 *         always been. Round Corners then Zig-Zag gives soft ridges; the other
 *         order gives rounded spikes. A single slot cannot express either.
 *
 * ── THE HALF THAT IS EASY TO FORGET ─────────────────────────────────────────
 *
 * Moving the object into an array is three lines. The keyframes are the rest.
 *
 * Path-operator parameters animate through tracks keyed by property path, and
 * that path used to be `pathop.amount` — one namespace per layer, because there
 * could only ever be one operator. It is now `pathop.<opId>.amount`, scoped to
 * the operator so a reorder does not hand an operator its neighbour's
 * animation.
 *
 * So the migration has to rename the tracks as well as reshape the props, using
 * the SAME id it just assigned. Miss that and every animated path operator in
 * every existing project loses its keyframes — silently, because the shape
 * still renders, just frozen at its static value. That is the same failure mode
 * as the 1.1.0 → 1.2.0 matte migration's `sourceId`: nothing looks broken, it is
 * simply wrong, and nobody notices until they scrub.
 *
 * ── VERSION BUMP IS EXCLUSIVELY THIS CHANGE ─────────────────────────────────
 *
 * Nothing else rides on 1.3.0, deliberately. A failed migration has to be
 * bisectable to one transformation; bundling two means a corrupt document tells
 * you nothing about which half broke it.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';

interface NodeLike {
  id?: string;
  components?: Array<{ type?: string; props?: Record<string, unknown> }>;
  children?: NodeLike[];
}

/** Legacy `pathop.<param>` → the params that need re-keying. */
const LEGACY_TRACK_PREFIX = 'pathop.';

/**
 * Deterministic id for a migrated operator.
 *
 * NOT random. A migration must be a pure function of its input — the same
 * document in has to give the same document out, or two machines migrating the
 * same project produce documents that differ, and a version-history diff shows
 * a change nobody made. Derived from the node id, which is unique per document
 * and already stable.
 */
function migratedOpId(nodeId: string): string {
  return `op_${nodeId}`;
}

/**
 * Convert one node, collecting the track rename it implies.
 *
 * Returns the node's id and new operator id when it had a legacy operator, so
 * the caller can rewrite the animation tracks — which live in a different part
 * of the document entirely.
 */
function migrateNode(node: NodeLike, renames: Array<{ nodeId: string; opId: string }>): boolean {
  let changed = false;
  for (const c of node.components ?? []) {
    if (c.type !== 'fx' || !c.props) continue;

    const legacy = c.props.pathOp;
    // Already migrated, or never had one. An `fx` carrying BOTH is not a state
    // this codebase can produce, and preferring the new key is the safe read.
    if (Array.isArray(c.props.pathOps)) {
      if (legacy !== undefined) { delete c.props.pathOp; changed = true; }
      continue;
    }
    if (!legacy || typeof legacy !== 'object') continue;

    const nodeId = typeof node.id === 'string' ? node.id : '';
    const opId = migratedOpId(nodeId);

    c.props.pathOps = [{ ...(legacy as Record<string, unknown>), id: opId }];
    delete c.props.pathOp;
    changed = true;
    if (nodeId) renames.push({ nodeId, opId });
  }
  for (const child of node.children ?? []) if (migrateNode(child, renames)) changed = true;
  return changed;
}

/**
 * Re-key `pathop.<param>` → `pathop.<opId>.<param>` for the nodes that had one.
 *
 * Only the nodes in `renames` are touched. Rewriting every `pathop.*` track in
 * the document would also hit nodes whose operator was already migrated, and
 * `pathop.op_x.amount` re-prefixed a second time is an orphan.
 */
function renameTracks(
  animation: { tracks?: Record<string, Record<string, unknown>> } | undefined,
  renames: ReadonlyArray<{ nodeId: string; opId: string }>,
): void {
  const tracks = animation?.tracks;
  if (!tracks) return;

  for (const { nodeId, opId } of renames) {
    const nodeTracks = tracks[nodeId];
    if (!nodeTracks) continue;
    for (const path of Object.keys(nodeTracks)) {
      if (!path.startsWith(LEGACY_TRACK_PREFIX)) continue;
      const param = path.slice(LEGACY_TRACK_PREFIX.length);
      // Already id-scoped (contains a further dot) — leave it be.
      if (param.includes('.')) continue;
      nodeTracks[`${LEGACY_TRACK_PREFIX}${opId}.${param}`] = nodeTracks[path]!;
      delete nodeTracks[path];
    }
  }
}

export const v1_2_0_to_v1_3_0: DocumentMigration = {
  from: '1.2.0',
  to: '1.3.0',
  description: 'Path operators: a single fx.pathOp → an ordered fx.pathOps chain.',
  migrate(doc: EditorDocument): EditorDocument {
    const nodes = (doc.scene as { nodes?: NodeLike[] } | undefined)?.nodes;
    if (!Array.isArray(nodes)) return doc;

    const cloned = structuredClone(doc);
    const clonedNodes = (cloned.scene as { nodes?: NodeLike[] }).nodes ?? [];
    const renames: Array<{ nodeId: string; opId: string }> = [];

    let changed = false;
    for (const n of clonedNodes) if (migrateNode(n, renames)) changed = true;
    if (!changed) return doc;

    renameTracks(
      cloned.animation as { tracks?: Record<string, Record<string, unknown>> } | undefined,
      renames,
    );
    return cloned;
  },
};
