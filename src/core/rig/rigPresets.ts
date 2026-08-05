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

export type RigPresetId = 'biped';

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
}): { bones: Bone[]; target: IKTarget; controller: RigController } {
  const upperId = `${opts.prefix}_upper`;
  const lowerId = `${opts.prefix}_lower`;
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
      x: opts.x + Math.cos(opts.rotation) * (opts.upperLen + opts.lowerLen),
      y: opts.y + Math.sin(opts.rotation) * (opts.upperLen + opts.lowerLen),
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

export const RIG_PRESETS: Record<RigPresetId, (b: PresetBounds) => SkeletonRig> = {
  biped: bipedPreset,
};

export const RIG_PRESET_LABELS: Record<RigPresetId, string> = {
  biped: 'Biped',
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
