/**
 * Rig controllers — the grab handles an animator poses a character with.
 *
 * DUIK's controller layer, built against a rig model instead of around the
 * absence of one.
 *
 * ## Why this is rig data and not a layer
 *
 * DUIK makes controllers NULL LAYERS driven by expressions because After
 * Effects has no skeleton: a null plus `toWorld`/`fromWorld` is the only place
 * to put one. Copying that shape here would inherit a workaround for a problem
 * this project does not have. There is a real `SkeletonRig`, so a controller
 * lives on it beside `ikTargets` — which it resembles exactly: positioned,
 * drawn on canvas, owned by the rig, saved with it.
 *
 * What that buys, none of it written here:
 *   • undo, persistence and autosave via `SceneGraph.setFx`, the same route the
 *     guide flag and the paint stack take;
 *   • no new `SceneKind`, so no migration and no timeline/layer-list surface;
 *   • **viewport-only by construction.** Rig data never becomes a render layer,
 *     so there is nothing to exclude at export. Reusing the guide-layer
 *     `forExport` check would have added a branch that can never fire.
 *
 * ## The link is a FIELD, not an expression
 *
 * `link` names the bone or IK target the controller drives, and the solver reads
 * it directly. AE rigs express this as an expression on the driven property
 * because that is the only binding mechanism it has — which is why DUIK ships an
 * expression engine and why its rigs break when a layer is renamed. A field
 * cannot be typo'd, survives renames, is diffable, and needs no evaluation
 * order. This is the one place the design is deliberately unlike the thing it is
 * modelled on.
 *
 * ## Position is an OFFSET, never absolute
 *
 * A controller is drawn at the point it drives, plus `offsetX/offsetY`. It has
 * no independent position and therefore cannot drift away from its joint — the
 * failure that makes hand-placed controls untrustworthy the first time a rig is
 * re-posed. Offset 0 sits exactly on the driven point; a foot control hangs
 * below the ankle by giving it one.
 */

import { boneRoot, type Bone } from './skeleton';
import type { Mat2D } from './mat2d';

/** The fixed shape library. Fixed on purpose — see `CONTROLLER_SHAPES`. */
export type ControllerShape = 'square' | 'circle' | 'arrow' | 'arc';

/**
 * Deliberately a closed set rather than "any shape layer can be a controller".
 * An editable geometry raises questions with no good answer — what a controller
 * means once its path is edited into something unrecognisable, how it hit-tests
 * when concave, what happens when it is emptied. Four shapes cover the
 * vocabulary every rigging tool uses: a box for translation, a circle for a
 * free/IK goal, an arrow for a directional control, an arc for rotation.
 */
export const CONTROLLER_SHAPES: readonly ControllerShape[] = ['square', 'circle', 'arrow', 'arc'];

/** Rig side. Drives colour only — it carries no solver meaning. */
export type ControllerSide = 'left' | 'right' | 'centre';

export const CONTROLLER_SIDES: readonly ControllerSide[] = ['left', 'right', 'centre'];

/**
 * What a controller drives.
 *
 * `ikTarget` moves the goal of the chain ending at `boneId` — the chain solves.
 * `bone` rotates that bone directly (FK).
 *
 * Both name a BONE id, because an IK target is identified by the bone it
 * terminates: `IKTarget.boneId` is its key. One id field, two meanings selected
 * by `kind`, rather than two optional fields where both-set and neither-set are
 * representable states nothing checks.
 */
export interface ControllerLink {
  kind: 'bone' | 'ikTarget';
  boneId: string;
}

export interface RigController {
  id: string;
  /** Human label; falls back to the id in the UI. */
  name?: string;
  shape: ControllerShape;
  side: ControllerSide;
  /**
   * Drawn radius in SCREEN pixels, not layer units — a controller stays the
   * same size on screen at any zoom, like the 3D gizmo and the effect handles.
   * Sizing it in layer units makes it unhittable zoomed out, which is precisely
   * when an animator is looking at the whole character.
   */
  size: number;
  /** Offset from the driven point, in LAYER-LOCAL units. Absent = 0. */
  offsetX?: number;
  offsetY?: number;
  link: ControllerLink;
}

export const DEFAULT_CONTROLLER_SIZE = 14;

/** Screen-px slop added to the drawn radius for hit-testing. */
export const CONTROLLER_HIT_SLOP = 8;

