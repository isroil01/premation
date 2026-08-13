/* eslint-disable no-restricted-syntax -- SAFE, verified.
 * Mutates a `structuredClone(doc)` — migrations must be pure, and the clone is
 * taken precisely so the caller's document is untouched. Never a graph node. */
/**
 * 1.4.0 → 1.5.0 — the Repeater becomes an entry in the path-operator chain.
 *
 * Before: `fx.repeater` — a fixed stage after every path operator that emitted
 *         N whole RenderLayers, with keyframes under `rep.<param>`.
 * After:  an ordinary `fx.pathOps` entry of `type: 'repeater'`, with keyframes
 *         under `pathop.<opId>.<param>` like every other operator.
 *
 * ── WHAT THIS MIGRATION HONESTLY CLAIMS ─────────────────────────────────────
 *
 * NOT "existing documents render identically". They render identically EXCEPT
 * on a layer with a non-identity rotation or scale, where they deliberately
 * change. Writing the stronger claim would have been false, and a migration
 * that pretends to be lossless is worse than one that says where it is not.
 *
 * The reason is the space the copies live in. `buildSnapshot` used to emit
 * `x: px + c.dx` — the ladder delta added to the layer's COMP position, after
 * its own rotation and scale were already resolved — so a repeated layer's
 * arrangement stayed axis-aligned however the layer was turned. As a chain
 * entry the copies are baked into LAYER-LOCAL geometry, so the layer transform
 * turns and scales the whole repeated group.
 *
 * That is AE's model (the Repeater lives inside `contents`, below the layer's
 * own Transform) and the comp-space one was an artifact of where the copies
 * happened to be emitted, not a feature anyone chose. A repeater with
 * `offsetX: 10` on a layer rotated 90 degrees put copy 1 at (10,0) before and
 * puts it at (0,10) now.
 *
 * No lossless migration exists. Dividing the layer transform out of the offsets
 * works only while that transform is STATIC; on a layer with keyframed rotation
 * the compensation would have to vary per frame, which makes the repeater
 * operator depend on the layer transform and breaks the chain's contract that
 * operators are pure point-to-point functions. See F19, and the render-test
 * scenes `shape-repeater-rotated-layer` / `shape-repeater-scaled-layer`, which
 * were blessed against the OLD behaviour one commit before the fold so the
 * change is visible in a diff rather than silent.
 *
 * ── APPENDED, NOT PREPENDED ─────────────────────────────────────────────────
 *
 * The old pipeline was fixed at `pathOps → trim → repeater`, so the repeater
 * goes at the END of the existing chain — after the trim entry that 1.4.0
 * appended. Any other position would re-render every document that has both.
 *
 * ── THE HALF THAT IS EASY TO FORGET ─────────────────────────────────────────
 *
 * The keyframes. All eight numeric repeater params were animatable under
 * `rep.<param>` and all eight must become `pathop.<opId>.<param>` using the
 * SAME id assigned to the new entry. Miss one and an animated repeater loses
 * that parameter's motion silently — it still renders, just frozen at its
 * static value, and nobody notices until they scrub. Same failure mode as the
 * 1.1.0 matte `sourceId`, the 1.3.0 operator re-keying and the 1.4.0 trim.
 *
 * `composite` is absent from the list because it was never keyframeable: it is
 * a discrete stacking choice, and interpolating it would mean a frame where the
 * copies are halfway between in front of and behind the original.
 *
 * ── NO DUAL-SHAPE READS ─────────────────────────────────────────────────────
 *
 * `fx.repeater` is DELETED, and nothing reads it any more — same precedent as
 * `fx.pathOp` in 1.3.0 and `fx.trim` in 1.4.0. A reader that quietly accepts
 * both shapes means documents can stay un-migrated indefinitely, the migration
 * never gets exercised, and the two shapes drift.
 *
 * ── VERSION BUMP IS EXCLUSIVELY THIS CHANGE ─────────────────────────────────
 *
 * Nothing else rides on 1.5.0. A failed migration has to be bisectable to one
 * transformation.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';

interface NodeLike {
  id?: string;
  components?: Array<{ type?: string; props?: Record<string, unknown> }>;
  children?: NodeLike[];
}

/** The per-layer namespace repeater keyframes used before they were id-scoped. */
const LEGACY_TRACK_PREFIX = 'rep.';

