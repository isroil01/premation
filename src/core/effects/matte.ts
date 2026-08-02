/**
 * Track mattes.
 *
 * A matte makes another layer define this layer's alpha:
 *   • alpha — keep this layer where the source is opaque
 *   • luma  — this layer's alpha follows the source's luminance
 * and `inverted` flips either one. The matte SOURCE is any layer in the
 * composition — see `resolveMatteSources` in buildSnapshot.ts, which falls back
 * to AE's positional convention (the layer directly above) only when no explicit
 * `sourceId` is set. One source can drive many matted layers, and the source is
 * consumed rather than drawn on its own.
 *
 * ── Why two fields and not four enum values ──────────────────────────
 * This was `'alpha' | 'luma' | 'alpha-inv' | 'luma-inv'`: four values for two
 * independent switches. That is AE's own UI shape (Alpha/Luma × Inverted)
 * expressed wrongly — a third matte KIND would have meant six values, and every
 * consumer would have had to learn the new spellings. It also meant the two
 * matte dropdowns in the app each hardcoded their own copy of the four labels,
 * which is exactly the duplication that makes a fifth value expensive.
 *
 * The renderer was ALREADY on this shape: `matteOf()` in snapshotToFrameScene
 * collapsed the four values into `{mode, inverted}` before anything GPU-side saw
 * them. So this moves storage and UI onto the model the render path always had,
 * and deletes the translation in the middle.
 *
 * ── Reading legacy documents ─────────────────────────────────────────
 * `readMatte` accepts BOTH shapes. Documents are normalised on load by the
 * 1.1.0 → 1.2.0 migration, so this tolerance is not what makes old projects
 * correct — it is the rollback story. A build from before the migration must
 * still open a document the migration has already rewritten. Keep it for at
 * least one release; deleting it makes the migration one-way in practice.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

/** What the source contributes: its alpha channel, or its luminance. */
export type MatteMode = 'alpha' | 'luma';

export interface TrackMatte {
  mode: MatteMode;
  /** Flip the matte — keep this layer where the source is ABSENT. */
  inverted: boolean;
  /** Explicit source layer. Absent = AE's positional convention. */
  sourceId?: string;
}

/** The pre-1.2.0 spelling, still accepted on read. */
export type LegacyMatteType = 'alpha' | 'luma' | 'alpha-inv' | 'luma-inv';

export const MATTE_MODES: ReadonlyArray<{ mode: MatteMode; label: string }> = [
  { mode: 'alpha', label: 'Alpha' },
  { mode: 'luma', label: 'Luma' },
];

const LEGACY: Record<LegacyMatteType, { mode: MatteMode; inverted: boolean }> = {
  alpha: { mode: 'alpha', inverted: false },
  'alpha-inv': { mode: 'alpha', inverted: true },
  luma: { mode: 'luma', inverted: false },
  'luma-inv': { mode: 'luma', inverted: true },
};

export function isMatteMode(v: unknown): v is MatteMode {
  return v === 'alpha' || v === 'luma';
}

export function isLegacyMatteType(v: unknown): v is LegacyMatteType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEGACY, v);
}

/**
 * Normalise any stored matte — current object, legacy object, or legacy string —
 * into a `TrackMatte`. Returns undefined for "no matte", including the string
 * `'none'` that some call sites still pass.
 */
export function readMatte(v: unknown): TrackMatte | undefined {
  if (!v || v === 'none') return undefined;

  if (isLegacyMatteType(v)) return { ...LEGACY[v] };

  if (typeof v === 'object') {
    const o = v as { mode?: unknown; inverted?: unknown; sourceId?: unknown };
    const sourceId = typeof o.sourceId === 'string' ? o.sourceId : undefined;

    // ORDER MATTERS. 'alpha' and 'luma' are valid in BOTH shapes — they are
    // legacy strings AND current modes — so the current shape must be tested
    // first. Testing legacy first matched `{mode:'luma', inverted:true}` as the
    // legacy `luma` and silently dropped the inversion, turning an inverted
    // matte into a normal one. Only the `-inv` spellings are legacy-exclusive.
    if (isMatteMode(o.mode)) {
      return { mode: o.mode, inverted: o.inverted === true, ...(sourceId ? { sourceId } : {}) };
    }
    if (isLegacyMatteType(o.mode)) {
      return { ...LEGACY[o.mode], ...(sourceId ? { sourceId } : {}) };
    }
  }
  return undefined;
}

/** Read a node's matte from its `fx` component (undefined = none). */
export function readNodeMatte(node: SceneNode): TrackMatte | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  return readMatte(fx?.props.matte);
}

export function getNodeMatte(nodeId: string): TrackMatte | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeMatte(node) : undefined;
}

export function setNodeMatte(nodeId: string, matte: TrackMatte | undefined): void {
  defaultSceneGraph.setMatte(nodeId, matte);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** AE's wording for a matte, for triggers and row labels. */
export function matteLabel(m: TrackMatte | undefined): string {
  if (!m) return 'No matte';
  const kind = m.mode === 'luma' ? 'Luma' : 'Alpha';
  return m.inverted ? `${kind} Inverted` : kind;
}