/**
 * Where a controller sits in LAYER-LOCAL space this frame.
 *
 * The single reader for controller placement: the overlay draws here, hit-tests
 * here, and the drag measures from here. Splitting "where it is drawn" from
 * "where it is grabbed" is the §2·0 shape that makes a handle look right and
 * grab wrong — and it is invisible until someone zooms.
 *
 * Returns null when the link dangles (a bone deleted out from under a
 * controller), so callers skip it rather than drawing at the origin. A control
 * stacked at (0,0) reads as a bug in the rig rather than in the link.
 */
export function controllerPosition(
  controller: RigController,
  opts: {
    /** Solved bone world matrices, keyed by bone id. */
    worldTransforms: ReadonlyMap<string, Mat2D>;
    /** Live IK goal positions in layer space, keyed by bone id. */
    ikTargets: ReadonlyMap<string, { x: number; y: number }>;
  },
): { x: number; y: number } | null {
  const base =
    controller.link.kind === 'ikTarget'
      ? opts.ikTargets.get(controller.link.boneId) ?? null
      : (() => {
          const m = opts.worldTransforms.get(controller.link.boneId);
          return m ? boneRoot(m) : null;
        })();
  if (!base) return null;
  return { x: base.x + (controller.offsetX ?? 0), y: base.y + (controller.offsetY ?? 0) };
}

/**
 * NOTE ON HIT-TESTING — there is no pure hit-test here, deliberately.
 *
 * The overlay is SVG, so the browser already does topmost-wins picking against
 * a transparent circle of radius `size + CONTROLLER_HIT_SLOP`. A second,
 * pure `hitTestController` was written and then deleted: nothing called it, so
 * its tests would have asserted a rule the app does not run — an unfaithful
 * fixture that reads as hit-test coverage. The radius rule stays shared by
 * having exactly one constant, and what IS worth guarding is `controllerPosition`
 * composed with the layer projection: where the shape lands on screen under
 * rotation, non-uniform scale, parenting and 3D.
 */

/** The drag mode a controller's link implies — it owns no drag logic of its own. */
export function controllerDragKind(controller: RigController): 'fk' | 'ik' {
  return controller.link.kind === 'ikTarget' ? 'ik' : 'fk';
}

/** True when `boneId` is driven by this controller. Used to assert the negative. */
export function controllerDrives(controller: RigController, boneId: string): boolean {
  return controller.link.boneId === boneId;
}

/** Normalise a stored/partial controller. Unknown shape/side fall back rather than throw. */
export function normalizeController(v: unknown): RigController | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<RigController>;
  if (typeof c.id !== 'string' || !c.id) return null;
  const link = c.link;
  if (!link || typeof link.boneId !== 'string' || !link.boneId) return null;
  return {
    id: c.id,
    ...(typeof c.name === 'string' ? { name: c.name } : {}),
    shape: CONTROLLER_SHAPES.includes(c.shape as ControllerShape) ? (c.shape as ControllerShape) : 'circle',
    side: CONTROLLER_SIDES.includes(c.side as ControllerSide) ? (c.side as ControllerSide) : 'centre',
    size: Number.isFinite(c.size) && (c.size as number) > 0 ? (c.size as number) : DEFAULT_CONTROLLER_SIZE,
    // Omitted when zero — an absent offset and a stored 0 must not be two ways
    // of saying the same thing in a serialised rig.
    ...(Number.isFinite(c.offsetX) && c.offsetX !== 0 ? { offsetX: c.offsetX as number } : {}),
    ...(Number.isFinite(c.offsetY) && c.offsetY !== 0 ? { offsetY: c.offsetY as number } : {}),
    link: { kind: link.kind === 'bone' ? 'bone' : 'ikTarget', boneId: link.boneId },
  };
}

/** A fresh controller id, stable-prefixed for readability in a serialised rig. */
export function newControllerId(existing: readonly RigController[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((c) => c.id));
  while (taken.has(`ctrl_${n}`)) n += 1;
  return `ctrl_${n}`;
}

/** Default controller for a link — circle on an IK goal, arc on an FK bone. */
export function defaultControllerFor(
  link: ControllerLink,
  existing: readonly RigController[],
  bones: readonly Bone[] = [],
): RigController {
  const bone = bones.find((b) => b.id === link.boneId);
  return {
    id: newControllerId(existing),
    ...(bone?.name ? { name: bone.name } : {}),
    shape: link.kind === 'ikTarget' ? 'circle' : 'arc',
    side: 'centre',
    size: DEFAULT_CONTROLLER_SIZE,
    link,
  };
}
