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
  type UpdateNodePathPayload,
  Mat,
  Rect,
} from '@motion/workspace';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind as kindOf } from '@core/scene/sceneDerive';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP, type SceneKind } from '@core/scene/seedDefaultScene';
import { flattenScene } from '@core/scene/sceneDerive';
import type { SceneNode, ID } from '@core/types';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { readGeometry, localBounds, makeHitTestLocal, isDrawableKind as drawable } from './geometry';
import { usePreferenceStore } from '@stores/preferenceStore';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useProjectStore } from '@stores/projectStore';
import { getRemappedTime, getTimelineController } from '@core/timeline/TimelineController';
import { is3DEnabled } from '@core/scene/threeD';
import { Project3D, Matrix4Math } from '@motion/scene';
import { useGuidesStore } from '@stores/guidesStore';

// ── SceneGraphPort ────────────────────────────────────────────────
function toWorkspaceNode(node: SceneNode, zIndex: number): WorkspaceNode | null {
  const g = readGeometry(node);
  if (!g) return null;

  // Retrieve current active tab settings and active playhead time
  const activeTabId = useProjectStore.getState().activeTabId;
  const activeTab = useProjectStore.getState().tabs[activeTabId ?? ''];
  const rawTime = activeTab?.time ?? 0;
  const compositionId = activeTab?.compositionId ?? 'comp_root';
  const comp = useProjectStore.getState().comps[compositionId];
  const width = comp?.width ?? 1920;
  const height = comp?.height ?? 1080;
  const cameraMode = useGuidesStore.getState().camera3dMode;

  // Evaluate the node's properties at the current playhead time
  const localTime = getRemappedTime(node.id, rawTime);
  const av = defaultAnimation.evaluateNode(node.id, localTime);

  const x = av.get('x') ?? g.x;
  const y = av.get('y') ?? g.y;
  const scaleX = av.get('scaleX') ?? av.get('scale') ?? g.scaleX;
  const scaleY = av.get('scaleY') ?? av.get('scale') ?? g.scaleY;
  const rotationDeg = av.get('rotation') ?? g.rotationDeg;

  // Find the first camera layer to compute 3D camera projection
  let cameraNode: SceneNode | undefined;
  for (const n of flattenScene(defaultSceneGraph)) {
    if (readNodeKind(n) === 'camera') {
      cameraNode = n;
      break;
    }
  }

  let camera: import('@motion/scene').Project3D.Camera3D;
  if (cameraMode === 'front') {
    camera = Project3D.defaultCamera(width, height);
  } else if (cameraNode) {
    const camTime = getRemappedTime(cameraNode.id, rawTime);
    const camValues = defaultAnimation.evaluateNode(cameraNode.id, camTime);
    const def = Project3D.defaultCamera(width, height);
    let cx: number | undefined, cy: number | undefined, cz: number | undefined, cfocal: number | undefined;
    for (const c of cameraNode.components) {
      if (c.type === 'Transform') {
        const p = c.props as Record<string, unknown>;
        if (typeof p.x === 'number') cx = p.x;
        if (typeof p.y === 'number') cy = p.y;
        if (typeof p.z === 'number') cz = p.z;
        if (typeof p.focalLength === 'number') cfocal = p.focalLength;
      }
    }
    cx = camValues.get('x') ?? cx;
    cy = camValues.get('y') ?? cy;
    cz = camValues.get('z') ?? cz;
    cfocal = camValues.get('focalLength') ?? cfocal;
    const focalLength = cfocal ?? def.focalLength;
    camera = {
      focalLength,
      position: { x: cx ?? def.position.x, y: cy ?? def.position.y, z: cz ?? -focalLength },
    };
  } else {
    camera = Project3D.defaultCamera(width, height);
  }

  // Calculate the world matrix based on whether 3D is active
  const is3D = is3DEnabled(node);
  const kind = readNodeKind(node);
  let worldMatrixVal: import('@motion/workspace').Mat2D;

  if (is3D && kind !== 'camera' && kind !== 'light') {
    const z3 = av.get('z') ?? 0;
    const rotX = av.get('rotationX') ?? 0;
    const rotY = av.get('rotationY') ?? 0;

    const DEG = Math.PI / 180;
    const M = Matrix4Math.compose({
      position: { x, y, z: z3 },
      rotation: { x: rotX * DEG, y: rotY * DEG, z: rotationDeg * DEG },
      scale: { x: scaleX, y: scaleY, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });

    const O = Project3D.projectPoint(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }), camera);
    const X = Project3D.projectPoint(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }), camera);
    const Y = Project3D.projectPoint(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }), camera);

    const ax = X.x - O.x;
    const ay = X.y - O.y;
    const cx_coeff = Y.x - O.x;
    const cy_coeff = Y.y - O.y;

    worldMatrixVal = { a: ax, b: ay, c: cx_coeff, d: cy_coeff, e: O.x, f: O.y };
  } else {
    const tr = Mat.multiply(Mat.translation(x, y), Mat.rotation((rotationDeg * Math.PI) / 180));
    worldMatrixVal = Mat.multiply(tr, Mat.scaling(scaleX, scaleY));
  }

  const localBoundsVal = localBounds(g);
  const worldBoundsVal = Rect.transform(localBoundsVal, worldMatrixVal);
  const hitTestLocalVal = makeHitTestLocal(g);

  let visibleVal = node.visible !== false;
  const controller = getTimelineController();
  const nodeClips = controller.getLayersForNode(node.id);
  if (nodeClips.length > 0) {
    const fps = comp?.fps ?? 60;
    const lastFrame = Math.max(0, Math.round((comp?.durationSeconds ?? 10) * fps) - 1);
    const gateFrame = Math.min(Math.round(rawTime * fps), lastFrame);
    if (!nodeClips.some((l: any) => l.isActiveAt(gateFrame))) {
      visibleVal = false;
    }
  }

  return {
    id: node.id as string,
    parentId: (node.parent as string | null) ?? null,
    worldBounds: worldBoundsVal,
    worldMatrix: worldMatrixVal,
    localBounds: localBoundsVal,
    visible: visibleVal,
    locked: !!node.locked,
    zIndex,
    hitTestLocal: hitTestLocalVal,
    pathPoints: node.components.find((c) => c.type === 'Geometry')?.props.points as import('@motion/workspace').BezierPoint[] | undefined,
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
      const unsubScene = useSceneRevision.subscribe(listener);
      let lastTime: number | undefined;
      const unsubTime = useProjectStore.subscribe((s) => {
        const activeTab = s.tabs[s.activeTabId ?? ''];
        const t = activeTab?.time;
        if (t !== lastTime) {
          lastTime = t;
          listener();
        }
      });
      return () => {
        unsubScene();
        unsubTime();
      };
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
  Polygon: 'shape',
  Star: 'shape',
  Line: 'shape',
  Pencil: 'shape',
  Text: 'text',
  Image: 'image',
  Video: 'video',
};

