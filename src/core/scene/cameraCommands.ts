/**
 * Layer ▸ Camera and View ▸ Look At — the After Effects camera-rig verbs.
 *
 * Every piece these commands need already shipped: two-node cameras with a
 * Point of Interest, parent-lifted camera resolution, focus distance as a
 * keyframeable prop, expressions with `toWorld`/`length`, custom views with a
 * stored orbit. What was missing was the VERBS that AE puts one menu away —
 * Create Orbit Null, Set / Link Focus Distance, Look at Selected Layers — so a
 * rack focus meant reading a depth off the gizmo and typing it, and framing a
 * custom view on a subject meant dragging until it looked right.
 *
 * ## Focus distance is measured the way the renderer measures it
 *
 * `buildSnapshot` defocuses a layer by `dofBlurPx(depth, dof)` where `depth`
 * is `Project3D.projectPoint(world, camera).depth` — the layer's position
 * along the camera's OPTICAL AXIS, not its straight-line distance from the
 * eye. "Set Focus Distance to Layer" therefore writes that same axial depth,
 * so the focal plane lands ON the layer; a Euclidean distance would put it
 * behind the layer by `d·(1 − cos θ)` for any subject off the centre line.
 *
 * The LINK expressions use `length(...)` — the straight-line form — because an
 * expression cannot see the camera's axis, and because that is the expression
 * After Effects itself writes for the same command. The two agree exactly for
 * a subject on the optical axis, which is where a subject being focused on
 * usually is, and the linked form has the property the one-shot lacks: it
 * tracks as either layer moves.
 *
 * ## Create Orbit Null keeps the camera two-node
 *
 * AE converts the camera to one-node when it makes an orbit null. Here the
 * camera stays as it was, and the null goes AT the point of interest (or, for
 * a one-node camera, at the focus distance along the axis): rotating the null
 * swings the eye about the subject while the POI — lifted through the same
 * parent chain — stays pinned under it, so the camera keeps looking at what it
 * was looking at. That is the behaviour the verb is for, without rewriting the
 * camera's orientation props behind the user's back.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import type { SceneNode } from '@core/types';
import { defaultAnimation } from '@motion/animation';
import { Matrix, Matrix4Math, Project3D, type Camera3D, type Vec3 } from '@motion/scene';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { activeCompRootId, activeCompSize } from '@core/scene/activeComp';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
  viewCameraNode,
  cameraFromNode,
  readCameraFocusDistance,
  readCameraPoi,
  type CameraSample,
} from '@core/scene/camera3d';
import { nodeWorldWithParents3d, toWorldPointAt } from '@core/scene/liveWorld3d';
import { canBe3D, is3DEnabled, readNode3D } from '@core/scene/threeD';
import { readNodeAnchor } from '@core/scene/anchor';
import { world2DAt } from '@core/scene/layerSpace';
import { enclosingCompRootOf, reparentNode } from '@core/scene/parenting';
import { readGeometry } from '@core/workspace/geometry';
import type { Command as EngineCommand } from '@motion/engine-api';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { engine } from '@core/engine/engineInstance';
import { propRefForTrack } from '@core/engine/propRefs';
import { trackValueCommands } from '@core/workspace/toolEdits';
import { usePreferenceStore } from '@stores/preferenceStore';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { isCustomViewId, resolveCustomView, type CustomViewId } from '@core/workspace/customViews';
import { runAnimEdit } from '@core/animation/animationCommands';
import { rebaseTransformProps } from '@core/scene/transformWrite';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { useGuidesStore } from '@stores/guidesStore';
import { bumpScene } from '@stores/sceneStore';

// ── Shared readers ──────────────────────────────────────────────────────────

function playhead(): number {
  const project = useProjectStore.getState();
  return (project.activeTabId ? project.tabs[project.activeTabId]?.time : 0) ?? 0;
}

/** Animated values at `time`, layer-time remapped — the renderer's sampler. */
function sampleAt(time: number): CameraSample {
  return (id, prop) => defaultAnimation.evaluateNode(id, getRemappedTime(id, time)).get(prop);
}

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 4000 });
}

function isDevice(node: SceneNode): boolean {
  const k = readNodeKind(node);
  return k === 'camera' || k === 'light';
}

