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
import type { PuppetRig } from './puppet';
import type { RigController } from './controllers';
import { planChainSwitch, chainModePropPath, chainModeValue, type ChainMode } from './ikfk';
import { resolveActiveIkTargets } from './liveIkTargets';
import { validateRig, type RigProblem } from './rigPresets';
import { readNodeKind } from '@core/scene/sceneDerive';
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
  /**
   * The REST skeleton the skin is bound to — captured the first time the rig is
   * POSED, and never written by a pose again.
   *
   * `bones` carries two jobs at once: it is the rig's structure AND the pose a
   * bone holds when no keyframe track drives it. That is fine until a pose drag
   * with auto-keyframe off (the DEFAULT) writes the dragged rotation straight
   * into it — the bind pose then tracks the posed pose exactly, every
   * `pose · bindInverse` collapses to the identity, and the artwork does not
   * move at all while the bone visibly swings. Splitting the bind pose out is
   * what makes a non-keyframing drag deform anything.
   *
   * Absent in every rig authored before this field, and absence means "`bones`
   * IS the bind pose", which is exactly what those rigs did — so this is
   * additive, with no migration and no change to how an old document opens.
   * Only the POSE channels (x/y/rotation/scale) are stored; structure (parent,
   * length, influence radius) always comes from the live bone, so a rig-mode
   * edit can never be shadowed by a stale bind entry. See `bindPoseBones`.
   */
  bindPose?: Bone[];
  /** Skinning mesh controls (skeleton-only layers) — same semantics as the
   *  puppet rig's meshDensity/meshExpansion. When a puppet rig coexists on the
   *  layer, the shared mesh comes from the puppet settings instead. */
  meshDensity?: number;
  meshExpansion?: number;
  /**
   * Meshing strategy, same values and same meaning as the puppet rig's.
   *
   * 'grid' (absent, and every rig authored before this field) lays a uniform
   * lattice over the bounding box and culls it against the layer's alpha.
   * 'silhouette' traces the alpha OUTLINE and Delaunay-fills it (`alphaMesh.ts`)
   * so a thin limb becomes its own strip of triangles instead of a square
   * neighbourhood of the bbox — which is what lets a bone bend an arm rather
   * than drag the rectangle the arm sits in.
   *
   * The skeleton had no way to ASK for that mesh: only `meshDensity` and
   * `meshExpansion` were forwarded to `getCachedRestMesh`, so a bone-rigged PNG
   * silently got the grid however the puppet half was configured.
   */
  meshMode?: PuppetRig['meshMode'];
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

/**
 * The bones to BIND the skin to — the single reader of `SkeletonRig.bindPose`.
 *
 * Structure (parentId, length, influenceRadius) always comes from the live
 * bone; only the pose channels are overlaid from the stored bind. That
 * asymmetry is what keeps the two in step without a migration: lengthening a
 * bone or re-parenting it in rig mode takes effect on the binding immediately,
 * a bone added after the bind was captured binds where it was drawn, and a
 * bind entry left behind by a deleted bone is simply never looked up.
 *
 * No `bindPose` (every rig authored before it, and every rig never posed
 * statically) returns `bones` unchanged, so old documents bind exactly as they
 * always did.
 */
export function bindPoseBones(skel: SkeletonRig | undefined): Bone[] {
  const bones = skel?.bones ?? [];
  const bind = skel?.bindPose;
  if (!bind || bind.length === 0) return bones;
  const byId = new Map(bind.map((b) => [b.id, b]));
  return bones.map((b) => {
    const rest = byId.get(b.id);
    if (!rest) return b;
    return {
      ...b,
      x: rest.x,
      y: rest.y,
      rotation: rest.rotation,
      ...(rest.scaleX !== undefined ? { scaleX: rest.scaleX } : {}),
      ...(rest.scaleY !== undefined ? { scaleY: rest.scaleY } : {}),
    };
  });
}

/**
 * The rig with its bind pose pinned to the CURRENT bones, if it has not been
 * captured yet. Called by a pose gesture before it writes a posed value into
 * `bones`, which is the one moment the two meanings of `bones` separate.
 */
export function captureBindPose(skel: SkeletonRig): SkeletonRig {
  if (skel.bindPose && skel.bindPose.length > 0) return skel;
  return { ...skel, bindPose: (skel.bones ?? []).map((b) => ({ ...b })) };
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

/**
 * The mesh a BRAND-NEW skeleton should be skinned to, by layer kind — the same
 * rule `addPuppetPin` applies on the first pin, for the same reason: an image
 * layer's artwork is its alpha, so the outline mesh gives a limb its own strip
 * of triangles instead of a square patch of the bounding box.
 *
 * Only ever consulted for the FIRST bone. A rig that already has bones keeps
 * whatever mesh it was authored against, because a stored document must open
 * with the mesh its weights were painted on. `buildRestMesh` falls back to the
 * grid whenever the outline is unusable, so this can only improve the mesh.
 */
function defaultSkeletonMeshMode(nodeId: ID): SkeletonRig['meshMode'] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return 'grid';
  const kind = readNodeKind(node);
  return kind === 'image' || kind === 'svg' ? 'silhouette' : 'grid';
}

/** Add a bone to the layer's skeleton rig. One undo step. */
export function addBone(nodeId: ID, bone: Bone): void {
  const skel = currentSkeleton(nodeId);
  const after: SkeletonRig = {
    ...skel,
    bones: [...(skel?.bones ?? []), bone],
    ikTargets: skel?.ikTargets ?? [],
  };
  if ((skel?.bones?.length ?? 0) === 0 && after.meshMode === undefined) {
    // Only WRITE the outline choice. 'grid' is what an absent field already
    // means, so a shape layer's rig stays byte-identical to what it was.
    const mode = defaultSkeletonMeshMode(nodeId);
    if (mode === 'silhouette') after.meshMode = mode;
  }
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
    ...(skel.bindPose
      ? { bindPose: skel.bindPose.filter((b) => !removed.has(b.id)) }
      : {}),
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

/**
 * Update static bone parameters (length, parentId, rotation, x, y). One undo step.
 *
 * This is the RIG-mode editor, so it moves the bind pose with the bone: typing a
 * new length or origin here means "the skeleton is shaped like this", not "the
 * character is posed like this". A pose gesture goes through `previewSkeleton`
 * instead and deliberately leaves `bindPose` alone.
 */
export function updateBone(nodeId: ID, boneId: string, patch: Partial<Bone>): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const after: SkeletonRig = {
    ...skel,
    bones: (skel.bones ?? []).map((b) => (b.id === boneId ? { ...b, ...patch } : b)),
    ...(skel.bindPose
      ? { bindPose: skel.bindPose.map((b) => (b.id === boneId ? { ...b, ...patch } : b)) }
      : {}),
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
  patch: Partial<Pick<SkeletonRig, 'meshDensity' | 'meshExpansion' | 'meshMode'>>,
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
  // A preset is a whole rig, so it goes through the same first-rig mesh choice
  // `addBone` makes — otherwise auto-rigging a PNG produced a bbox-grid skin
  // while drawing the identical bones by hand produced the outline one.
  let rig = preset;
  if (rig.meshMode === undefined && defaultSkeletonMeshMode(nodeId) === 'silhouette') {
    rig = { ...rig, meshMode: 'silhouette' };
  }
  applyAndRecord(nodeId, rig, label);
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
