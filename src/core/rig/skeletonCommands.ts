/**
 * Undoable skeleton-rig structural edits (bone add / delete / update / IK target).
 *
 * Follows the AnimEditCommand / PuppetEditCommand convention: captures before/after
 * state and records a single reversible command on CommandSystem history.
 */

import { asCommandId } from '@app-types/common';
import type {  SceneNode } from '@core/types';
import type { Bone, Skeleton } from './skeleton';
import type { PuppetRig } from './puppet';
import type { RigController } from './controllers';
import {    type ChainMode } from './ikfk';
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
