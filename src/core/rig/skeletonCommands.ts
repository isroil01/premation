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

export const SKELETON_EDIT_COMMAND = asCommandId('skeleton.edit');

export interface IKTarget {
  boneId: string;
  x: number;
  y: number;
  enabled?: boolean;
}

export interface SkeletonRig extends Skeleton {
  ikTargets?: IKTarget[];
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
    bones: [...(skel?.bones ?? []), bone],
    ikTargets: skel?.ikTargets ?? [],
  };
  applyAndRecord(nodeId, after, `Add Bone ${bone.id}`);
}

/** Delete a bone and any associated keyframe tracks. One undo step. */
export function deleteBone(nodeId: ID, boneId: string): void {
  const skel = currentSkeleton(nodeId);
  if (!skel) return;
  const after: SkeletonRig = {
    bones: (skel.bones ?? []).filter((b) => b.id !== boneId && b.parentId !== boneId),
    ikTargets: (skel.ikTargets ?? []).filter((t) => t.boneId !== boneId),
  };
  const trackEdit = captureAnimEdit(`Delete Bone ${boneId} tracks`, () => {
    defaultAnimation.removeTrack(nodeId, `bone.${boneId}.rotation`);
    defaultAnimation.removeTrack(nodeId, `bone.${boneId}.x`);
    defaultAnimation.removeTrack(nodeId, `bone.${boneId}.y`);
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
    bones: skel?.bones ?? [],
    ikTargets: targets,
  };
  applyAndRecord(nodeId, after, `Set IK Target for ${target.boneId}`);
}
