/**
 * SHAPE FIELDS (B3z-a worker E1) — the static, non-keyframed values of a shape
 * layer's path operators and its parametric Polystar, as engine-API properties
 * (ENGINE_API.md §3.4, §15.9). The G1 field mechanism (fields.ts) extended to
 * the Contents group:
 *
 *   contents/<opId>/type                 the operator kind (Zig-Zag ↔ Round
 *                                        Corners ↔ Pucker & Bloat …) — the
 *                                        deformers only: Trim Paths and the
 *                                        Repeater are chosen when added
 *   contents/<opId>/composite            Repeater ▸ Composite (Above / Below)
 *   contents/<opId>/lineJoin             Offset Paths ▸ Line Join
 *   contents/<opId>/trimMultipleShapes   Trim Paths ▸ Trim Multiple Shapes
 *   contents/<opId>/seed                 Wiggle Paths / Wiggle Transform ▸ Random Seed
 *   contents/polystar/type               Polystar ▸ Type (Star / Polygon)
 *
 * Stored on the operator entry in `fx.pathOps` / on `fx.polystar`, written the
 * way the editor always wrote them (the chain / the polystar re-validated
 * whole, pathOps.ts `updatePathOp`, polystar.ts `updateNodePolystar`). A type
 * switch keeps every stored parameter and every keyframe track of the operator
 * (`pathop.<id>.<param>`): the parameters the new kind reads come back
 * (Zig-Zag's Amount is Round Corners' Radius), the others stay dormant — what
 * the legacy picker did; After Effects has no in-place switch to compare with.
 *
 * DATA shared by both engines: the TypeScript catalog reads it directly, the
 * C++ catalog reads the copy crossEngineCatalog.test.ts generates into
 * catalog_data.inc (`fields.pathOp`, `fields.polystar`). Row ORDER is the
 * order both engines add the bindings in. Pure — no scene graph, no stores.
 */

import type { TextFieldSpec } from '@core/text/textFields';

/** A field of one path operator, stored under `key` on its `fx.pathOps` entry. */
export interface PathOpFieldSpec extends Omit<TextFieldSpec, 'kinds'> {
  /** The operator types that HAVE the field. */
  ops: readonly string[];
}

/** The deformers whose kind can be switched in place (PathOpControls' Type picker). */
export const PATHOP_SWITCHABLE_TYPES = ['zigzag', 'roundCorners', 'pucker', 'twist', 'offset', 'roughen', 'wiggleTransform'] as const;

export const PATHOP_FIELDS: readonly PathOpFieldSpec[] = [
  { key: 'type', label: 'Type', type: 'choice', default: 'zigzag', choices: [...PATHOP_SWITCHABLE_TYPES], ops: [...PATHOP_SWITCHABLE_TYPES, 'none'] },
  { key: 'composite', label: 'Composite', type: 'choice', default: 'above', choices: ['above', 'below'], ops: ['repeater'] },
  { key: 'lineJoin', label: 'Line Join', type: 'choice', default: 'miter', choices: ['miter', 'round', 'bevel'], ops: ['offset'] },
  {
    key: 'trimMultipleShapes', label: 'Trim Multiple Shapes', type: 'choice', default: 'simultaneously',
    choices: ['simultaneously', 'individually'], ops: ['trim'],
  },
  { key: 'seed', label: 'Random Seed', type: 'scalar', default: 0, min: 0, ops: ['roughen', 'wiggleTransform'] },
];

/** A field of the layer's Polystar: `contents/polystar/<path>`, stored under `key` on `fx.polystar`. */
export interface PolystarFieldSpec extends Omit<TextFieldSpec, 'kinds'> {
  path: string;
}

export const POLYSTAR_FIELDS: readonly PolystarFieldSpec[] = [
  { path: 'type', key: 'starType', label: 'Type', type: 'choice', default: 'star', choices: ['star', 'polygon'] },
];
