/**
 * The scene event map. Every structural or state change on the graph emits a
 * typed event so downstream engines (timeline, render, AI…) can react without
 * polling.
 */

import type { NodeId } from '../types';
import type { SceneNode } from '../nodes/SceneNode';

export interface SceneEventMap {
  NodeCreated: { node: SceneNode; parentId: NodeId | null };
  NodeDeleted: { nodeId: NodeId; parentId: NodeId | null };
  NodeMoved: { node: SceneNode; fromParentId: NodeId | null; toParentId: NodeId | null; index: number };
  NodeUpdated: { node: SceneNode; changed: string };
  ParentChanged: { node: SceneNode; fromParentId: NodeId | null; toParentId: NodeId | null };
  SelectionChanged: { selected: ReadonlyArray<NodeId>; previous: ReadonlyArray<NodeId> };
  VisibilityChanged: { node: SceneNode; visible: boolean };
  TransformChanged: { node: SceneNode };
}

export type SceneEventName = keyof SceneEventMap;
