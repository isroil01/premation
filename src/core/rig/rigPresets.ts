/**
 * Auto-rig presets — a whole skeleton, its IK chains and its controllers in one
 * operation, instead of drawing every bone by hand.
 *
 * ## Pure generator, separate application
 *
 * `bipedPreset(bounds)` returns a `SkeletonRig` and touches nothing. Applying it
 * is one command elsewhere. That split is what makes the validity rules testable
 * without a scene graph, a command system or an undo stack — and those rules are
 * the point: a generated rig has to satisfy exactly the invariants a hand-built
 * one does, or it produces a skeleton someone repairs by hand, which is worse
 * than no preset.
 *
 * ## Sides are VIEWER-space, stated because it is a real ambiguity
 *
 * "Left arm" means the character's left in animation convention, which is
 * screen-right. This preset uses SCREEN space instead: `side: 'left'` sits at
 * negative local x, i.e. the left of the canvas. An animator grabbing a control
 * is looking at the screen, and a control labelled left that lives on the right
 * is a daily irritation. Recorded here rather than left to be rediscovered.
 *
 * ## Proportions
 *
 * Fractions of the layer's own width and height, applied INDEPENDENTLY, so a
 * non-square layer produces a rig that fits it rather than a square rig floating
 * in it. Everything is derived from `bounds`; there are no absolute pixel sizes.
 */

import type { Bone } from './skeleton';
import type { SkeletonRig, IKTarget } from './skeletonCommands';
import type { RigController, ControllerSide } from './controllers';
import { DEFAULT_CONTROLLER_SIZE } from './controllers';

export type RigPresetId = 'biped' | 'quadruped';

export interface PresetBounds {
  /** Layer width in local units. */
  width: number;
  /** Layer height in local units. */
  height: number;
}

/** Smallest layer worth rigging — below this the bones overlap into nonsense. */
export const MIN_PRESET_EXTENT = 16;

/**
 * A two-bone limb: upper + lower, an IK goal at the lower bone's tip, and a
 * controller on that goal.
 *
 * Factored out because arms and legs differ only in where they attach and how
 * long they are — writing them twice is how a left arm ends up with a right
 * leg's chain length.
 */
function limb(opts: {
  prefix: string;
  side: ControllerSide;
  /** Root attachment, local space. */
  x: number;
  y: number;
  upperLen: number;
  lowerLen: number;
  /** Local rotation of the upper bone, radians. */
  rotation: number;
  parentId: string;
  /**
   * Layer-space origin of the parent bone's frame, added to the IK GOAL only.
   *
   * `x`/`y` above are parent-local, but the goal has to be expressed in layer
   * space because that is where `IKTarget` lives. The two coincide only when the
   * parent's frame sits on the layer origin unrotated. The biped attaches its
   * limbs to bones that do NOT (its spine is rotated −90°), and omits this — its
   * goals are approximate by construction and the rest position hides it, since
   * a goal at the limb's own tip does not pose anything on creation.
   *
   * The quadruped attaches its legs to an UNROTATED spine and passes the spine's
   * origin, so its goals are exact. Defaulting to zero keeps the biped's output
   * byte-identical rather than silently re-placing a blessed rig.
   */
  parentOrigin?: { x: number; y: number };
}): { bones: Bone[]; target: IKTarget; controller: RigController } {
  const upperId = `${opts.prefix}_upper`;
  const lowerId = `${opts.prefix}_lower`;
  const origin = opts.parentOrigin ?? { x: 0, y: 0 };
  return {
    bones: [
      {
        id: upperId, name: `${opts.prefix} upper`, parentId: opts.parentId,
        length: opts.upperLen, x: opts.x, y: opts.y, rotation: opts.rotation,
      },
      {
        id: lowerId, name: `${opts.prefix} lower`, parentId: upperId,
        length: opts.lowerLen, x: opts.upperLen, y: 0, rotation: 0,
      },
    ],
    // The goal starts at the limb's own rest tip, so applying a preset does not
    // instantly pose the character — a rig that snaps on creation looks broken
    // before anyone has touched it.
    target: {
      boneId: lowerId,
      x: origin.x + opts.x + Math.cos(opts.rotation) * (opts.upperLen + opts.lowerLen),
      y: origin.y + opts.y + Math.sin(opts.rotation) * (opts.upperLen + opts.lowerLen),
      chainLength: 2,
    },
    controller: {
      id: `ctrl_${opts.prefix}`,
      name: `${opts.prefix} IK`,
      shape: 'circle',
      side: opts.side,
      size: DEFAULT_CONTROLLER_SIZE,
      link: { kind: 'ikTarget', boneId: lowerId },
    },
  };
}

