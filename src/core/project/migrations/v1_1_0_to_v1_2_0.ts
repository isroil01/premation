/* eslint-disable no-restricted-syntax -- F11: SAFE, verified.
 * Mutates a `structuredClone(doc)` — migrations must be pure, and the clone is
 * taken precisely so the caller's document is untouched. Never a graph node. */
/**
 * 1.1.0 → 1.2.0 — track matte becomes `{ mode, inverted }`.
 *
 * Before: one of four strings, or `{ mode: <one of four>, sourceId }`.
 * After:  `{ mode: 'alpha' | 'luma', inverted: boolean, sourceId? }`.
 *
 * The first migration that changes a field's SHAPE rather than adding one, which
 * is what the mechanism in index.ts was built for. Every field added before this
 * was optional, so old documents opened by being structurally compatible; a
 * reshaped field has no such luck.
 *
 * `sourceId` is preserved. Losing it would silently re-point a matte at whatever
 * layer happens to sit above it — the layer stays matted, so nothing looks
 * broken, it is just cut to the wrong shape. That is the worst failure mode
 * available here and the reason this migration is worth its own test rather
 * than a round-trip assertion.
 *
 * Nodes carry the matte on their `fx` component's props; the walk has to reach
 * every node in the tree, including nested precomp children.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import { readMatte } from '@core/effects/matte';
import type { DocumentMigration } from './index';

interface NodeLike {
  components?: Array<{ type?: string; props?: Record<string, unknown> }>;
  children?: NodeLike[];
}

/** Rewrite one node's matte in place if it holds a legacy shape. Returns true
 *  when something changed, so the caller can avoid cloning untouched documents. */
function migrateNode(node: NodeLike): boolean {
  let changed = false;
  for (const c of node.components ?? []) {
    if (c.type !== 'fx' || !c.props) continue;
    const raw = c.props.matte;
    if (raw === undefined || raw === null) continue;

    const normalised = readMatte(raw);
    if (!normalised) {
      // 'none' or unrecognised — drop it rather than carry a value nothing reads.
      if (raw !== undefined) { delete c.props.matte; changed = true; }
      continue;
    }
    // Already current? `inverted` present as a boolean and `mode` narrow.
    const cur = raw as { mode?: unknown; inverted?: unknown };
    const isCurrent =
      typeof raw === 'object' &&
      (cur.mode === 'alpha' || cur.mode === 'luma') &&
      typeof cur.inverted === 'boolean';
    if (isCurrent) continue;

    c.props.matte = normalised;
    changed = true;
  }
  for (const child of node.children ?? []) if (migrateNode(child)) changed = true;
  return changed;
}

export const v1_1_0_to_v1_2_0: DocumentMigration = {
  from: '1.1.0',
  to: '1.2.0',
  description: 'Track matte: four enum values → { mode, inverted }.',
  migrate(doc: EditorDocument): EditorDocument {
    const nodes = (doc.scene as { nodes?: NodeLike[] } | undefined)?.nodes;
    if (!Array.isArray(nodes)) return doc;

    // Clone before mutating: migrations must be pure, and the caller may still
    // hold the original (the walker compares versions on it).
    const cloned = structuredClone(doc);
    const clonedNodes = (cloned.scene as { nodes?: NodeLike[] }).nodes ?? [];
    let changed = false;
    for (const n of clonedNodes) if (migrateNode(n)) changed = true;
    return changed ? cloned : doc;
  },
};