/**
 * The camera a command acts on: a SELECTED camera first, else the comp's
 * active camera. Selecting a camera is how you say "this one" when a comp has
 * several; with none selected the one you are looking through is the answer.
 */
export function commandCamera(): SceneNode | null {
  for (const id of useSelectionStore.getState().ids) {
    const n = defaultSceneGraph.getNode(id);
    if (n && readNodeKind(n) === 'camera') return n;
  }
  // Through the view, so in a `camera:<id>` view "the one you are looking
  // through" is that camera and not the topmost one behind it.
  return viewCameraNode(defaultSceneGraph, useGuidesStore.getState().camera3dMode, activeCompRootId());
}

/** The selected layers that are neither cameras nor lights. */
export function subjectLayers(): SceneNode[] {
  const out: SceneNode[] = [];
  for (const id of useSelectionStore.getState().ids) {
    const n = defaultSceneGraph.getNode(id);
    if (n && !isDevice(n)) out.push(n);
  }
  return out;
}

/** The camera resolved exactly as the renderer resolves it — parents, orbit, POI. */
export function resolveCommandCamera(cam: SceneNode, time: number): Camera3D {
  const { width, height } = activeCompSize();
  return cameraFromNode(cam, width, height, sampleAt(time), (id, p) => toWorldPointAt(id, time, p));
}

/**
 * A layer's world position at `time`: the point its Position places (the
 * anchor), parent chain included. A 2D layer sits on the comp plane at z = 0,
 * which is what `buildSnapshot` and `layerSpaceAt` both say about it.
 */
export function layerWorldPosition(node: SceneNode, time: number): Vec3 {
  if (is3DEnabled(node)) {
    const m = nodeWorldWithParents3d(node, time);
    if (m) {
      const a = readNodeAnchor(node);
      return Matrix4Math.transformPoint(m, { x: a.x, y: a.y, z: readNode3D(node).anchorZ });
    }
  }
  const w = world2DAt(node.id, time);
  const a = readNodeAnchor(node);
  const p = Matrix.transformPoint(w, { x: a.x, y: a.y });
  return { x: p.x, y: p.y, z: 0 };
}

// ── Focus distance ──────────────────────────────────────────────────────────

/**
 * The focus distance that puts the focal plane on `target`: its depth along
 * the camera axis, the number `dofBlurPx` compares against. Null when the
 * layer is behind the camera — there is no focus distance that reaches it.
 */
export function focusDepthToLayer(cam: SceneNode, target: SceneNode, time: number): number | null {
  const camera = resolveCommandCamera(cam, time);
  const o = Project3D.projectPoint(layerWorldPosition(target, time), camera);
  return o.clipped ? null : o.depth;
}

/**
 * Set the focus distance through the engine (one entry): a key at `time` when
 * Focus Distance is animated or Auto-Keyframe is on, else the static value — a
 * rack focus is two of these at two times. Also drops any Link expression,
 * which would otherwise override the value just written and make the command
 * look like it did nothing. Resolves to the depth, or null when the layer is
 * behind the camera (or the engine refused — toasted).
 */
export async function setFocusDistanceToLayer(camId: string, targetId: string, time: number): Promise<number | null> {
  const cam = defaultSceneGraph.getNode(camId);
  const target = defaultSceneGraph.getNode(targetId);
  if (!cam || !target) return null;
  const depth = focusDepthToLayer(cam, target, time);
  if (depth === null) return null;
  const cmds: EngineCommand[] = [];
  const r = propRefForTrack(camId, 'focusDistance');
  if (r && defaultAnimation.getExpressionSrc(camId, 'focusDistance')) {
    cmds.push({ type: 'setExpression', prop: r.ref, source: '', enabled: false });
  }
  const values = trackValueCommands(
    [{ nodeId: camId, values: { focusDistance: Math.round(depth * 100) / 100 } }],
    { seconds: time, autoKeyframe: usePreferenceStore.getState().timelineAutoKeyframe },
  );
  if (!values) return null;
  const res = await edit('Set Focus Distance to Layer', [...cmds, ...values]);
  return res.ok ? depth : null;
}

/** A layer name as an expression string literal. */
function quote(name: string): string {
  return JSON.stringify(name);
}

/** The expression AE writes for Link Focus Distance to Layer. */
export function linkFocusToLayerExpression(targetName: string): string {
  return `length(sub(thisComp.layer(${quote(targetName)}).toWorld([0, 0]), thisLayer.toWorld([0, 0])))`;
}

