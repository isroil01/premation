/* eslint-disable no-restricted-syntax -- SAFE, verified.
 * Mutates a `structuredClone(doc)` — migrations must be pure, and the clone is
 * taken precisely so the caller's document is untouched. Never a graph node. */
/**
 * 1.7.0 → 1.8.0 — a light's Falloff "None" becomes After Effects' None.
 *
 * Before: a light with no falloff (the default, and what the Falloff menu
 *         wrote for None) lit by a RADIUS RAMP — full at the light, fading to
 *         nothing at `radius`. A default light more than one radius from a 3D
 *         layer lit it not at all.
 * After:  `none` is constant intensity at any distance (AE). The old ramp is
 *         an explicit mode, `legacy`.
 *
 * ── WHAT THIS MIGRATION CLAIMS ──────────────────────────────────────────────
 *
 * Every 1.7.0 document renders IDENTICALLY: each light that has NO falloff
 * prop is stamped `legacy`, the mode that names the rule it was lit under.
 * A light with an explicit falloff (`smooth`, `inverse-square`) is untouched.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ──────────────────────────────────────────────
 *
 * `captureDocument` still stamps every document '1.1.0' (F31), so a project
 * saved by THIS build walks through here on every load. Only an ABSENT prop is
 * converted, and this build never writes an absent one: `insertLight` and the
 * Falloff menu both store `none` explicitly. A migrated light carries
 * `legacy`, a new one `none`; neither is touched again.
 *
 * ── VERSION BUMP IS EXCLUSIVELY THIS CHANGE ─────────────────────────────────
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';

interface NodeLike {
  components?: Array<{ type?: string; props?: Record<string, unknown> }>;
  children?: NodeLike[];
}

/** The light's transform component — where every light prop lives. */
function lightTransform(node: NodeLike): Record<string, unknown> | null {
  for (const c of node.components ?? []) {
    if (c.type !== 'Transform' || !c.props) continue;
    if (c.props.__kind === 'light' || typeof c.props.lightType === 'string') return c.props;
  }
  return null;
}

function hasLegacy(nodes: readonly NodeLike[]): boolean {
  for (const node of nodes) {
    const p = lightTransform(node);
    if (p && p.falloff === undefined) return true;
    if (node.children && hasLegacy(node.children)) return true;
  }
  return false;
}

function migrateNodes(nodes: NodeLike[]): void {
  for (const node of nodes) {
    const p = lightTransform(node);
    if (p && p.falloff === undefined) p.falloff = 'legacy';
    if (node.children) migrateNodes(node.children);
  }
}

export const v1_7_0_to_v1_8_0: DocumentMigration = {
  from: '1.7.0',
  to: '1.8.0',
  description:
    "Lights: Falloff None is now AE's constant intensity; lights without a falloff " +
    'are stamped `legacy` (the old radius ramp). Renders identically.',
  migrate(doc: EditorDocument): EditorDocument {
    const nodes = (doc.scene as { nodes?: NodeLike[] } | undefined)?.nodes;
    if (!Array.isArray(nodes) || !hasLegacy(nodes)) return doc;
    const cloned = structuredClone(doc);
    migrateNodes((cloned.scene as { nodes: NodeLike[] }).nodes);
    return cloned;
  },
};