/**
 * Every keyframeable repeater parameter, and the reason this list is spelled
 * out rather than derived from `REPEATER_PARAMS`: a migration must keep
 * migrating old documents correctly even if the live parameter set later gains
 * or loses a member. Importing the live list would make this step's behaviour
 * change retroactively whenever the feature does.
 */
const REPEATER_PARAMS = [
  'copies', 'offsetX', 'offsetY', 'offsetRotation', 'offsetScale',
  'offsetOpacity', 'offset', 'anchorX', 'anchorY',
] as const;

/**
 * Deterministic id for the migrated repeater entry.
 *
 * NOT random, for the same reason `migratedTrimId` is not: a migration must be
 * a pure function of its input, or two machines migrating the same project
 * produce documents that differ and a version-history diff shows a change
 * nobody made. Distinct from the 1.3.0 operator and 1.4.0 trim prefixes so a
 * layer carrying all three cannot collide on one id — which would merge two
 * operators' keyframes into one.
 */
function migratedRepeaterId(nodeId: string): string {
  return `repop_${nodeId}`;
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

/** Convert one node, collecting the track rename it implies. */
function migrateNode(node: NodeLike, renames: Array<{ nodeId: string; opId: string }>): boolean {
  let changed = false;
  for (const c of node.components ?? []) {
    if (c.type !== 'fx' || !c.props) continue;

    const legacy = c.props.repeater;
    if (!legacy || typeof legacy !== 'object') continue;
    const r = legacy as Record<string, unknown>;

    const nodeId = typeof node.id === 'string' ? node.id : '';
    const opId = migratedRepeaterId(nodeId);

    // APPENDED to whatever chain already exists, reproducing the old fixed
    // `pathOps → trim → repeater` evaluation order exactly.
    const existing = Array.isArray(c.props.pathOps) ? (c.props.pathOps as unknown[]) : [];
    c.props.pathOps = [
      ...existing,
      {
        id: opId,
        type: 'repeater',
        // Inert but present, so a migrated entry is byte-identical to a freshly
        // created one and a round-trip shows no spurious diff.
        amount: 0,
        detail: 0,
        // Defaults match `readRepeaterConfig`'s, which is what the pre-fold
        // renderer read these through — including the four that default to a
        // no-op because they postdate the original feature.
        copies: num(r.copies, 6),
        offsetX: num(r.offsetX, 80),
        offsetY: num(r.offsetY, 0),
        offsetRotation: num(r.offsetRotation, 0),
        offsetScale: num(r.offsetScale, 1),
        offsetOpacity: num(r.offsetOpacity, 1),
        offset: num(r.offset, 0),
        anchorX: num(r.anchorX, 0),
        anchorY: num(r.anchorY, 0),
        composite: r.composite === 'below' ? 'below' : 'above',
      },
    ];
    delete c.props.repeater;
    changed = true;
    if (nodeId) renames.push({ nodeId, opId });
  }
  for (const child of node.children ?? []) if (migrateNode(child, renames)) changed = true;
  return changed;
}

/**
 * Re-key `rep.<param>` → `pathop.<opId>.<param>` for the nodes that had one.
 *
 * Only the nodes in `renames` are touched — a node with no legacy repeater has
 * no repeater entry to point its tracks at, and re-prefixing a track that
 * already survived a previous run would orphan it.
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
    for (const param of REPEATER_PARAMS) {
      const legacyPath = `${LEGACY_TRACK_PREFIX}${param}`;
      const track = nodeTracks[legacyPath];
      if (track === undefined) continue;
      nodeTracks[`pathop.${opId}.${param}`] = track;
      delete nodeTracks[legacyPath];
    }
  }
}

export const v1_4_0_to_v1_5_0: DocumentMigration = {
  from: '1.4.0',
  to: '1.5.0',
  description:
    'Repeater: a fixed fx.repeater stage → an entry in the fx.pathOps chain. ' +
    'Renders identically except on rotated or scaled layers, which move deliberately.',
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
