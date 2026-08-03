/**
 * Which panels a build offers, as the single place that decides.
 *
 * ── Why this is not in panelDefs.ts ─────────────────────────────────────────
 *
 * Two layers need this answer and they sit on opposite sides of the import
 * direction. `panelDefs.ts` is the canonical panel registry and lives in
 * `src/layout`; `workspaceManager.ts` has to strip unavailable panels out of the
 * layout presets and lives in `src/core`, which does not import `@layout` in any
 * production module. Putting the rule in either one would have forced a second
 * copy into the other — a list of gated panel ids in `layout` and another in
 * `core`, with nothing making them agree. The day someone gates a second panel
 * and updates one list, the presets and the registry disagree, and the symptom
 * is a workspace that applies a panel the dock refuses to draw.
 *
 * So the rule lives here, in `core/config` beside `edition.ts`, and both sides
 * import it. `panelDefs` spreads it onto its `available` field; `workspaceManager`
 * reads it directly.
 *
 * ── Predicates, not booleans ────────────────────────────────────────────────
 *
 * Every value is a function, and that is load-bearing. This module is evaluated
 * when first imported, which happens through the App import graph — BEFORE
 * `main.tsx` calls `setEdition()`. A boolean computed at module scope would
 * capture the default edition ('server') and no gate would ever fire.
 */

import { aiEnabled } from './edition';

/**
 * Panel id → whether this build has it. Ids absent from this map are available
 * everywhere, which is the overwhelming majority; only list the exceptions.
 */
export const PANEL_AVAILABILITY: Readonly<Record<string, () => boolean>> = {
  /**
   * The assistant. Server edition only — the local (OSS) edition does not ship
   * it. The implementation is untouched and still correct; see `aiEnabled()`.
   */
  ai: aiEnabled,
};

/** Whether a panel id exists in this build. Unknown ids are available. */
export function isPanelAvailable(id: string): boolean {
  const predicate = PANEL_AVAILABILITY[id];
  return predicate === undefined || predicate();
}
