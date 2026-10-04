/**
 * Expression controls (MG capability 3) — named slider values a user attaches
 * to any layer and references from ANY expression via `ctrl('name')`. The AE
 * equivalent is the Slider Control effect: one slider drives many properties,
 * which is how users invent their own rigs.
 *
 * Storage follows the threeD.ts pattern: a control is a plain numeric prop
 * `ctrl_<name>` on the layer's Transform component, so the NodeInspector
 * automatically renders a keyframeable, undoable row for it — controls animate
 * through the exact same command path as x/y/rotation.
 *
 * Lookup is global-by-name (first layer that carries the prop wins), so an
 * expression anywhere can read a slider that lives on a Null controller.
 */

import {
  CONTROL_PREFIX,
  CONTROL_KIND_PREFIX,
  CONTROL_SPECS,
  
  
  type ControlKind,
} from '@core/engine/controlSpecs';

export { CONTROL_PREFIX, CONTROL_KIND_PREFIX, type ControlKind };

/**
 * Control KINDS (the table is `@core/engine/controlSpecs`, shared with both
 * engines: a control is the API group `effects/ctrl_<name>`).
 *
 * Every kind stores a NUMBER, because that is what `ctrl(name)` resolves to and
 * what the keyframe engine animates — the kind only decides how the value is
 * presented and what range it is clamped to. A colour control is three numeric
 * controls (`name.r/.g/.b`), matching how colours are keyframed everywhere else
 * in the editor rather than inventing a second colour representation.
 *
 * The kind is stored alongside the value as `ctrlkind_<name>`, so an existing
 * project's sliders keep working: no kind recorded means Slider.
 *
 * Adding / removing / renaming a control is the engine's `addPropertyGroup`
 * (parent `effects`, the kind's match name) / `removePropertyGroups` /
 * `renamePropertyGroup` on `effects/ctrl_<name>`.
 *
 * CONTROL_COMPONENTS: the sub-properties a kind expands into, appended to the
 * control's name.
 */
export const CONTROL_COMPONENTS: Record<ControlKind, readonly string[]> = Object.fromEntries(
  CONTROL_SPECS.map((s) => [s.kind, s.components]),
) as Record<ControlKind, readonly string[]>;
