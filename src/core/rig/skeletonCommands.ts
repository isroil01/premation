/**
 * Undoable skeleton-rig structural edits (bone add / delete / update / IK target).
 *
 * Follows the AnimEditCommand / PuppetEditCommand convention: captures before/after
 * state and records a single reversible command on CommandSystem history.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { captureAnimEdit, type AnimEditCommand } from '@core/animation/animationCommands';
import { bumpScene } from '@stores/sceneStore';
import type { ID, SceneNode } from '@core/types';
import type { Bone, Skeleton } from './skeleton';
import type { RigController } from './controllers';
import { planChainSwitch, chainModePropPath, chainModeValue, type ChainMode } from './ikfk';
import { resolveActiveIkTargets } from './liveIkTargets';
import { validateRig, type RigProblem } from './rigPresets';
import type { WeightPaintMap } from './weightPaint';

export const SKELETON_EDIT_COMMAND = asCommandId('skeleton.edit');

export interface IKTarget {
  boneId: string;
  /** Target position in LAYER-LOCAL space (the mesh/bone coordinate space).
   *  Keyframeable via the ikTarget.<boneId>.x /.y scalar tracks; these static
   *  values are the fallback when no track exists. */
  x: number;
  y: number;
  enabled?: boolean;
  /** Bones in the solved chain (target bone + ancestors). Default 2, max 8. */
  chainLength?: number;
  /**
   * Pole vector (layer-local) for a two-bone chain: the side the joint bends
   * toward. Bend-side preservation is a good default, but it can only ever KEEP
   * the current side — a pole lets you choose and keyframe it (DUIK/Rive
   * behaviour). Absent keeps the preserve-current-side default.
   */
  pole?: { x: number; y: number };
  /**
   * Which way this chain is driven. Absent = IK, so every rig authored before
   * IK/FK switching keeps solving exactly as it did — additive, no migration.
   *
   * The keyframeable `ikMode.<boneId>` track wins over this when present; this
   * is the value a chain holds with no track. See `ikfk.ts`.
   */
  ikMode?: ChainMode;
}

export interface SkeletonRig extends Skeleton {
  ikTargets?: IKTarget[];
  /** Skinning mesh controls (skeleton-only layers) — same semantics as the
   *  puppet rig's meshDensity/meshExpansion. When a puppet rig coexists on the
   *  layer, the shared mesh comes from the puppet settings instead. */
  meshDensity?: number;
  meshExpansion?: number;
  /** Per-vertex bone-weight overrides painted on top of the auto binding. */
  weightPaint?: WeightPaintMap;
  /**
   * Grab handles that drive bones and IK goals — see `controllers.ts`.
   * Absent in every rig authored before controllers existed, and absence means
   * "none", so this is additive: no migration and no version bump.
   */
  controllers?: RigController[];
}

/** Read a node's skeleton rig from its fx component. */
export function readNodeSkeleton(node: SceneNode): SkeletonRig | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.skeleton as SkeletonRig | undefined;
}

function cloneSkeleton(skel: SkeletonRig | undefined): SkeletonRig | undefined {
  return skel ? (JSON.parse(JSON.stringify(skel)) as SkeletonRig) : undefined;
}

export class SkeletonEditCommand implements Command {
  readonly id = SKELETON_EDIT_COMMAND;
  readonly label: string;

  private readonly nodeId: ID;
  private readonly before: SkeletonRig | undefined;
  private readonly after: SkeletonRig | undefined;
  private readonly trackEdit: AnimEditCommand | null;

  constructor(
    nodeId: ID,
    before: SkeletonRig | undefined,
    after: SkeletonRig | undefined,
    label: string,
    trackEdit: AnimEditCommand | null = null,
  ) {
    this.nodeId = nodeId;
    this.before = cloneSkeleton(before);
    this.after = cloneSkeleton(after);
    this.label = label;
    this.trackEdit = trackEdit;
  }

  execute(): void {
    defaultSceneGraph.setSkeleton(this.nodeId, cloneSkeleton(this.after));
    this.trackEdit?.execute();
    bumpScene();
  }

  undo(): void {
    defaultSceneGraph.setSkeleton(this.nodeId, cloneSkeleton(this.before));
    this.trackEdit?.undo();
    bumpScene();
  }
}