/**
 * The expression for Link Focus Distance to Point of Interest. Eye and POI
 * are read as the camera's own props (there is no `pointOfInterest` member),
 * both in the camera's parent space — the same space, so their distance is
 * the eye→POI distance whatever the rig above them does, and `orbitYaw` /
 * `orbitPitch` swing the eye ABOUT the POI, so they leave it unchanged too.
 */
export function linkFocusToPoiExpression(cameraName: string): string {
  const n = quote(cameraName);
  return `length(sub([layer(${n}, "poiX"), layer(${n}, "poiY"), layer(${n}, "poiZ")], [layer(${n}, "x"), layer(${n}, "y"), layer(${n}, "z")]))`;
}

export function linkFocusDistanceToLayer(camId: string, targetId: string): boolean {
  const target = defaultSceneGraph.getNode(targetId);
  if (!defaultSceneGraph.getNode(camId) || !target) return false;
  runAnimEdit('Link focus distance to layer', () => {
    defaultAnimation.setExpression(camId, 'focusDistance', linkFocusToLayerExpression(target.name ?? target.id));
  });
  return true;
}

export function isTwoNodeCamera(cam: SceneNode, time = playhead()): boolean {
  const { width, height } = activeCompSize();
  return readCameraPoi(cam, width, height, sampleAt(time)) !== null;
}

export function linkFocusDistanceToPoi(camId: string): boolean {
  const cam = defaultSceneGraph.getNode(camId);
  if (!cam || !isTwoNodeCamera(cam)) return false;
  runAnimEdit('Link focus distance to point of interest', () => {
    defaultAnimation.setExpression(camId, 'focusDistance', linkFocusToPoiExpression(cam.name ?? cam.id));
  });
  return true;
}

// ── Create Orbit Null ───────────────────────────────────────────────────────

let orbitSeq = 0;

/**
 * Where the orbit null goes: the camera's Point of Interest in WORLD space, or
 * — for a one-node camera, which has no POI — the point at the focus distance
 * along the optical axis. The axis is the ray through the principal point,
 * which is exactly how `unprojectScreenRay` defines it, so a rolled or tilted
 * camera gets the axis it actually looks along.
 */
export function orbitPivotFor(cam: SceneNode, time: number): Vec3 {
  const { width, height } = activeCompSize();
  const sample = sampleAt(time);
  const poi = readCameraPoi(cam, width, height, sample);
  if (poi) return toWorldPointAt(cam.id, time, poi);
  const camera = resolveCommandCamera(cam, time);
  const focus = readCameraFocusDistance(cam, width, sample);
  const ray = Project3D.unprojectScreenRay(camera.principal.x, camera.principal.y, camera, null, width, height);
  return {
    x: ray.origin.x + ray.direction.x * focus,
    y: ray.origin.y + ray.direction.y * focus,
    z: ray.origin.z + ray.direction.z * focus,
  };
}

/**
 * Create a 3D null at the camera's pivot, parent the camera to it and re-base
 * the camera's position and POI so nothing moves on screen.
 *
 * The compensation is done here and not by `reparentNode`'s preserve-world
 * path because that path is 2D: it re-bases x/y and leaves `z` where it was,
 * which for a camera pulled back by its focal length is the whole picture.
 * Base props AND keyframe tracks are shifted by the same delta, so an
 * animated camera keeps its move — exact when the camera was unparented or
 * under an unrotated, unscaled parent, which is every rig this verb is
 * reached for. Returns the null's id.
 */
