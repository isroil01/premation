/**
 * 1.8.0 → 1.9.0 — every keyframe gets a stable id.
 *
 * Before: keyframes were addressed by POSITION (`node::prop::t`,
 *         `packages/animation/src/keyframeId.ts`), so moving a key renamed it
 *         and undo could not name "the same key" across a retime
 *         (ENGINE_API.md §2.5 #4).
 * After:  each keyframe carries `id: 'k<n>'`, the shape the engine API mints
 *         (`stableKeyframeId`). Scalar tracks, data tracks (Source Text, mask
 *         outlines, puppet pins, gradients) and mask-shape keyframes
 *         (`fx.maskAnim` entries) are all covered.
 *
 * ── DETERMINISTIC ───────────────────────────────────────────────────────────
 *
 * The same file always gets the same ids: keys are visited in document order
 * (animation.tracks by node then prop, then animation.data, then each node's
 * maskAnim in scene order) and numbered from one past the highest `k<n>`
 * already present, so a partially-id'd document never collides with itself.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 *
 * `captureDocument` still stamps '1.1.0' (F31), so every load walks through
 * here. Only a key WITHOUT an id is touched; a document saved by this build
 * whose keys all carry ids is returned unchanged (same object).
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';
import { stableKeyframeId, stableKeyframeIdSeq } from '@motion/animation';

interface KeyLike { id?: string }
type Section = Record<string, Record<string, { keyframes?: KeyLike[] } | undefined> | undefined>;
interface NodeLike { components?: Array<{ type?: string; props?: Record<string, unknown> }> }

/** Every keyframe-shaped record in the document, in the deterministic visit order. */
function visitKeys(doc: EditorDocument, fn: (k: KeyLike) => void): void {
  const anim = doc.animation as unknown as { tracks?: Section; data?: Section } | undefined;
  for (const section of [anim?.tracks, anim?.data]) {
    if (!section) continue;
    for (const nodeId of Object.keys(section)) {
      const byProp = section[nodeId];
      if (!byProp) continue;
      for (const prop of Object.keys(byProp)) {
        const kfs = byProp[prop]?.keyframes;
        if (Array.isArray(kfs)) for (const k of kfs) if (k && typeof k === 'object') fn(k);
      }
    }
  }
  const nodes = (doc.scene as { nodes?: NodeLike[] } | undefined)?.nodes;
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    for (const c of node.components ?? []) {
      if (c.type !== 'fx') continue;
      const ma = c.props?.maskAnim;
      if (Array.isArray(ma)) for (const k of ma) if (k && typeof k === 'object') fn(k as KeyLike);
    }
  }
}

export const v1_8_0_to_v1_9_0: DocumentMigration = {
  from: '1.8.0',
  to: '1.9.0',
  description:
    'Keyframes: every keyframe (scalar, data and mask-shape) gets a stable engine id `k<n>`, ' +
    'assigned deterministically in document order. Renders identically.',
  migrate(doc: EditorDocument): EditorDocument {
    let missing = false;
    let max = 0;
    visitKeys(doc, (k) => {
      if (typeof k.id !== 'string' || k.id === '') missing = true;
      else max = Math.max(max, stableKeyframeIdSeq(k.id));
    });
    if (!missing) return doc;
    const cloned = structuredClone(doc);
    let next = max;
    visitKeys(cloned, (k) => {
      if (typeof k.id !== 'string' || k.id === '') k.id = stableKeyframeId((next += 1));
    });
    return cloned;
  },
};