function currentSkeleton(nodeId: ID): SkeletonRig | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeSkeleton(node) : undefined;
}

function applyAndRecord(
  nodeId: ID,
  after: SkeletonRig | undefined,
  label: string,
  trackEdit: AnimEditCommand | null = null,
): void {
  const before = currentSkeleton(nodeId);
  defaultSceneGraph.setSkeleton(nodeId, cloneSkeleton(after));
  bumpScene();
  getCommandSystem()
    .getHistory()
    .push(new SkeletonEditCommand(nodeId, before, after, label, trackEdit));
}

/** Add a bone to the layer's skeleton rig. One undo step. */
export function addBone(nodeId: ID, bone: Bone): void {
  const skel = currentSkeleton(nodeId);
  const after: SkeletonRig = {
    ...skel,
    bones: [...(skel?.bones ?? []), bone],
    ikTargets: skel?.ikTargets ?? [],
  };
  applyAndRecord(nodeId, after, `Add Bone ${bone.id}`);
}

/** Delete a complete bone subtree and every rig/animation reference to it. */
export function deleteBone(nodeId: ID, boneId: string): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const removed = new Set<string>([boneId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const bone of skel.bones ?? []) {
      if (bone.parentId && removed.has(bone.parentId) && !removed.has(bone.id)) {
        removed.add(bone.id);
        changed = true;
      }
    }
  }
  const nextPaint = skel.weightPaint
    ? {
        ...skel.weightPaint,
        bones: Object.fromEntries(
          Object.entries(skel.weightPaint.bones).filter(([id]) => !removed.has(id)),
        ),
      }
    : undefined;
  const after: SkeletonRig = {
    ...skel,
    bones: (skel.bones ?? []).filter((b) => !removed.has(b.id)),
    ikTargets: (skel.ikTargets ?? []).filter((t) => !removed.has(t.boneId)),
    ...(skel.controllers
      ? { controllers: skel.controllers.filter((c) => !removed.has(c.link.boneId)) }
      : {}),
    ...(nextPaint ? { weightPaint: nextPaint } : { weightPaint: undefined }),
  };
  const trackEdit = captureAnimEdit(`Delete Bone ${boneId} tracks`, () => {
    for (const id of removed) {
      defaultAnimation.removeTrack(nodeId, `bone.${id}.rotation`);
      defaultAnimation.removeTrack(nodeId, `bone.${id}.x`);
      defaultAnimation.removeTrack(nodeId, `bone.${id}.y`);
      defaultAnimation.removeTrack(nodeId, `bone.${id}.scaleX`);
      defaultAnimation.removeTrack(nodeId, `bone.${id}.scaleY`);
      defaultAnimation.removeTrack(nodeId, `ikTarget.${id}.x`);
      defaultAnimation.removeTrack(nodeId, `ikTarget.${id}.y`);
      defaultAnimation.removeTrack(nodeId, `ikPole.${id}.x`);
      defaultAnimation.removeTrack(nodeId, `ikPole.${id}.y`);
      defaultAnimation.removeTrack(nodeId, `ikMode.${id}`);
    }
  });
  applyAndRecord(nodeId, after, `Delete Bone ${boneId}`, trackEdit);
}

/** Update static bone parameters (length, parentId, rotation, x, y). One undo step. */
export function updateBone(nodeId: ID, boneId: string, patch: Partial<Bone>): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const after: SkeletonRig = {
    ...skel,
    bones: (skel.bones ?? []).map((b) => (b.id === boneId ? { ...b, ...patch } : b)),
  };
  applyAndRecord(nodeId, after, `Edit Bone ${boneId}`);
}

/** Set or toggle an IK target on a bone. One undo step. */
export function setIKTarget(nodeId: ID, target: IKTarget): void {
  const skel = currentSkeleton(nodeId);
  const targets = (skel?.ikTargets ?? []).filter((t) => t.boneId !== target.boneId);
  if (target.enabled !== false) targets.push(target);
  const after: SkeletonRig = {
    ...skel,
    bones: skel?.bones ?? [],
    ikTargets: targets,
  };
  applyAndRecord(nodeId, after, `Set IK Target for ${target.boneId}`);
}