/**
 * A biped: hips → spine → head, two arms, two legs, each limb a two-bone IK
 * chain with a controller on its goal, plus an FK controller on the hips.
 *
 * Local space is centred on the layer, x to the right and y DOWN — the same
 * convention `readGeometry` and the bone solver use, so a limb pointing "down
 * the screen" has a positive-y rotation.
 */
export function bipedPreset(bounds: PresetBounds): SkeletonRig {
  const w = Math.max(MIN_PRESET_EXTENT, bounds.width);
  const h = Math.max(MIN_PRESET_EXTENT, bounds.height);
  const halfH = h / 2;

  // Vertical landmarks as fractions of the layer height, measured from the top.
  const shoulderY = -halfH + h * 0.22;
  const hipY = -halfH + h * 0.52;
  // Horizontal offsets as fractions of the WIDTH, so a wide layer gets a wide
  // stance rather than a narrow one centred in it.
  const shoulderX = w * 0.16;
  const hipX = w * 0.09;

  const spineLen = hipY - shoulderY;
  const headLen = h * 0.16;
  const armUpper = w * 0.20;
  const armLower = w * 0.18;
  const legUpper = h * 0.24;
  const legLower = h * 0.22;

  const bones: Bone[] = [
    { id: 'hips', name: 'Hips', parentId: null, length: Math.abs(spineLen), x: 0, y: hipY, rotation: -Math.PI / 2 },
    { id: 'chest', name: 'Chest', parentId: 'hips', length: Math.abs(spineLen) * 0.6, x: Math.abs(spineLen), y: 0, rotation: 0 },
    { id: 'head', name: 'Head', parentId: 'chest', length: headLen, x: Math.abs(spineLen) * 0.6, y: 0, rotation: 0 },
  ];

  const targets: IKTarget[] = [];
  const controllers: RigController[] = [
    // The body control. FK, because the hips are posed by rotation rather than
    // by reaching for a point.
    {
      id: 'ctrl_hips', name: 'Hips', shape: 'square', side: 'centre',
      size: DEFAULT_CONTROLLER_SIZE + 4, link: { kind: 'bone', boneId: 'hips' },
    },
  ];

  // Arms hang outward and down; legs straight down. `side` is SCREEN side — see
  // the header — so left is negative x.
  const limbs = [
    limb({ prefix: 'arm_l', side: 'left', x: -shoulderX, y: shoulderY, upperLen: armUpper, lowerLen: armLower, rotation: Math.PI * 0.72, parentId: 'chest' }),
    limb({ prefix: 'arm_r', side: 'right', x: shoulderX, y: shoulderY, upperLen: armUpper, lowerLen: armLower, rotation: Math.PI * 0.28, parentId: 'chest' }),
    limb({ prefix: 'leg_l', side: 'left', x: -hipX, y: hipY, upperLen: legUpper, lowerLen: legLower, rotation: Math.PI * 0.5, parentId: 'hips' }),
    limb({ prefix: 'leg_r', side: 'right', x: hipX, y: hipY, upperLen: legUpper, lowerLen: legLower, rotation: Math.PI * 0.5, parentId: 'hips' }),
  ];
  for (const l of limbs) {
    bones.push(...l.bones);
    targets.push(l.target);
    controllers.push(l.controller);
  }

  return { bones, ikTargets: targets, controllers };
}

