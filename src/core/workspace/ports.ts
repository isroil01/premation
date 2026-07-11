/**
 * Port implementations that bind the framework-independent `@motion/workspace`
 * engine to this app's real systems:
 *   • SceneGraphPort  → defaultSceneGraph (@motion/scene)
 *   • SelectionPort   → selectionStore (Zustand, the app's selection truth)
 *   • CommandPort     → scene-graph mutations + bumpScene (undo comes later)
 *
 * The engine reads/drives through these; it never imports the stores directly.
 */

import type {
  SceneGraphPort,
  SelectionPort,
  CommandPort,
  WorkspaceNode,
  WorkspaceCommand,
  NodeId,
} from '@motion/workspace';
import {
  WorkspaceCommandType,
  type MoveNodesPayload,
  type CreateNodePayload,
  type DeleteNodesPayload,
  type ResizeNodePayload,
  type RotateNodePayload,
} from '@motion/workspace';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind as kindOf } from '@core/scene/sceneDerive';
import { isDrawableKind as drawable } from './geometry';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP, type SceneKind } from '@core/scene/seedDefaultScene';
import { flattenScene } from '@core/scene/sceneDerive';
import type { SceneNode, ID } from '@core/types';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { readGeometry, worldBounds, worldMatrix, localBounds, makeHitTestLocal, isDrawableKind } from './geometry';

// ── SceneGraphPort ────────────────────────────────────────────────
function toWorkspaceNode(node: SceneNode, zIndex: number): WorkspaceNode | null {
  const g = readGeometry(node);
  if (!g) return null;
  return {
    id: node.id as string,
    parentId: (node.parent as string | null) ?? null,
    worldBounds: worldBounds(g),
    worldMatrix: worldMatrix(g),
    localBounds: localBounds(g),
    visible: node.visible !== false,
    locked: !!node.locked,
    zIndex,
    hitTestLocal: makeHitTestLocal(g),
  };
}

export function createSceneGraphPort(): SceneGraphPort {
  return {
    getNodes(): Iterable<WorkspaceNode> {
      const out: WorkspaceNode[] = [];
      const flat = flattenScene(defaultSceneGraph);
      flat.forEach((node, i) => {
        const wn = toWorkspaceNode(node, i);
        if (wn) out.push(wn);
      });
      return out;
    },
    getNode(id: NodeId): WorkspaceNode | undefined {
      const node = defaultSceneGraph.getNode(id as ID);
      if (!node) return undefined;
      // z-index from document order (cheap; the flattened list is small).
      const flat = flattenScene(defaultSceneGraph);
      const idx = flat.findIndex((n) => (n.id as string) === id);
      return toWorkspaceNode(node, idx < 0 ? 0 : idx) ?? undefined;
    },
    onChanged(listener: () => void): () => void {
      // Any graph mutation bumps the scene revision store.
      return useSceneRevision.subscribe(listener);
    },
  };
}

// ── SelectionPort ─────────────────────────────────────────────────
export function createSelectionPort(): SelectionPort {
  const store = useSelectionStore;
  return {
    get: () => store.getState().ids,
    has: (id) => store.getState().isSelected(id),
    set: (ids) => store.getState().set([...ids]),
    add: (id) => store.getState().add(id),
    remove: (id) => store.getState().remove(id),
    toggle: (id) => store.getState().toggle(id),
    clear: () => store.getState().clear(),
    onChanged: (listener) => {
      const sub = getEventBus().on('SelectionChanged', (p: { ids: readonly string[] }) => listener(p.ids));
      return () => sub.dispose();
    },
  };
}

// ── CommandPort ───────────────────────────────────────────────────
const KIND_FOR_CREATE: Record<string, SceneKind> = {
  Rectangle: 'shape',
  Ellipse: 'shape',
  Path: 'shape',
  Text: 'text',
  Image: 'image',
  Video: 'video',
};

let createSeq = 0;