/** Update rig-level skinning mesh settings (density / expansion). One undo step. */
export function updateSkeletonSettings(
  nodeId: ID,
  patch: Partial<Pick<SkeletonRig, 'meshDensity' | 'meshExpansion'>>,
): void {
  const skel = currentSkeleton(nodeId);
  const after: SkeletonRig = { bones: [], ikTargets: [], ...skel, ...patch };
  applyAndRecord(nodeId, after, 'Edit Skeleton Mesh');
}

/**
 * Replace the layer's painted weight map. One undo step per stroke — the
 * overlay paints into a scratch map during a drag and commits once on release,
 * so a stroke is a single history entry rather than one per pointermove.
 */
export function setWeightPaint(nodeId: ID, weightPaint: WeightPaintMap | undefined): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const after: SkeletonRig = { ...skel, weightPaint };
  applyAndRecord(nodeId, after, 'Paint Bone Weights');
}

// ── Controllers ─────────────────────────────────────────────────────────
// STRUCTURAL edits only. POSING a controller writes keyframes on the bone or
// IK-target tracks and never touches the rig, so it does not come through here
// — see `BoneOverlay`. Keeping the two apart is what makes a pose one undo entry
// instead of a rig edit stacked on an animation edit.

/**
 * Write the rig with NO history entry — a live drag preview.
 *
 * Paired with `recordSkeletonPose`, which pushes the single entry on release.
 * This is the weight-paint stroke's shape: many writes during the gesture, one
 * undo step for it. Exported so the recording rule stays in this module and the
 * overlay never pushes a command itself (§2·0 — one reader for how a skeleton
 * edit reaches history).
 */
export function previewSkeleton(nodeId: ID, rig: SkeletonRig | undefined): void {
  defaultSceneGraph.setSkeleton(nodeId, cloneSkeleton(rig));
  bumpScene();
}

/** Close a previewed gesture as ONE undo entry, restoring to `before` on undo. */
export function recordSkeletonPose(
  nodeId: ID,
  before: SkeletonRig | undefined,
  label: string,
): void {
  const after = currentSkeleton(nodeId);
  getCommandSystem()
    .getHistory()
    .push(new SkeletonEditCommand(nodeId, before, after, label));
}

/**
 * Switch a chain between IK and FK, preserving the pose. ONE undo entry.
 *
 * The plan is computed from the CURRENT pose before anything is written (see
 * `planChainSwitch`), so the order of the writes below cannot change what was
 * measured. Everything — the mode, the rotations or the target — lands inside a
 * single `captureAnimEdit` nested in one `SkeletonEditCommand`, because a
 * half-undone switch is a moved limb, which is the one outcome this feature
 * exists to prevent.
 *
 * Keyframes go on the LAYER axis (`layerT`, from `getRemappedTime` via
 * `compToKeyframeTime`) — the mode is animation data, so a shot can be IK for
 * the contact and FK for the follow-through.
 */