/** Kinds that are open strokes (no enclosed area) → render with a stroke, no fill. */
const STROKED_KINDS = new Set(['Line', 'Pencil', 'Path']);

let createSeq = 0;

function makeNodeAt(
  kind: SceneKind,
  name: string,
  cx: number,
  cy: number,
  ellipse: boolean,
  points?: import('@motion/workspace').BezierPoint[],
  width?: number,
  height?: number,
): SceneNode {
  const id = `${kind}_${(createSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const displayName = ellipse ? 'Circle' : name;
  const transform = { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } };
  // Open strokes (line / pencil) enclose no area, so a fill is invisible —
  // give them a visible stroke and a transparent fill instead.
  const stroked = STROKED_KINDS.has(name);
  const styleProps = stroked
    ? { opacity: 100, fill: 'rgba(0,0,0,0)', stroke: { color: '#2b7eff', width: 4, opacity: 1, cap: 'round', join: 'round', align: 'center', dash: [] } }
    : { opacity: 100, fill: '#2b7eff' };

  const transformProps: Record<string, unknown> = {
    [SCENE_KIND_PROP]: kind,
    x: cx,
    y: cy,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchorX: 0,
    anchorY: 0,
  };
  
  if (width !== undefined) transformProps.width = width;
  if (height !== undefined) transformProps.height = height;
  if (ellipse) transformProps.shapeType = 'ellipse';
  else if (name === 'Rectangle') transformProps.shapeType = 'rect';
  else if (kind === 'shape') transformProps.shapeType = 'path';

  const components: SceneNode['components'] = [];
  if (kind === 'text') {
    components.push(
      { id: `${id}_t`, type: 'Transform', props: transformProps },
      { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: 32, opacity: 100 } },
    );
  } else {
    components.push(
      { id: `${id}_t`, type: 'Transform', props: transformProps },
      { id: `${id}_s`, type: 'Style', props: { opacity: styleProps.opacity, fill: styleProps.fill } },
    );
    if ('stroke' in styleProps) {
      components.push({ id: `${id}_fx`, type: 'fx', props: { stroke: (styleProps as any).stroke } });
    }
  }

  if (kind === 'shape' && points) {
    // Open strokes (line / pencil) must render as an un-closed polyline; mark
    // the geometry so the renderer doesn't wrap the last point back to the first.
    const openProps = stroked ? { open: true } : {};
    components.push({ id: `${id}_g`, type: 'Geometry', props: { points, ...openProps } });
  }

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
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  let changed = false;
  
  if (autoKeyframe) {
    runAnimEdit('Auto-Keyframe Position', () => {
      for (const id of payload.ids) {
        const node = defaultSceneGraph.getNode(id as ID);
        if (!node || node.locked) continue;
        const g = readGeometry(node);
        if (!g) continue;
        const time = getRemappedTime(id, rawTime);
        defaultAnimation.setKeyframe(id, 'x', getTimelineController().toLayerTime(id, time), g.x + payload.delta.x);
        defaultAnimation.setKeyframe(id, 'y', getTimelineController().toLayerTime(id, time), g.y + payload.delta.y);
      }
    });
    return;
  }

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
  // Ellipse is true only for explicit Ellipse kind
  const ellipse = payload.kind === 'Ellipse';
  
  const width = payload.bounds.width;
  const height = payload.bounds.height;
  const node = makeNodeAt(kind, payload.kind, cx, cy, ellipse, payload.points, width, height);
  
  if (payload.maskTargetId) {
    const parentId = payload.maskTargetId as string;
    // Remove stroke fx if present, and force white solid fill
    node.components = node.components.filter((c) => c.type !== 'fx');
    const sComp = node.components.find((c) => c.type === 'Style');
    if (sComp && sComp.props) {
      sComp.props.fill = '#ffffff';
    }
    // Add Mask component so it's recognized as a mask instead of a normal shape
    node.components.push({ id: `${node.id}_mask`, type: 'mask', props: { mode: 'alpha', inverted: false, feather: 0 } });
    node.name = 'Mask';
    defaultSceneGraph.addChild(parentId, node);
  } else {
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? ('comp_root' as ID);
    defaultSceneGraph.addChild(rootId, node);
  }
  
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
  
  let baseW = (SIZE as Record<string, { w: number; h: number }>)[kind]?.w ?? 100;
  let baseH = (SIZE as Record<string, { w: number; h: number }>)[kind]?.h ?? 100;
  const transComp = node.components.find((c) => c.type === 'Transform');
  if (transComp && transComp.props) {
    if (typeof transComp.props.width === 'number') baseW = transComp.props.width;
    if (typeof transComp.props.height === 'number') baseH = transComp.props.height;
  }
  const b = payload.bounds;
  const scaleX = baseW > 0 ? b.width / baseW : 1;
  const scaleY = baseH > 0 ? b.height / baseH : 1;
  
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const time = getRemappedTime(node.id, rawTime);
  
  if (autoKeyframe) {
    runAnimEdit('Auto-Keyframe Resize', () => {
      defaultAnimation.setKeyframe(node.id, 'x', getTimelineController().toLayerTime(node.id, time), b.x + b.width / 2);
      defaultAnimation.setKeyframe(node.id, 'y', getTimelineController().toLayerTime(node.id, time), b.y + b.height / 2);
      defaultAnimation.setKeyframe(node.id, 'scaleX', getTimelineController().toLayerTime(node.id, time), scaleX);
      defaultAnimation.setKeyframe(node.id, 'scaleY', getTimelineController().toLayerTime(node.id, time), scaleY);
    });
    return;
  }

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

  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const time = getRemappedTime(node.id, rawTime);
  
  if (autoKeyframe) {
    runAnimEdit('Auto-Keyframe Rotate', () => {
      defaultAnimation.setKeyframe(node.id, 'rotation', getTimelineController().toLayerTime(node.id, time), (payload.rotation * 180) / Math.PI);
    });
    return;
  }

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

function updateNodePath(payload: UpdateNodePathPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const geomComponent = node.components.find((c) => c.type === 'Geometry');
  if (geomComponent) {
    defaultSceneGraph.writeProp(node.id, geomComponent.id, 'points', payload.points);
    bumpScene();
  }
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
        case WorkspaceCommandType.UpdateNodePath:
          updateNodePath(command.payload as UpdateNodePathPayload);
          break;
        default:
          break;
      }
    },
  };
}

export { drawable as isDrawableKind, readNodeKind };