/**
 * A quadruped in SIDE VIEW, facing screen-right: spine and hips along the body
 * line, neck and head forward, tail back, and four legs as two-bone IK chains.
 *
 * ## Why side view, and what `side` means here
 *
 * A quadruped drawn front-on has no usable 2D rig — its legs occlude each other
 * and nothing bends in the picture plane. Every 2D quadruped rig is a side view,
 * so this generates one rather than pretending the choice is open.
 *
 * That makes `side` read oddly at first: the four legs are FORE and HIND, not
 * left and right. `ControllerSide` "drives colour only — it carries no solver
 * meaning", and the convention this file already documents is that `side` is
 * SCREEN side, `left` = negative local x. Fore legs sit at positive x and hind
 * legs at negative x, so fore controls colour as `right` and hind as `left`, and
 * an animator gets the fore and hind sets in two different colours. Inventing a
 * fore/hind enum would have meant a schema change, a migration, and a new case in
 * every controller reader, to recolour four handles.
 *
 * ## Every controller's side is derivable from where it ENDS UP
 *
 * The spine bone is rooted at x = 0 deliberately, so the body control's driven
 * point is exactly on the midline and `centre` is a measurable claim rather than
 * a label. That is what lets the guard anchor EVERY controller — including the
 * centre ones — to the sign of the point it drives, instead of exempting the
 * midline and checking only the halves against each other (rule 2b).
 *
 * ## Legs hang from an UNROTATED parent
 *
 * All four attach to `spine`, whose rotation is 0. Bone `x`/`y` are parent-local
 * while an IK goal is layer-space, and those coincide only under an unrotated
 * parent — so this arrangement is what makes the goals exact rather than
 * approximate. See `limb`'s `parentOrigin`.
 */
export function quadrupedPreset(bounds: PresetBounds): SkeletonRig {
  const w = Math.max(MIN_PRESET_EXTENT, bounds.width);
  const h = Math.max(MIN_PRESET_EXTENT, bounds.height);
  const halfH = h / 2;

  // The body line, measured from the top. Legs occupy everything below it.
  const spineY = -halfH + h * 0.34;
  // Half the barrel: the spine runs from the origin forward to the shoulder and
  // the hips run backward from the same point, so the two are exact mirrors.
  const spineHalf = w * 0.30;
  // Fore/hind pairs are separated in x rather than in depth — a side view has no
  // depth — so the far leg of each pair reads as a leg rather than as a smear.
  const spread = w * 0.05;

  const bones: Bone[] = [
    { id: 'spine', name: 'Spine', parentId: null, length: spineHalf, x: 0, y: spineY, rotation: 0 },
    // Backward from the same root, so hip and shoulder are mirrored about x = 0.
    { id: 'hips', name: 'Hips', parentId: 'spine', length: spineHalf, x: 0, y: 0, rotation: Math.PI },
    { id: 'chest', name: 'Chest', parentId: 'spine', length: w * 0.10, x: spineHalf, y: 0, rotation: 0 },
    { id: 'neck', name: 'Neck', parentId: 'chest', length: h * 0.20, x: w * 0.10, y: 0, rotation: -Math.PI * 0.32 },
    // Levels out again, so the head reads as horizontal rather than continuing
    // the neck's climb.
    { id: 'head', name: 'Head', parentId: 'neck', length: h * 0.14, x: h * 0.20, y: 0, rotation: Math.PI * 0.32 },
    // Continues the hips' direction (its local rotation is 0 in an already
    // reversed frame), so the tail trails behind the animal.
    { id: 'tail', name: 'Tail', parentId: 'hips', length: w * 0.24, x: spineHalf, y: 0, rotation: 0 },
  ];

  const targets: IKTarget[] = [];
  const controllers: RigController[] = [
    // Body control. FK on the spine root, which sits ON the midline — see the
    // header: that is what makes `centre` checkable.
    {
      id: 'ctrl_root', name: 'Body', shape: 'square', side: 'centre',
      size: DEFAULT_CONTROLLER_SIZE + 4, link: { kind: 'bone', boneId: 'spine' },
    },
    { id: 'ctrl_head', name: 'Head', shape: 'arc', side: 'right', size: DEFAULT_CONTROLLER_SIZE, link: { kind: 'bone', boneId: 'head' } },
    { id: 'ctrl_tail', name: 'Tail', shape: 'arc', side: 'left', size: DEFAULT_CONTROLLER_SIZE, link: { kind: 'bone', boneId: 'tail' } },
  ];

  // Legs straight down (+y is DOWN). Hind legs are the longer pair, as they are
  // on the animal. `near` is the outer leg of each pair.
  const spineOrigin = { x: 0, y: spineY };
  const legs = [
    limb({ prefix: 'leg_fore_near', side: 'right', x: spineHalf + spread, y: 0, upperLen: h * 0.30, lowerLen: h * 0.28, rotation: Math.PI * 0.5, parentId: 'spine', parentOrigin: spineOrigin }),
    limb({ prefix: 'leg_fore_far', side: 'right', x: spineHalf - spread, y: 0, upperLen: h * 0.30, lowerLen: h * 0.28, rotation: Math.PI * 0.5, parentId: 'spine', parentOrigin: spineOrigin }),
    limb({ prefix: 'leg_hind_near', side: 'left', x: -spineHalf - spread, y: 0, upperLen: h * 0.32, lowerLen: h * 0.28, rotation: Math.PI * 0.5, parentId: 'spine', parentOrigin: spineOrigin }),
    limb({ prefix: 'leg_hind_far', side: 'left', x: -spineHalf + spread, y: 0, upperLen: h * 0.32, lowerLen: h * 0.28, rotation: Math.PI * 0.5, parentId: 'spine', parentOrigin: spineOrigin }),
  ];
  for (const l of legs) {
    bones.push(...l.bones);
    targets.push(l.target);
    controllers.push(l.controller);
  }

  return { bones, ikTargets: targets, controllers };
}