export function setChainMode(
  nodeId: ID,
  boneId: string,
  to: ChainMode,
  opts: { layerT: number; keyframe: boolean },
): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const target = (skel.ikTargets ?? []).find((t) => t.boneId === boneId);
  if (!target) return;

  // Live bones and live targets, exactly as the solver sees them this frame.
  const liveBones = (skel.bones ?? []).map((b) => {
    const r = defaultAnimation.sample(nodeId, `bone.${b.id}.rotation`, opts.layerT);
    return typeof r === "number" ? { ...b, rotation: r } : { ...b };
  });
  const liveTargets = resolveActiveIkTargets(skel, nodeId, opts.layerT);
  const plan = planChainSwitch(liveBones, liveTargets, boneId, to, target.chainLength);

  const after: SkeletonRig = {
    ...skel,
    ikTargets: (skel.ikTargets ?? []).map((t) =>
      t.boneId === boneId ? { ...t, ikMode: to } : t,
    ),
  };

  const trackEdit = captureAnimEdit(`Switch ${boneId} to ${to.toUpperCase()}`, () => {
    if (opts.keyframe) {
      defaultAnimation.setKeyframe(nodeId, chainModePropPath(boneId), opts.layerT, chainModeValue(to));
    }
    // Pose preservation. IK -> FK writes the solved rotations; FK -> IK writes
    // the effector. Written as keyframes when the gesture keyframes, so the
    // preserved pose survives at THIS time rather than being a static value a
    // later frame overrides.
    for (const [id, rot] of plan.rotations) {
      if (opts.keyframe) defaultAnimation.setKeyframe(nodeId, `bone.${id}.rotation`, opts.layerT, rot);
    }
    if (plan.target && opts.keyframe) {
      defaultAnimation.setKeyframe(nodeId, `ikTarget.${boneId}.x`, opts.layerT, plan.target.x);
      defaultAnimation.setKeyframe(nodeId, `ikTarget.${boneId}.y`, opts.layerT, plan.target.y);
    }
  });

  // Static writes go on the rig itself so a non-keyframing switch still holds
  // its pose. Folded into `after` rather than written separately, so the single
  // SkeletonEditCommand carries them.
  if (!opts.keyframe) {
    if (plan.rotations.size > 0) {
      after.bones = (after.bones ?? []).map((b) =>
        plan.rotations.has(b.id) ? { ...b, rotation: plan.rotations.get(b.id)! } : b,
      );
    }
    if (plan.target) {
      after.ikTargets = (after.ikTargets ?? []).map((t) =>
        t.boneId === boneId ? { ...t, x: plan.target!.x, y: plan.target!.y } : t,
      );
    }
  }

  applyAndRecord(nodeId, after, `Switch ${boneId} to ${to.toUpperCase()}`, trackEdit);
}
/**
 * Apply a rig preset — bones, IK chains and controllers — as ONE undo entry.
 *
 * One entry falls out of the storage choice rather than being arranged: bones,
 * targets and controllers all live on the same `fx.skeleton` blob, so a single
 * `setSkeleton` carries the whole rig and `applyAndRecord` records one
 * `SkeletonEditCommand`. Nothing here bundles or batches.
 *
 * REPLACES any existing rig rather than merging. Merging two skeletons produces
 * duplicate bone ids, and a duplicate id silently couples two bones onto one
 * animation track (`bone.<id>.rotation`) — the failure `create_skeleton_rig`
 * already rejects rather than writes. Replacing is destructive and obvious;
 * merging is non-destructive and corrupt.
 *
 * Refuses to write an invalid rig at all. A generated skeleton someone has to
 * repair by hand is worse than none, so `validateRig` gates it and the caller
 * gets the problems back instead of a broken rig.
 */
export function applyRigPreset(
  nodeId: ID,
  preset: SkeletonRig,
  label = "Auto-Rig",
): RigProblem[] {
  const problems = validateRig(preset);
  if (problems.length > 0) return problems;
  applyAndRecord(nodeId, preset, label);
  return [];
}
/** Add a controller. One undo step. */
export function addController(nodeId: ID, controller: RigController): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const after: SkeletonRig = {
    ...skel,
    controllers: [...(skel.controllers ?? []), controller],
  };
  applyAndRecord(nodeId, after, `Add Controller ${controller.name ?? controller.id}`);
}

/** Delete a controller. One undo step. */
export function deleteController(nodeId: ID, controllerId: string): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const after: SkeletonRig = {
    ...skel,
    controllers: (skel.controllers ?? []).filter((c) => c.id !== controllerId),
  };
  applyAndRecord(nodeId, after, `Delete Controller ${controllerId}`);
}

/**
 * Update a controller's static properties (shape / side / size / offset / link).
 * One undo step.
 *
 * No animation tracks to clean up when the link changes: a controller owns no
 * keyframes of its own. Re-pointing one at another bone leaves the OLD bone's
 * pose exactly as it was, which is the behaviour you want — re-linking a control
 * is not an instruction to undo the animation it used to drive.
 */
export function updateController(
  nodeId: ID,
  controllerId: string,
  patch: Partial<Omit<RigController, 'id'>>,
): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const after: SkeletonRig = {
    ...skel,
    controllers: (skel.controllers ?? []).map((c) =>
      c.id === controllerId ? { ...c, ...patch } : c,
    ),
  };
  applyAndRecord(nodeId, after, 'Edit Controller');
}
