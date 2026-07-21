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
  type MoveAnchorPayload,
  type UpdateNodePathPayload,
  type UpdateMaskPathPayload,
  Mat,
  Rect,
} from '@motion/workspace';
import { readNodeAnchor, moveAnchorCompensated } from '@core/scene/anchor';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind as kindOf } from '@core/scene/sceneDerive';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
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
import { drawToolOptions } from '@motion/workspace';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useProjectStore } from '@stores/projectStore';
import { getRemappedTime, getTimelineController } from '@core/timeline/TimelineController';
import { is3DEnabled } from '@core/scene/threeD';
import { readSceneCamera } from '@core/scene/camera3d';
import { Project3D, Matrix4Math } from '@motion/scene';
import { useGuidesStore } from '@stores/guidesStore';
import { addMaskPath, rectangleMask, ellipseMask, readNodeMask, setMaskPoints, MaskPath, MaskPoint } from '@core/effects/mask';

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
  // The pivot, in local space. The renderer places content at
  // position + R·S·(local − anchor), so the world matrix must carry T(−anchor)
  // or the selection chrome drifts off anchored layers.
  const nodeAnchor = readNodeAnchor(node);
  const anchorX = av.get('anchorX') ?? nodeAnchor.x;
  const anchorY = av.get('anchorY') ?? nodeAnchor.y;

  // Find the first camera layer to compute 3D camera projection
  let cameraNode: SceneNode | undefined;
  for (const n of flattenScene(defaultSceneGraph)) {
    if (readNodeKind(n) === 'camera') {
      cameraNode = n;
      break;
    }
  }

  // The projection MUST match the renderer's (buildSnapshot) exactly, or the
  // selection outline drifts off the layer. Both branch on the same view mode.
  const orthoView: import('@motion/scene').Project3D.OrthoView | null =
    cameraMode === 'active' ? null : (cameraMode as import('@motion/scene').Project3D.OrthoView);
  let project: (p: { x: number; y: number; z: number }) => import('@motion/scene').Project3D.Projected;
  if (orthoView) {
    project = (p) => Project3D.projectOrtho(p, orthoView, width, height);
  } else {
    let camera: import('@motion/scene').Project3D.Camera3D;
    if (!cameraNode) {
      camera = Project3D.defaultCamera(width, height);
    } else {
      // Same resolver the renderer uses (position, focal AND orbit) — a private
      // rebuild here ignored orbitYaw/orbitPitch, so under an orbited camera the
      // selection outlines drifted off the rendered layers.
      const camTime = getRemappedTime(cameraNode.id, rawTime);
      const camValues = defaultAnimation.evaluateNode(cameraNode.id, camTime);
      camera = readSceneCamera(defaultSceneGraph, width, height, (id, p) =>
        id === cameraNode!.id ? camValues.get(p) : undefined,
      );
    }
    project = (p) => Project3D.projectPoint(p, camera);
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
      anchor: { x: anchorX, y: anchorY, z: 0 },
    });

    const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
    const X = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
    const Y = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));

    const ax = X.x - O.x;
    const ay = X.y - O.y;
    const cx_coeff = Y.x - O.x;
    const cy_coeff = Y.y - O.y;

    worldMatrixVal = { a: ax, b: ay, c: cx_coeff, d: cy_coeff, e: O.x, f: O.y };
  } else {
    const tr = Mat.multiply(Mat.translation(x, y), Mat.rotation((rotationDeg * Math.PI) / 180));
    const rs = Mat.multiply(tr, Mat.scaling(scaleX, scaleY));
    worldMatrixVal = Mat.multiply(rs, Mat.translation(-anchorX, -anchorY));
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
    // Masks are editable outlines too — without these the Direct Selection tool
    // can't see them, which is why a mask's shape was frozen once drawn.
    maskPaths: readNodeMask(node)?.paths.map((p) => ({ id: p.id, points: p.points })),
    anchor: { x: anchorX, y: anchorY },
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
  Brush: 'shape',
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
  // give them a visible stroke and a transparent fill instead. Colours/widths
  // come from the tool-options bar (drawToolOptions singleton).
  const stroked = STROKED_KINDS.has(name);
  const styleProps = stroked
    ? {
        opacity: 100,
        fill: 'rgba(0,0,0,0)',
        stroke: {
          color: drawToolOptions.pencilColor,
          width: drawToolOptions.pencilWidth,
          opacity: 1,
          cap: 'round',
          join: 'round',
          align: 'center',
          dash: [],
        },
      }
    : { opacity: 100, fill: name === 'Brush' ? drawToolOptions.brushColor : '#2b7eff' };

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

import { worldMatrixOf } from '@core/scene/worldTransform';
import { Matrix } from '@motion/scene';

function getLocalTransformForPorts(id: string) {
  const node = defaultSceneGraph.getNode(id as ID);
  if (!node) return null;
  const g = readGeometry(node);
  if (!g) return null;
  return { x: g.x, y: g.y, rotation: g.rotationDeg, scaleX: g.scaleX, scaleY: g.scaleY };
}

function getParentIdForPorts(id: string) {
  const node = defaultSceneGraph.getNode(id as ID);
  return node?.parent ?? null;
}

function cidOf(node: SceneNode, prop: string): string {
  const c = node.components.find((comp) => comp.props[prop] !== undefined);
  return c?.id ?? node.components[0]?.id ?? '';
}

/**
 * AE keyframing contract: a property with a lit stopwatch (an existing track)
 * ALWAYS keyframes on direct manipulation — the global Auto-Keyframe mode only
 * decides whether *un-animated* properties start recording. Writing a static
 * value to a tracked property is useless: the renderer reads animated values
 * first (`av.get(...) ?? g.x`), so the write would silently do nothing.
 */
function hasAnyTrack(nodeId: ID, props: readonly string[]): boolean {
  return defaultAnimation.tracksFor(nodeId).some((t) => props.includes(t.prop as string));
}

function moveNodes(payload: MoveNodesPayload): void {
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const toKey: SceneNode[] = [];
  const toWrite: SceneNode[] = [];
  for (const id of payload.ids) {
    const node = defaultSceneGraph.getNode(id as ID);
    if (!node || node.locked) continue;
    if (autoKeyframe || hasAnyTrack(node.id, ['x', 'y'])) toKey.push(node);
    else toWrite.push(node);
  }

  let changed = false;
  if (toKey.length > 0) {
    runAnimEdit(
      'Keyframe Position',
      () => {
        for (const node of toKey) {
          const g = readGeometry(node);
          if (!g) continue;
          let delta = payload.delta;
          if (node.parent) {
            const pw = worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts);
            const inv = Matrix.invert(pw);
            delta = {
              x: inv.a * payload.delta.x + inv.c * payload.delta.y,
              y: inv.b * payload.delta.x + inv.d * payload.delta.y,
            };
          }
          const lt = getRemappedTime(node.id, rawTime);
          const curX = defaultAnimation.sample(node.id, 'x', lt) ?? g.x;
          const curY = defaultAnimation.sample(node.id, 'y', lt) ?? g.y;
          defaultAnimation.setKeyframe(node.id, 'x', lt, curX + delta.x);
          defaultAnimation.setKeyframe(node.id, 'y', lt, curY + delta.y);
          const cx = cidOf(node, 'x');
          const cy = cidOf(node, 'y');
          defaultSceneGraph.writeProp(node.id, cx, 'x', curX + delta.x);
          defaultSceneGraph.writeProp(node.id, cy, 'y', curY + delta.y);
          changed = true;
        }
      },
      `drag:move:${rawTime}:${toKey.map((n) => n.id).join(',')}`,
    );
  }

  for (const node of toWrite) {
    const g = readGeometry(node);
    if (!g) continue;
    let delta = payload.delta;
    if (node.parent) {
      const pw = worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts);
      const inv = Matrix.invert(pw);
      delta = {
        x: inv.a * payload.delta.x + inv.c * payload.delta.y,
        y: inv.b * payload.delta.x + inv.d * payload.delta.y,
      };
    }
    const cidX = cidOf(node, 'x');
    const cidY = cidOf(node, 'y');
    defaultSceneGraph.writeProp(node.id, cidX, 'x', g.x + delta.x);
    defaultSceneGraph.writeProp(node.id, cidY, 'y', g.y + delta.y);
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
  
  if (payload.maskTargetId) {
    const parentId = payload.maskTargetId as string;
    const parentNode = defaultSceneGraph.getNode(parentId as ID);
    if (!parentNode) return;

    const parentWorldMat = worldMatrixOf(parentId, getLocalTransformForPorts, getParentIdForPorts);
    const invParentWorldMat = Matrix.invert(parentWorldMat);

    let newMask: MaskPath;
    if (payload.points && payload.points.length > 0) {
      const points: MaskPoint[] = payload.points.map((p: any) => {
        // Convert drawn point (relative to bounds center) to world space
        const wp = { x: p.x + cx, y: p.y + cy };
        const win = { x: p.inX + cx, y: p.inY + cy };
        const wout = { x: p.outX + cx, y: p.outY + cy };
        // Transform to parent's local space
        const lp = Matrix.transformPoint(invParentWorldMat, wp);
        const lin = Matrix.transformPoint(invParentWorldMat, win);
        const lout = Matrix.transformPoint(invParentWorldMat, wout);
        return { x: lp.x, y: lp.y, inX: lin.x, inY: lin.y, outX: lout.x, outY: lout.y };
      });
      newMask = {
        id: `mask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        mode: 'add',
        closed: true,
        feather: 0,
        opacity: 1,
        expansion: 0,
        inverted: false,
        points,
      };
    } else {
      // Fallback if points were missing, though workspace tools should provide them.
      newMask = ellipse ? ellipseMask(width, height) : rectangleMask(width, height);
    }
    
    addMaskPath(parentId, newMask);
    useSelectionStore.getState().set([parentId]);
    bumpScene();
    return;
  }

  const node = makeNodeAt(kind, payload.kind, cx, cy, ellipse, payload.points, width, height);
  const rootId = activeCompRootId() as ID;
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
  // Layer-local sampling time — see moveNodes for why toLayerTime must NOT be
  // applied on top (it double-subtracts the clip start).
  const lt = getRemappedTime(node.id, rawTime);

  // Per-property stopwatch contract (see hasAnyTrack): position and scale
  // decide independently, so scaling an animated-scale layer keyframes scale
  // while its un-animated position stays a static write.
  const keyPos = autoKeyframe || hasAnyTrack(node.id, ['x', 'y']);
  const keyScale = autoKeyframe || hasAnyTrack(node.id, ['scaleX', 'scaleY', 'scale']);

  if (keyPos || keyScale) {
    runAnimEdit(
      'Keyframe Resize',
      () => {
        if (keyPos) {
          defaultAnimation.setKeyframe(node.id, 'x', lt, b.x + b.width / 2);
          defaultAnimation.setKeyframe(node.id, 'y', lt, b.y + b.height / 2);
        }
        if (keyScale) {
          defaultAnimation.setKeyframe(node.id, 'scaleX', lt, scaleX);
          defaultAnimation.setKeyframe(node.id, 'scaleY', lt, scaleY);
        }
      },
      `drag:resize:${rawTime}:${node.id}`,
    );
  }

  // Static base always follows the manipulation (harmless when animated —
  // animated reads win — and it keeps every consumer in agreement).
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
  const deg = (payload.rotation * 180) / Math.PI;

  if (autoKeyframe || hasAnyTrack(node.id, ['rotation'])) {
    runAnimEdit(
      'Keyframe Rotate',
      () => {
        // Layer-local time — no toLayerTime on top (see moveNodes).
        defaultAnimation.setKeyframe(node.id, 'rotation', getRemappedTime(node.id, rawTime), deg);
      },
      `drag:rotate:${rawTime}:${node.id}`,
    );
  }

  defaultSceneGraph.writeProp(node.id, cid, 'rotation', deg);
  bumpScene();
}

function moveAnchor(payload: MoveAnchorPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  // moveAnchorCompensated re-pivots and shifts x/y so the layer stays put.
  moveAnchorCompensated(node.id, payload.anchor.x, payload.anchor.y);
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

/**
 * Reshape one of a layer's masks (the Direct Selection drag on canvas).
 *
 * Routes through `setMaskPoints` with the playhead, so reshaping an ANIMATED
 * mask writes a keyframe at the current time instead of the static shape that
 * nothing renders.
 */
function updateMaskPathCmd(payload: UpdateMaskPathPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  // Comp time — the same base `keyframeMask` uses from the Effects panel, so
  // canvas edits and the panel's keyframe button land on the same keyframes.
  setMaskPoints(payload.id as string, payload.maskId, payload.points as MaskPoint[], getTimelineController().currentSeconds);
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
        case WorkspaceCommandType.MoveAnchor:
          moveAnchor(command.payload as MoveAnchorPayload);
          break;
        case WorkspaceCommandType.DeleteNodes:
          deleteNodes(command.payload as DeleteNodesPayload);
          break;
        case WorkspaceCommandType.UpdateNodePath:
          updateNodePath(command.payload as UpdateNodePathPayload);
          break;
        case WorkspaceCommandType.UpdateMaskPath:
          updateMaskPathCmd(command.payload as UpdateMaskPathPayload);
          break;
        default:
          break;
      }
    },
  };
}

export { drawable as isDrawableKind, readNodeKind };