export const RIG_PRESETS: Record<RigPresetId, (b: PresetBounds) => SkeletonRig> = {
  biped: bipedPreset,
  quadruped: quadrupedPreset,
};

export const RIG_PRESET_LABELS: Record<RigPresetId, string> = {
  biped: 'Biped',
  quadruped: 'Quadruped',
};

// ── Validity ────────────────────────────────────────────────────────────
// The rules a HAND-BUILT rig already obeys, written once and applied to
// generated ones. Derived from the constraints the rest of the rig code
// enforces rather than invented here:
//   • unique bone ids — `create_skeleton_rig` rejects duplicates because ids key
//     the animation tracks (`bone.<id>.rotation`), so a duplicate silently
//     couples two bones;
//   • resolvable parents and no cycles — `computeWorldTransforms` walks parents;
//   • `chainLength` in [1, 8] — `ikChainIds` clamps to MAX_CHAIN = 8;
//   • every controller link resolves — `controllerPosition` returns null and the
//     control silently vanishes otherwise.

export interface RigProblem {
  kind: 'duplicate-bone' | 'unknown-parent' | 'cycle' | 'bad-chain-length' | 'dangling-link' | 'unknown-target';
  detail: string;
}

/** Every way the rig is invalid. Empty means valid. */
export function validateRig(rig: SkeletonRig): RigProblem[] {
  const problems: RigProblem[] = [];
  const bones = rig.bones ?? [];
  const byId = new Map<string, Bone>();

  for (const b of bones) {
    if (byId.has(b.id)) problems.push({ kind: 'duplicate-bone', detail: b.id });
    byId.set(b.id, b);
  }
  for (const b of bones) {
    if (b.parentId != null && !byId.has(b.parentId)) {
      problems.push({ kind: 'unknown-parent', detail: `${b.id} → ${b.parentId}` });
    }
  }
  // Cycle detection by walking each bone to a root, bounded by the bone count so
  // a cycle terminates instead of hanging the caller.
  for (const b of bones) {
    const seen = new Set<string>([b.id]);
    let cur = b.parentId ? byId.get(b.parentId) : undefined;
    let steps = 0;
    while (cur && steps <= bones.length) {
      if (seen.has(cur.id)) { problems.push({ kind: 'cycle', detail: `${b.id} … ${cur.id}` }); break; }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      steps += 1;
    }
  }
  for (const t of rig.ikTargets ?? []) {
    if (!byId.has(t.boneId)) problems.push({ kind: 'unknown-target', detail: t.boneId });
    const n = t.chainLength;
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 8)) {
      problems.push({ kind: 'bad-chain-length', detail: `${t.boneId}: ${n}` });
    }
  }
  const targetBones = new Set((rig.ikTargets ?? []).map((t) => t.boneId));
  for (const c of rig.controllers ?? []) {
    const ok = c.link.kind === 'bone' ? byId.has(c.link.boneId) : targetBones.has(c.link.boneId);
    if (!ok) problems.push({ kind: 'dangling-link', detail: `${c.id} → ${c.link.kind} ${c.link.boneId}` });
  }
  return problems;
}
