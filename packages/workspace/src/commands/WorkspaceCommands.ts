/**
 * WorkspaceCommands — the vocabulary of intents the workspace submits to the
 * app's Command System. The workspace never mutates the Scene Graph itself; it
 * describes *what the user did* and lets the host apply it undoably. These
 * builders keep payload shapes consistent between tools and the binding layer.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { NodeId, WorkspaceCommand } from '../ports';
import type { BezierPoint } from '../math/BezierPoint';

export const WorkspaceCommandType = {
  MoveNodes: 'workspace.moveNodes',
  ResizeNode: 'workspace.resizeNode',
  RotateNode: 'workspace.rotateNode',
  MoveAnchor: 'workspace.moveAnchor',
  CreateNode: 'workspace.createNode',
  DeleteNodes: 'workspace.deleteNodes',
  UpdateNodePath: 'workspace.updateNodePath',
  UpdateMaskPath: 'workspace.updateMaskPath',
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

export interface MoveAnchorPayload {
  id: NodeId;
  /** New pivot in the node's LOCAL space (0,0 = centre). */
  anchor: Vec2;
}

export interface CreateNodePayload {
  /** Node kind hint for the binding (e.g. "Rectangle", "Ellipse", "Text"). */
  kind: string;
  /** Initial world-space bounds. */
  bounds: Rect;
  /** Optional bezier path points in LOCAL space (pen tool). */
  points?: BezierPoint[];
  /** Optional ID of the node to mask (if drawing a mask). */
  maskTargetId?: NodeId;
}

export interface DeleteNodesPayload {
  ids: readonly NodeId[];
}

export interface UpdateNodePathPayload {
  id: NodeId;
  points: BezierPoint[];
}

/** Reshape one of a layer's masks. `id` is the layer; `maskId` the outline. */
export interface UpdateMaskPathPayload {
  id: NodeId;
  maskId: string;
  points: BezierPoint[];
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
  /** Pan-behind: re-pivot the node, compensating position so it stays put. */
  moveAnchor(id: NodeId, anchor: Vec2): WorkspaceCommand {
    return { type: WorkspaceCommandType.MoveAnchor, payload: { id, anchor } satisfies MoveAnchorPayload };
  },
  createNode(kind: string, bounds: Rect, points?: BezierPoint[], maskTargetId?: NodeId): WorkspaceCommand {
    const payload: CreateNodePayload = points ? { kind, bounds, points, maskTargetId } : { kind, bounds, maskTargetId };
    return { type: WorkspaceCommandType.CreateNode, payload };
  },
  deleteNodes(ids: readonly NodeId[]): WorkspaceCommand {
    return { type: WorkspaceCommandType.DeleteNodes, payload: { ids } satisfies DeleteNodesPayload };
  },
  updateNodePath(id: NodeId, points: BezierPoint[]): WorkspaceCommand {
    return { type: WorkspaceCommandType.UpdateNodePath, payload: { id, points } satisfies UpdateNodePathPayload };
  },
  updateMaskPath(id: NodeId, maskId: string, points: BezierPoint[]): WorkspaceCommand {
    return {
      type: WorkspaceCommandType.UpdateMaskPath,
      payload: { id, maskId, points } satisfies UpdateMaskPathPayload,
    };
  },
};