export function createOrbitNull(camId: string, time: number): string | null {
  const cam = defaultSceneGraph.getNode(camId);
  if (!cam || readNodeKind(cam) !== 'camera') return null;
  const trans = cam.components.find((c) => c.type === 'Transform');
  if (!trans) return null;
  const rootId = enclosingCompRootOf(camId) ?? activeCompRootId();
  const { width, height } = activeCompSize();

  const pivot = orbitPivotFor(cam, time);
  const props = trans.props as Record<string, unknown>;
  const num = (k: string, dflt: number): number => (typeof props[k] === 'number' ? (props[k] as number) : dflt);
  const def = Project3D.defaultCamera(width, height);
  const focal = num('focalLength', def.focalLength);
  // The camera's own base position in WORLD space, before the relink.
  const localEye = { x: num('x', def.position.x), y: num('y', def.position.y), z: num('z', -focal) };
  const worldEye = toWorldPointAt(camId, time, localEye);
  const localPoi = readCameraPoi(cam, width, height);
  const worldPoi = localPoi ? toWorldPointAt(camId, time, localPoi) : null;

  const nullId = `null_orbit_${(orbitSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const node: SceneNode = {
    id: nullId,
    name: `${cam.name ?? 'Camera'} Orbit Null`,
    parent: rootId,
    children: [],
    transform: { position: { x: pivot.x, y: pivot.y }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      {
        id: `${nullId}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'null', x: pivot.x, y: pivot.y, z: pivot.z, rotation: 0, rotationX: 0, rotationY: 0 },
      },
    ],
  };
  defaultSceneGraph.addChild(rootId, node);

  // Relink WITHOUT the 2D compensation, then re-base all three axes ourselves.
  if (!reparentNode(camId, nullId, { preserveWorld: false })) {
    defaultSceneGraph.removeNode(nullId);
    return null;
  }
  const newEye = { x: worldEye.x - pivot.x, y: worldEye.y - pivot.y, z: worldEye.z - pivot.z };
  const rebases = [
    { prop: 'x', value: newEye.x, delta: newEye.x - localEye.x },
    { prop: 'y', value: newEye.y, delta: newEye.y - localEye.y },
    { prop: 'z', value: newEye.z, delta: newEye.z - localEye.z },
  ];
  if (localPoi && worldPoi) {
    const newPoi = { x: worldPoi.x - pivot.x, y: worldPoi.y - pivot.y, z: worldPoi.z - pivot.z };
    rebases.push(
      { prop: 'poiX', value: newPoi.x, delta: newPoi.x - localPoi.x },
      { prop: 'poiY', value: newPoi.y, delta: newPoi.y - localPoi.y },
      { prop: 'poiZ', value: newPoi.z, delta: newPoi.z - localPoi.z },
    );
  }
  // Rigid re-base: base props AND every keyframe move into the null's space.
  rebaseTransformProps(camId, rebases, 'Create orbit null');
  useSelectionStore.getState().set([nullId]);
  bumpScene();
  return nullId;
}

// ── Look at ─────────────────────────────────────────────────────────────────

/** Content layers of the active comp — what "all layers" frames. */
export function frameableLayers(): SceneNode[] {
  return flattenComposition(defaultSceneGraph, activeCompRootId()).filter((n) => {
    if (isDevice(n)) return false;
    const k = readNodeKind(n);
    return k !== 'group' && k !== 'comp' && n.visible !== false;
  });
}

/**
 * The orbit that frames `nodes`: POI at their centroid, distance so the sphere
 * enclosing every layer's box fits the narrower field of view with a little
 * air. Pure — the caller decides which view receives it.
 */
export function framingFor(
  nodes: ReadonlyArray<SceneNode>,
  time: number,
  width: number,
  height: number,
): { poi: Vec3; distance: number } | null {
  if (nodes.length === 0) return null;
  const pts = nodes.map((n) => {
    const p = layerWorldPosition(n, time);
    const g = readGeometry(n);
    const r = g ? (Math.hypot(g.width, g.height) / 2) * Math.max(Math.abs(g.scaleX), Math.abs(g.scaleY)) : 0;
    return { p, r };
  });
  const poi = pts.reduce((acc, { p }) => ({ x: acc.x + p.x / pts.length, y: acc.y + p.y / pts.length, z: acc.z + p.z / pts.length }), { x: 0, y: 0, z: 0 });
  let radius = 1;
  for (const { p, r } of pts) radius = Math.max(radius, Math.hypot(p.x - poi.x, p.y - poi.y, p.z - poi.z) + r);
  const focal = Project3D.defaultCamera(width, height).focalLength;
  const fovH = Project3D.fovForFocalLength(width, focal);
  const fovV = Project3D.fovForFocalLength(height, focal);
  const half = (Math.min(fovH, fovV) / 2) * (Math.PI / 180);
  const distance = Math.max(1, (radius / Math.sin(half)) * 1.1);
  return { poi, distance };
}