function makeNodeAt(kind: SceneKind, name: string, cx: number, cy: number, ellipse: boolean): SceneNode {
  const id = `${kind}_${(createSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const displayName = ellipse ? 'Circle' : name;
  const transform = { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } };
  const components: SceneNode['components'] =
    kind === 'text'
      ? [
          { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: cx, y: cy, rotation: 0 } },
          { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: 32, opacity: 100 } },
        ]
      : [
          { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: cx, y: cy, rotation: 0 } },
          { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
        ];
  return { id, name: displayName, parent: null, children: [], transform, visible: true, locked: false, components };
}

/** Find the id of the component that carries this node's x/y (the transform). */
function transformComponentId(node: SceneNode): ID | null {
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number' || typeof p.y === 'number') return c.id;
  }
  return null;
}

function moveNodes(payload: MoveNodesPayload): void {
  let changed = false;
  for (const id of payload.ids) {
    const node = defaultSceneGraph.getNode(id as ID);
    if (!node || node.locked) continue;
    const cid = transformComponentId(node);
    if (!cid) continue;
    const g = readGeometry(node);
    if (!g) continue;
    defaultSceneGraph.writeProp(node.id, cid, 'x', g.x + payload.delta.x);
    defaultSceneGraph.writeProp(node.id, cid, 'y', g.y + payload.delta.y);
    changed = true;
  }
  if (changed) bumpScene();
}

function createNode(payload: CreateNodePayload): void {
  const kind = KIND_FOR_CREATE[payload.kind] ?? 'shape';
  const cx = payload.bounds.x + payload.bounds.width / 2;
  const cy = payload.bounds.y + payload.bounds.height / 2;
  // Square-ish drag on a shape → name it "Circle" so it renders as an ellipse.
  const ellipse =
    payload.kind === 'Ellipse' ||
    (kind === 'shape' && Math.abs(payload.bounds.width - payload.bounds.height) < 8 && payload.bounds.width > 0);
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? ('comp_root' as ID);
  const node = makeNodeAt(kind, payload.kind, cx, cy, ellipse);
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

function resizeNode(payload: ResizeNodePayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const cid = transformComponentId(node);
  if (!cid) return;
  const kind = kindOf(node);
  if (!drawable(kind)) return;
  const base = SIZE[kind];
  const b = payload.bounds;
  const scaleX = base.w > 0 ? b.width / base.w : 1;
  const scaleY = base.h > 0 ? b.height / base.h : 1;
  defaultSceneGraph.writeProp(node.id, cid, 'x', b.x + b.width / 2);
  defaultSceneGraph.writeProp(node.id, cid, 'y', b.y + b.height / 2);
  defaultSceneGraph.writeProp(node.id, cid, 'scaleX', scaleX);
  defaultSceneGraph.writeProp(node.id, cid, 'scaleY', scaleY);
  bumpScene();
}

function rotateNode(payload: RotateNodePayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const cid = transformComponentId(node);
  if (!cid) return;
  defaultSceneGraph.writeProp(node.id, cid, 'rotation', (payload.rotation * 180) / Math.PI);
  bumpScene();
}

function deleteNodes(payload: DeleteNodesPayload): void {
  if (payload.ids.length === 0) return;
  for (const id of payload.ids) defaultSceneGraph.removeNode(id as ID);
  const remaining = useSelectionStore.getState().ids.filter((id) => !payload.ids.includes(id));
  useSelectionStore.getState().set(remaining);
  bumpScene();
}

export function createCommandPort(): CommandPort {
  return {
    execute(command: WorkspaceCommand): void {
      switch (command.type) {
        case WorkspaceCommandType.MoveNodes:
          moveNodes(command.payload as MoveNodesPayload);
          break;
        case WorkspaceCommandType.CreateNode:
          createNode(command.payload as CreateNodePayload);
          break;
        case WorkspaceCommandType.ResizeNode:
          resizeNode(command.payload as ResizeNodePayload);
          break;
        case WorkspaceCommandType.RotateNode:
          rotateNode(command.payload as RotateNodePayload);
          break;
        case WorkspaceCommandType.DeleteNodes:
          deleteNodes(command.payload as DeleteNodesPayload);
          break;
        default:
          break;
      }
    },
  };
}

export { isDrawableKind, readNodeKind };
