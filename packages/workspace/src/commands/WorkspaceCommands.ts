/**
 * WorkspaceCommands — the vocabulary of intents the workspace submits to the
 * app's Command System. The workspace never mutates the Scene Graph itself; it
 * describes *what the user did* and lets the host apply it undoably. These
 * builders keep payload shapes consistent between tools and the binding layer.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { NodeId, WorkspaceCommand } from '../ports';

export const WorkspaceCommandType = {
  MoveNodes: 'workspace.moveNodes',
  ResizeNode: 'workspace.resizeNode',
  RotateNode: 'workspace.rotateNode',
  CreateNode: 'workspace.createNode',
  DeleteNodes: 'workspace.deleteNodes',
} as const;

export type WorkspaceCommandTypeName =
  (typeof WorkspaceCommandType)[keyof typeof WorkspaceCommandType];

export interface MoveNodesPayload {
  ids: readonly NodeId[];
  /** World-space delta applied to each node. */
  delta: Vec2;
}

export interface ResizeNodePayload {
  id: NodeId;
  /** New world-space bounds. */
  bounds: Rect;
}

export interface RotateNodePayload {
  id: NodeId;
  /** Absolute rotation in radians. */
  rotation: number;
  /** World-space pivot. */
  pivot: Vec2;
}

export interface CreateNodePayload {
  /** Node kind hint for the binding (e.g. "Rectangle", "Ellipse", "Text"). */
  kind: string;
  /** Initial world-space bounds. */
  bounds: Rect;
  /** Optional path points in world space (pen tool). */
  points?: Vec2[];
}

export interface DeleteNodesPayload {
  ids: readonly NodeId[];
}

export const commands = {
  moveNodes(ids: readonly NodeId[], delta: Vec2): WorkspaceCommand {
    return { type: WorkspaceCommandType.MoveNodes, payload: { ids, delta } satisfies MoveNodesPayload };
  },
  resizeNode(id: NodeId, bounds: Rect): WorkspaceCommand {
    return { type: WorkspaceCommandType.ResizeNode, payload: { id, bounds } satisfies ResizeNodePayload };
  },
  rotateNode(id: NodeId, rotation: number, pivot: Vec2): WorkspaceCommand {
    return {
      type: WorkspaceCommandType.RotateNode,
      payload: { id, rotation, pivot } satisfies RotateNodePayload,
    };
  },
  createNode(kind: string, bounds: Rect, points?: Vec2[]): WorkspaceCommand {
    const payload: CreateNodePayload = points ? { kind, bounds, points } : { kind, bounds };
    return { type: WorkspaceCommandType.CreateNode, payload };
  },
  deleteNodes(ids: readonly NodeId[]): WorkspaceCommand {
    return { type: WorkspaceCommandType.DeleteNodes, payload: { ids } satisfies DeleteNodesPayload };
  },
};