/**
 * Point the custom view at `nodes`. In After Effects this verb is greyed out
 * in Active Camera and the ortho views — it aims a VIEW, never the shot camera.
 * Here it switches to the last custom view first, which is what the user is
 * about to do anyway. Returns the view it aimed.
 */
export function lookAt(nodes: ReadonlyArray<SceneNode>, time: number): CustomViewId | null {
  const { width, height } = activeCompSize();
  const framing = framingFor(nodes, time, width, height);
  if (!framing) return null;
  const s = useGuidesStore.getState();
  const view: CustomViewId = isCustomViewId(s.camera3dMode) ? s.camera3dMode : s.lastCustomView;
  if (view !== s.camera3dMode) s.setCamera3dMode(view);
  // Keep the angle the user chose; only re-aim and re-distance it.
  const cur = resolveCustomView(s.customViews[view], width, height);
  useGuidesStore.getState().updateCustomView(view, { poi: framing.poi, distance: framing.distance, yaw: cur.yaw, pitch: cur.pitch });
  return view;
}

// ── Distribute in Z ─────────────────────────────────────────────────────────

/**
 * Spread layers apart in depth so a camera move has parallax to work against.
 *
 * This is the missing half of the camera workflow: a user adds a camera,
 * clicks "Make all 3D", dollies — and gets a slide, not a camera move,
 * because every layer still sits at z = 0 and the whole frame moves as one
 * plane. The design-system's `emitDepth` has known this all along
 * ("a camera technique cast onto a composition where everything sits at z=0
 * produces a move with no parallax"); nothing in the app UI could do it.
 *
 * Depth follows the layer stack: the bottom layer goes deepest, the top layer
 * stays on the comp plane, spread across ~a third of the comp's short side —
 * the same ladder `emitDepth` uses, capped for the same reason (past roughly a
 * frame of depth a normal lens distorts the 2D layout).
 *
 * Each unparented layer is then SIZE-COMPENSATED against the active camera's
 * focal length — position scaled about the comp centre and scale multiplied by
 * (focal + z) / focal — so the composition looks identical until the camera
 * moves. Without this the command visibly shrinks everything it pushes back,
 * which reads as damage, not as staging. Parented layers get depth only:
 * their world position rides a rig this command should not second-guess.
 */
