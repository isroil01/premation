/**
 * EXPRESSION CONTROLS (B3) — the seven control kinds as engine-API property
 * groups: `effects/ctrl_<name>` (After Effects' Expression Controls are
 * effects) with ONE value property `effects/ctrl_<name>/<param>`.
 *
 * This module is DATA shared by both engines: the TypeScript catalog
 * (`src/core/engine/controlProps.ts`) and the legacy helpers
 * (`src/core/animation/expressionControls.ts`) read it directly, the C++
 * catalog (`native/engine/src/core/controls.cpp`) reads the copy
 * `crossEngineCatalog.test.ts` generates into catalog_data.inc
 * (`fields.control`). Pure — no scene graph, no stores. Row order is the
 * `listGroupTypes` order.
 *
 * Storage is the document's as it has always been: one plain number per
 * component on the layer's Transform component, `ctrl_<name><suffix>`, plus
 * the kind marker `ctrlkind_<name>` (absent = slider — pre-kind projects). The
 * value's keyframe tracks are those numbers' tracks, so `ctrl('<name>')` in an
 * expression reads exactly what the API writes.
 */

/** Control kinds (expressionControls.ts). */
export type ControlKind = 'slider' | 'angle' | 'point' | 'color' | 'checkbox' | 'dropdown' | 'layer';

export interface ControlSpec {
  kind: ControlKind;
  /** The group's match name (AE's effect match name). */
  matchName: string;
  /** listGroupTypes display name (AE's effect name). */
  label: string;
  /** The base of auto names ("Slider 1"). */
  displayName: string;
  /** The value property's path segment under the group. */
  param: string;
  /** The value property's name (AE's). */
  propName: string;
  propMatchName: string;
  /**
   * API value type. Every component is a stored NUMBER (what `ctrl()` resolves
   * to and what keys animate): a point is vec2, a colour is `color` whose
   * r/g/b are the stored numbers AS STORED (the control's 0–255 range, what
   * `ctrl('Name.r')` returns; alpha is not stored and reads 1), the rest scalar
   * (a checkbox 0/1, a dropdown its selected index, a layer control the index
   * of the referenced layer).
   */
  valueType: 'scalar' | 'vec2' | 'color';
  /** Suffixes appended to `ctrl_<name>`, one per component, in value order. */
  components: readonly string[];
  /** A new control's value per component. */
  defaults: readonly number[];
  unit: string;
}

export const CONTROL_PREFIX = 'ctrl_';
export const CONTROL_KIND_PREFIX = 'ctrlkind_';

export const CONTROL_SPECS: readonly ControlSpec[] = [
  { kind: 'slider', matchName: 'ADBE Slider Control', label: 'Slider Control', displayName: 'Slider', param: 'slider', propName: 'Slider', propMatchName: 'ADBE Slider Control-0001', valueType: 'scalar', components: [''], defaults: [50], unit: '' },
  { kind: 'angle', matchName: 'ADBE Angle Control', label: 'Angle Control', displayName: 'Angle', param: 'angle', propName: 'Angle', propMatchName: 'ADBE Angle Control-0001', valueType: 'scalar', components: [''], defaults: [0], unit: '°' },
  { kind: 'point', matchName: 'ADBE Point Control', label: 'Point Control', displayName: 'Point', param: 'point', propName: 'Point', propMatchName: 'ADBE Point Control-0001', valueType: 'vec2', components: ['.x', '.y'], defaults: [0, 0], unit: 'px' },
  { kind: 'color', matchName: 'ADBE Color Control', label: 'Color Control', displayName: 'Color', param: 'color', propName: 'Color', propMatchName: 'ADBE Color Control-0001', valueType: 'color', components: ['.r', '.g', '.b'], defaults: [255, 255, 255], unit: '' },
  { kind: 'checkbox', matchName: 'ADBE Checkbox Control', label: 'Checkbox Control', displayName: 'Checkbox', param: 'checkbox', propName: 'Checkbox', propMatchName: 'ADBE Checkbox Control-0001', valueType: 'scalar', components: [''], defaults: [0], unit: '' },
  { kind: 'dropdown', matchName: 'ADBE Dropdown Control', label: 'Dropdown Menu Control', displayName: 'Dropdown', param: 'menu', propName: 'Menu', propMatchName: 'ADBE Dropdown Control-0001', valueType: 'scalar', components: [''], defaults: [0], unit: '' },
  { kind: 'layer', matchName: 'ADBE Layer Control', label: 'Layer Control', displayName: 'Layer', param: 'layer', propName: 'Layer', propMatchName: 'ADBE Layer Control-0001', valueType: 'scalar', components: [''], defaults: [0], unit: '' },
];

export function controlSpecOf(kind: ControlKind): ControlSpec {
  return CONTROL_SPECS.find((s) => s.kind === kind)!;
}

export function controlSpecForMatchName(matchName: string): ControlSpec | undefined {
  return CONTROL_SPECS.find((s) => s.matchName === matchName);
}

/** A stored kind marker's spec ('slider' when absent or unknown — pre-kind projects). */
export function controlSpecForMarker(marker: unknown): ControlSpec {
  return (typeof marker === 'string' && CONTROL_SPECS.find((s) => s.kind === marker)) || CONTROL_SPECS[0]!;
}

/**
 * The next free auto-name of a kind ("Slider 1", "Angle 2", …) given every
 * control VALUE name stored in the document (`ctrl_<x>` numbers → `<x>`): a
 * point control owns `<name>.x` / `<name>.y`, so the BASE name must be free
 * even though nothing is stored under it directly.
 */
export function nextFreeControlName(spec: ControlSpec, taken: readonly string[]): string {
  for (let i = 1; ; i++) {
    const name = `${spec.displayName} ${i}`;
    if (!taken.some((t) => t === name || t.startsWith(`${name}.`))) return name;
  }
}
