/* eslint-disable no-restricted-syntax -- SAFE, verified.
 * Mutates a `structuredClone(doc)` — migrations must be pure, and the clone is
 * taken precisely so the caller's document is untouched. Never a graph node. */
/**
 * 1.3.0 → 1.4.0 — Trim Paths becomes an entry in the path-operator chain.
 *
 * Before: `fx.trim` — a fixed stage that always ran AFTER every path operator,
 *         with keyframes under `trim.<param>`.
 * After:  an ordinary `fx.pathOps` entry of `type: 'trim'`, with keyframes
 *         under `pathop.<opId>.<param>` like every other operator.
 *
 * ── WHY IT IS WORTH MOVING ──────────────────────────────────────────────────
 *
 * Because the position matters. Trimming cuts by ARC LENGTH, so 37% of a
 * zig-zagged outline lands somewhere quite different from 37% of the smooth one
 * the zig-zag was built from. Measured against all six deformers before this
 * was written: every one of them changes the rendered geometry when the trim
 * moves past it. (Zig-Zag at exactly 50% of a rect is the one case that
 * commutes — that trims precisely at a vertex, and it is degenerate, not a
 * property. Testing only that would have concluded the reorder was inert.)
 *
 * ── APPENDED, NOT PREPENDED ─────────────────────────────────────────────────
 *
 * The old pipeline was fixed at `pathOps → trim → repeater`, so trim goes at
 * the END of the existing chain. Any other position would silently re-render
 * every document that has both a trim and an operator. A migration is allowed
 * to change shape; it is not allowed to change pictures.
 *
 * ── THE HALF THAT IS EASY TO FORGET ─────────────────────────────────────────
 *
 * The keyframes. `trim.end` is how a draw-on is animated — it is the single
 * most-animated parameter this feature has — and it must become
 * `pathop.<opId>.end` using the SAME id assigned to the new entry. Miss it and
 * every animated trim in every project loses its keyframes silently: the shape
 * still renders, just frozen at its static value. Same failure mode as the
 * 1.1.0 → 1.2.0 matte migration's `sourceId` and the 1.2.0 → 1.3.0 operator
 * re-keying, and nobody notices until they scrub.
 *
 * ── NO DUAL-SHAPE READS ─────────────────────────────────────────────────────
 *
 * `fx.trim` is DELETED, and nothing reads it any more — same precedent as
 * `fx.pathOp` in 1.3.0. A reader that quietly accepts both shapes means
 * documents can stay un-migrated indefinitely, the migration never gets
 * exercised, and the two shapes drift.
 *
 * ── VERSION BUMP IS EXCLUSIVELY THIS CHANGE ─────────────────────────────────
 *
 * Nothing else rides on 1.4.0. A failed migration has to be bisectable to one
 * transformation.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';

interface NodeLike {
  id?: string;
  components?: Array<{ type?: string; props?: Record<string, unknown> }>;
  children?: NodeLike[];
}

/** The per-layer namespace trim keyframes used before they were id-scoped. */
const LEGACY_TRACK_PREFIX = 'trim.';
const TRIM_PARAMS = ['start', 'end', 'offset'] as const;

/**
 * Deterministic id for the migrated trim entry.
 *
 * NOT random, for the same reason `migratedOpId` is not: a migration must be a
 * pure function of its input, or two machines migrating the same project
 * produce documents that differ and a version-history diff shows a change
 * nobody made. Distinct from the 1.3.0 operator prefix so a layer that carried
 * BOTH a legacy operator and a legacy trim cannot collide on one id — which
 * would merge two operators' keyframes into one.
 */
function migratedTrimId(nodeId: string): string {
  return `trimop_${nodeId}`;
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

/** Convert one node, collecting the track rename it implies. */
function migrateNode(node: NodeLike, renames: Array<{ nodeId: string; opId: string }>): boolean {
  let changed = false;
  for (const c of node.components ?? []) {
    if (c.type !== 'fx' || !c.props) continue;

    const legacy = c.props.trim;
    if (!legacy || typeof legacy !== 'object') continue;
    const t = legacy as Record<string, unknown>;

    const nodeId = typeof node.id === 'string' ? node.id : '';
    const opId = migratedTrimId(nodeId);

    // APPENDED to whatever chain already exists, reproducing the old fixed
    // `pathOps → trim` evaluation order exactly.
    const existing = Array.isArray(c.props.pathOps) ? (c.props.pathOps as unknown[]) : [];
    c.props.pathOps = [
      ...existing,
      {
        id: opId,
        type: 'trim',
        // The two shared numeric params still have to be present and inert —
        // `coercePathOp` defaults them anyway, but writing them keeps a
        // migrated entry byte-identical to a freshly created one.
        amount: 0,
        detail: 0,
        start: num(t.start, 0),
        end: num(t.end, 100),
        offset: num(t.offset, 0),
      },
    ];
    delete c.props.trim;
    changed = true;
    if (nodeId) renames.push({ nodeId, opId });
  }
  for (const child of node.children ?? []) if (migrateNode(child, renames)) changed = true;
  return changed;
}

/**
 * Re-key `trim.<param>` → `pathop.<opId>.<param>` for the nodes that had one.
 *
 * Only the nodes in `renames` are touched — a node with no legacy trim has no
 * trim entry to point its tracks at, and re-prefixing a track that already
 * survived a previous run would orphan it.
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
    for (const param of TRIM_PARAMS) {
      const legacyPath = `${LEGACY_TRACK_PREFIX}${param}`;
      const track = nodeTracks[legacyPath];
      if (track === undefined) continue;
      nodeTracks[`pathop.${opId}.${param}`] = track;
      delete nodeTracks[legacyPath];
    }
  }
}

export const v1_3_0_to_v1_4_0: DocumentMigration = {
  from: '1.3.0',
  to: '1.4.0',
  description: 'Trim Paths: a fixed fx.trim stage → an entry in the fx.pathOps chain.',
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