export async function distributeLayersInZ(time: number): Promise<{ count: number; span: number } | null> {
  const { width, height } = activeCompSize();
  const rootId = activeCompRootId();
  const selected = subjectLayers().filter(canBe3D);
  const targets = selected.length >= 2 ? selected : frameableLayers().filter(canBe3D);
  if (targets.length < 2) return null;

  // Stacking order, not selection order: later in the flatten = higher in the
  // stack = nearer the camera.
  const order = new Map(flattenComposition(defaultSceneGraph, rootId).map((n, i) => [n.id, i]));
  const sorted = [...targets].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const span = Math.round(Math.min(width, height) * 0.35);
  const step = span / (sorted.length - 1);
  const cam = commandCamera();
  const focal = Math.max(
    1,
    cam ? resolveCommandCamera(cam, time).focalLength : Project3D.defaultCamera(width, height).focalLength,
  );

  const av = sampleAt(time);
  const entries = sorted.map((node, i) => {
    const z = Math.round(span - i * step);
    const values: Record<string, number> = { z };
    if (node.parent === rootId) {
      const factor = (focal + z) / focal;
      const g = readGeometry(node);
      const num = (p: string, fb: number): number => av(node.id, p) ?? fb;
      const x = num('x', g?.x ?? width / 2);
      const y = num('y', g?.y ?? height / 2);
      values.x = width / 2 + (x - width / 2) * factor;
      values.y = height / 2 + (y - height / 2) * factor;
      values.scaleX = num('scaleX', g?.scaleX ?? 1) * factor;
      values.scaleY = num('scaleY', g?.scaleY ?? 1) * factor;
    }
    return { nodeId: node.id, values };
  });
  const flat = sorted.filter((n) => !is3DEnabled(n)).map((n) => n.id);

  // ONE entry: the 3D switch first (Z is a property only a 3D layer has), then
  // the values, keyed where animated / under Auto-Keyframe.
  const label = 'Distribute Layers in Z';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let ok = true;
  if (flat.length > 0) {
    const res = await client.execute({ type: 'setLayerSwitches', layers: flat, patch: { threeD: true } });
    if (!res.ok) { reportEngineError(label, res.error); ok = false; }
  }
  if (ok) {
    const cmds = trackValueCommands(entries, { seconds: time, autoKeyframe: usePreferenceStore.getState().timelineAutoKeyframe });
    const res = cmds && cmds.length > 0 ? await client.batch(label, cmds) : null;
    if (!res || !res.ok) {
      if (res && !res.ok) reportEngineError(label, res.error);
      ok = false;
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  return ok ? { count: sorted.length, span } : null;
}

// ── Commands ────────────────────────────────────────────────────────────────

export function buildCameraCommands(): ReadonlyArray<Command> {
  const oneSubject = (): boolean => commandCamera() !== null && subjectLayers().length === 1;
  return [
    {
      id: asCommandId('camera.createOrbitNull'),
      label: 'Create Orbit Null',
      description: 'A 3D null at the camera\'s point of interest, with the camera parented to it',
      icon: 'camera',
      enabled: () => commandCamera() !== null,
      execute: () => {
        const cam = commandCamera();
        if (!cam) return;
        const id = createOrbitNull(cam.id, playhead());
        notify(id ? `Created orbit null for ${cam.name} — rotate it to orbit the camera` : 'Could not create the orbit null', id ? 'success' : 'warning');
      },
    },
    {
      id: asCommandId('camera.distributeZ'),
      label: 'Distribute Layers in Z',
      description: 'Spread layers in depth for parallax — sizes compensated so the framing does not change',
      icon: 'camera',
      // Two selected content layers, or two in the comp: the command falls
      // back to every content layer when nothing useful is selected.
      enabled: () => subjectLayers().length >= 2 || frameableLayers().length >= 2,
      execute: async () => {
        const r = await distributeLayersInZ(playhead());
        notify(
          r
            ? `Spread ${r.count} layers across ${r.span} px of depth — move the camera to see the parallax`
            : 'Select at least two layers (or have two in the comp) to distribute in Z',
          r ? 'success' : 'warning',
        );
      },
    },
    {
      id: asCommandId('camera.setFocusToLayer'),
      label: 'Set Focus Distance to Layer',
      description: 'Put the camera\'s focal plane on the selected layer',
      icon: 'camera',
      enabled: oneSubject,
      execute: async () => {
        const cam = commandCamera();
        const target = subjectLayers()[0];
        if (!cam || !target) return;
        const d = await setFocusDistanceToLayer(cam.id, target.id, playhead());
        notify(d === null ? `${target.name} is behind the camera` : `Focus distance set to ${Math.round(d)} px (${target.name})`, d === null ? 'warning' : 'success');
      },
    },
    {
      id: asCommandId('camera.linkFocusToLayer'),
      label: 'Link Focus Distance to Layer',
      description: 'Keep the focal plane on the selected layer as either moves (expression)',
      icon: 'camera',
      enabled: oneSubject,
      execute: () => {
        const cam = commandCamera();
        const target = subjectLayers()[0];
        if (!cam || !target) return;
        if (linkFocusDistanceToLayer(cam.id, target.id)) notify(`Focus distance linked to ${target.name}`, 'success');
      },
    },
    {
      id: asCommandId('camera.linkFocusToPoi'),
      label: 'Link Focus Distance to Point of Interest',
      description: 'Keep the focal plane on the two-node camera\'s point of interest (expression)',
      icon: 'camera',
      enabled: () => {
        const cam = commandCamera();
        return cam !== null && isTwoNodeCamera(cam);
      },
      execute: () => {
        const cam = commandCamera();
        if (cam && linkFocusDistanceToPoi(cam.id)) notify('Focus distance linked to the point of interest', 'success');
      },
    },
    {
      id: asCommandId('view.lookAtSelected'),
      label: 'Look at Selected Layers',
      description: 'Aim the custom view at the selected layers and frame them',
      icon: 'frame',
      enabled: () => subjectLayers().length > 0,
      execute: () => { lookAt(subjectLayers(), playhead()); },
    },
    {
      id: asCommandId('view.lookAtAll'),
      label: 'Look at All Layers',
      description: 'Aim the custom view at every layer in the composition',
      icon: 'frame',
      enabled: () => frameableLayers().length > 0,
      execute: () => { lookAt(frameableLayers(), playhead()); },
    },
  ];
}
