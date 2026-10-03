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
 * ## The engine's document, not the page replica
 *
 * Every read is the document MIRROR (layer headers, property trees, keys) or
 * an engine query at the time asked (`trackValuesAt` for evaluated values,
 * `getLayerTransforms` for world matrices); every write is engine commands.
 * The camera is resolved from its props with camera3d's own rule
 * (`cameraFromValues`), lifted through its parent's world matrix.
 *
 * ## Focus distance is measured the way the renderer measures it
 *
 * The renderer defocuses a layer by `dofBlurPx(depth, dof)` where `depth` is
 * `Project3D.projectPoint(world, camera).depth` — the layer's position along
 * the camera's OPTICAL AXIS, not its straight-line distance from the eye.
 * "Set Focus Distance to Layer" therefore writes that same axial depth, so the
 * focal plane lands ON the layer; a Euclidean distance would put it behind the
 * layer by `d·(1 − cos θ)` for any subject off the centre line.
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
import type { Command as EngineCommand, Keyframe, Value } from '@motion/engine-api';
import { Matrix4Math, Project3D, type Camera3D, type Matrix4, type Vec3 } from '@motion/scene';
import { activeCompRootId, activeCompSize } from '@core/scene/activeComp';
import { CAMERA_VALUE_PROPS, cameraFromValues, defaultFocalLength, type CameraValues } from '@core/scene/camera3d';
import { cameraViewNodeId } from '@core/scene/cameraViewMode';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { engine } from '@core/engine/engineInstance';
import { compTime, propRefForTrack, valueOfNumbers } from '@core/engine/propRefs';
import { compOfLayer } from '@core/mirror/docFacts';
import { mirrorLookThroughCamera, mirrorLookThroughCameras } from '@core/mirror/cameras';
import { flattenCompLayers } from '@core/mirror/compLayers';
import { mirrorCanBe3D } from '@core/mirror/layerFacts';
import { uiKindOf } from '@core/mirror/layerKinds';
import { numbersOfValue, plainValue, trackRefIn } from '@core/mirror/trackIndex';
import { trackValueCommands } from '@core/workspace/toolEdits';
import { isCustomViewId, resolveCustomView, type CustomViewId } from '@core/workspace/customViews';
import { documentMirror } from '@stores/documentMirror';
import { trackValuesAt } from '@stores/trackValues';
import { fetchLayerBox } from '@stores/layerBoxes';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { useGuidesStore } from '@stores/guidesStore';

// ── Shared readers ──────────────────────────────────────────────────────────

function playhead(): number {
  const project = useProjectStore.getState();
  return (project.activeTabId ? project.tabs[project.activeTabId]?.time : 0) ?? 0;
}

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 4000 });
}

function kindOf(id: string): string | null {
  return uiKindOf(documentMirror().layer(id));
}

function isDevice(id: string): boolean {
  const k = kindOf(id);
  return k === 'camera' || k === 'light';
}

function nameOf(id: string): string {
  return documentMirror().layer(id)?.name ?? id;
}

/**
 * The camera a command acts on: a SELECTED camera first, else the camera the
 * view looks through (a `camera:<id>` view's camera, else the composition's
 * topmost enabled one). Selecting a camera is how you say "this one" when a
 * comp has several; with none selected the one you are looking through is the
 * answer.
 */
export function commandCamera(): string | null {
  const m = documentMirror();
  for (const id of useSelectionStore.getState().ids) {
    if (uiKindOf(m.layer(id)) === 'camera') return id;
  }
  const comp = activeCompRootId();
  const named = mirrorLookThroughCamera(m, cameraViewNodeId(useGuidesStore.getState().camera3dMode), comp);
  return (named ?? mirrorLookThroughCameras(m, comp)[0])?.id ?? null;
}

/** The selected layers that are neither cameras nor lights. */
export function subjectLayers(): string[] {
  const m = documentMirror();
  return useSelectionStore.getState().ids.filter((id) => !!m.layer(id) && !isDevice(id));
}

/** Content layers of the active comp, back to front — what "all layers" frames. */
export function frameableLayers(): string[] {
  const m = documentMirror();
  return flattenCompLayers(m, activeCompRootId()).filter((id) => {
    const layer = m.layer(id);
    if (!layer || isDevice(id)) return false;
    const k = uiKindOf(layer);
    return k !== 'group' && k !== 'comp' && layer.switches.visible !== false;
  });
}

/**
 * The tracks of `layer` the layer SETS, evaluated at comp `seconds` (keys and
 * expressions win) — undefined for a track it stores no value of its own for,
 * as a prop absent from the node reads in camera3d (a one-node camera has no
 * POI; an unset focus distance falls back to the focal length).
 */
async function setTrackValues(layer: string, tracks: ReadonlyArray<string>, seconds: number): Promise<Record<string, number>> {
  const tree = await documentMirror().loadTree(layer);
  const now = await trackValuesAt(layer, tracks, seconds);
  const out: Record<string, number> = {};
  tracks.forEach((t, i) => {
    const info = trackRefIn(tree, t)?.info;
    const v = now[i];
    if (!info || v === undefined) return;
    if (info.stored === true || info.animated || (info.expressionEnabled && info.expression !== '')) out[t] = v;
  });
  return out;
}

/** A layer's layer → comp 4×4 at comp `seconds` (getLayerTransforms: a 3D layer's world matrix, else the 2D chain). */
async function worldMatrixOf(layer: string, seconds: number): Promise<Matrix4 | null> {
  const res = await engine().query({ type: 'getLayerTransforms', layers: [layer], time: compTime(seconds) });
  const m = res.ok ? res.value.transforms.find((t) => t.layer === layer)?.matrix : undefined;
  return m && m.length === 16 ? (m as unknown as Matrix4) : null;
}

/** The world matrix of a layer's PARENT at `seconds` (null at the top of its comp): what lifts its parent-space points. */
async function parentWorldOf(layer: string, seconds: number): Promise<Matrix4 | null> {
  const parent = documentMirror().layer(layer)?.parent;
  return parent ? worldMatrixOf(parent, seconds) : null;
}

/** A camera as the renderer resolves it at a time, with what the verbs read off it. */
interface CameraRig {
  camera: Camera3D;
  /** The props the camera sets, evaluated (stored units). */
  values: CameraValues & { focusDistance?: number };
  /** Parent space → world. */
  lift: (p: Vec3) => Vec3;
  /** The Point of Interest in the camera's parent space (null: a one-node camera). */
  poi: Vec3 | null;
  /** The focus distance (px): the stored value, else the focal length. */
  focus: number;
}

/** The camera resolved exactly as the renderer resolves it — parents, orbit, POI. Null when `camId` is not a camera. */
export async function resolveCommandCamera(camId: string, seconds: number): Promise<CameraRig | null> {
  if (kindOf(camId) !== 'camera') return null;
  const { width, height } = activeCompSize();
  const [values, parent] = await Promise.all([
    setTrackValues(camId, [...CAMERA_VALUE_PROPS, 'focusDistance'], seconds),
    parentWorldOf(camId, seconds),
  ]);
  const lift = (p: Vec3): Vec3 => (parent ? Matrix4Math.transformPoint(parent, p) : p);
  const hasPoi = values.poiX !== undefined || values.poiY !== undefined || values.poiZ !== undefined;
  return {
    camera: cameraFromValues(values, width, height, lift),
    values,
    lift,
    poi: hasPoi ? { x: values.poiX ?? width / 2, y: values.poiY ?? height / 2, z: values.poiZ ?? 0 } : null,
    focus: values.focusDistance ?? values.focalLength ?? defaultFocalLength(width),
  };
}

/**
 * A layer's world position at `seconds`: the point its Position places (the
 * anchor), parent chain included. A 2D layer sits on the comp plane at z = 0,
 * which is what the renderer and `layerSpaceAt` both say about it.
 */
export async function layerWorldPosition(id: string, seconds: number): Promise<Vec3 | null> {
  const layer = documentMirror().layer(id);
  if (!layer) return null;
  const [m, [ax = 0, ay = 0, az = 0]] = await Promise.all([
    worldMatrixOf(id, seconds),
    trackValuesAt(id, ['anchorX', 'anchorY', 'anchorZ'], seconds),
  ]);
  if (!m) return null;
  const threeD = layer.switches.threeD === true;
  const p = Matrix4Math.transformPoint(m, { x: ax, y: ay, z: threeD ? az : 0 });
  return threeD ? p : { x: p.x, y: p.y, z: 0 };
}

// ── Focus distance ──────────────────────────────────────────────────────────

/**
 * The focus distance that puts the focal plane on `target`: its depth along
 * the camera axis, the number `dofBlurPx` compares against. Null when the
 * layer is behind the camera — there is no focus distance that reaches it.
 */
export async function focusDepthToLayer(camId: string, targetId: string, seconds: number): Promise<number | null> {
  const [rig, p] = await Promise.all([resolveCommandCamera(camId, seconds), layerWorldPosition(targetId, seconds)]);
  if (!rig || !p) return null;
  const o = Project3D.projectPoint(p, rig.camera);
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
  const depth = await focusDepthToLayer(camId, targetId, time);
  if (depth === null) return null;
  const cmds: EngineCommand[] = [];
  const r = propRefForTrack(camId, 'focusDistance');
  const info = r ? documentMirror().property(camId, r.ref.path) : undefined;
  if (r && info?.expression) cmds.push({ type: 'setExpression', prop: r.ref, source: '', enabled: false });
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

/** Put `source` on the camera's Focus Distance as ONE entry. */
async function setFocusExpression(label: string, camId: string, source: string): Promise<boolean> {
  await documentMirror().loadTree(camId);
  const r = propRefForTrack(camId, 'focusDistance');
  if (!r) return false;
  return (await edit(label, [{ type: 'setExpression', prop: r.ref, source, enabled: true }])).ok;
}

export async function linkFocusDistanceToLayer(camId: string, targetId: string): Promise<boolean> {
  if (kindOf(camId) !== 'camera' || !documentMirror().layer(targetId)) return false;
  return setFocusExpression('Link focus distance to layer', camId, linkFocusToLayerExpression(nameOf(targetId)));
}

/**
 * A two-node camera (Auto-Orientation ▸ Orient Towards Point of Interest, AE):
 * it carries a Point of Interest. Read off the mirror's property tree — false
 * until the tree has loaded.
 */
export function isTwoNodeCamera(camId: string): boolean {
  if (kindOf(camId) !== 'camera') return false;
  return plainValue(documentMirror().property(camId, 'transform/orientTowardsPointOfInterest')?.value) === true;
}

export async function linkFocusDistanceToPoi(camId: string): Promise<boolean> {
  await documentMirror().loadTree(camId);
  if (!isTwoNodeCamera(camId)) return false;
  return setFocusExpression('Link focus distance to point of interest', camId, linkFocusToPoiExpression(nameOf(camId)));
}

// ── Create Orbit Null ───────────────────────────────────────────────────────

/**
 * Where the orbit null goes: the camera's Point of Interest in WORLD space, or
 * — for a one-node camera, which has no POI — the point at the focus distance
 * along the optical axis. The axis is the ray through the principal point,
 * which is exactly how `unprojectScreenRay` defines it, so a rolled or tilted
 * camera gets the axis it actually looks along.
 */
export function orbitPivotFor(rig: CameraRig, width: number, height: number): Vec3 {
  if (rig.poi) return rig.lift(rig.poi);
  const camera = rig.camera;
  const ray = Project3D.unprojectScreenRay(camera.principal.x, camera.principal.y, camera, null, width, height);
  return {
    x: ray.origin.x + ray.direction.x * rig.focus,
    y: ray.origin.y + ray.direction.y * rig.focus,
    z: ray.origin.z + ray.direction.z * rig.focus,
  };
}

export interface TransformRebase {
  prop: string;
  /** The new BASE value of the prop. */
  value: number;
  /** How far every keyframe of the prop's track moves — the change in local value. */
  delta: number;
}

interface OrbitPlan {
  name: string;
  pivot: Vec3;
  rebases: TransformRebase[];
}

/**
 * Where the orbit null goes and how the camera re-bases under it: the eye's
 * and the POI's STORED (base) values move into the null's space, every key by
 * the same delta.
 */
async function orbitPlan(camId: string, seconds: number): Promise<OrbitPlan | null> {
  const rig = await resolveCommandCamera(camId, seconds);
  if (!rig) return null;
  const m = documentMirror();
  const tree = m.tree(camId);
  const { width, height } = activeCompSize();
  const pivot = orbitPivotFor(rig, width, height);
  const def = Project3D.defaultCamera(width, height);
  // The base values the camera stores (the props, not the keys): what the re-base moves.
  const base = (track: string): number | undefined => {
    const r = trackRefIn(tree, track);
    if (!r || r.info.stored !== true) return undefined;
    const n = numbersOfValue(r.info.value)[r.member];
    return typeof n === 'number' && Number.isFinite(n) ? n / r.factor : undefined;
  };
  const focal = base('focalLength') ?? def.focalLength;
  const localEye = { x: base('x') ?? def.position.x, y: base('y') ?? def.position.y, z: base('z') ?? -focal };
  const worldEye = rig.lift(localEye);
  const px = base('poiX');
  const py = base('poiY');
  const pz = base('poiZ');
  const localPoi = px !== undefined || py !== undefined || pz !== undefined ? { x: px ?? width / 2, y: py ?? height / 2, z: pz ?? 0 } : null;
  const newEye = { x: worldEye.x - pivot.x, y: worldEye.y - pivot.y, z: worldEye.z - pivot.z };
  const rebases: TransformRebase[] = [
    { prop: 'x', value: newEye.x, delta: newEye.x - localEye.x },
    { prop: 'y', value: newEye.y, delta: newEye.y - localEye.y },
    { prop: 'z', value: newEye.z, delta: newEye.z - localEye.z },
  ];
  if (localPoi) {
    const worldPoi = rig.lift(localPoi);
    const newPoi = { x: worldPoi.x - pivot.x, y: worldPoi.y - pivot.y, z: worldPoi.z - pivot.z };
    rebases.push(
      { prop: 'poiX', value: newPoi.x, delta: newPoi.x - localPoi.x },
      { prop: 'poiY', value: newPoi.y, delta: newPoi.y - localPoi.y },
      { prop: 'poiZ', value: newPoi.z, delta: newPoi.z - localPoi.z },
    );
  }
  return { name: `${nameOf(camId)} Orbit Null`, pivot, rebases };
}

/** One member of a numeric value shifted by `delta` (API units). */
function shiftedValue(v: Value, shifts: ReadonlyMap<number, number>, type: Parameters<typeof valueOfNumbers>[0]): Value {
  const nums = numbersOfValue(v).map((n, i) => n + (shifts.get(i) ?? 0));
  return valueOfNumbers(type, nums);
}

/**
 * Re-base transform properties RIGIDLY, as engine commands composed on the
 * mirror: a static property takes the new base values, an animated one has
 * every key shifted by the delta (spatial tangents are value-space offsets, so
 * a translation leaves them untouched). The opposite of a playhead write —
 * which would pin one frame and leave the move's other keys in the old space.
 */
export function rebaseCommands(layer: string, rebases: ReadonlyArray<TransformRebase>): EngineCommand[] | null {
  const m = documentMirror();
  const tree = m.tree(layer);
  if (!tree) return null;
  const byPath = new Map<string, { rebases: Array<TransformRebase & { member: number; factor: number }> }>();
  for (const rb of rebases) {
    if (!Number.isFinite(rb.value) || !Number.isFinite(rb.delta)) continue;
    const r = trackRefIn(tree, rb.prop);
    if (!r || !r.info.animatable) return null;
    let g = byPath.get(r.path);
    if (!g) byPath.set(r.path, (g = { rebases: [] }));
    g.rebases.push({ ...rb, member: r.member, factor: r.factor });
  }
  const out: EngineCommand[] = [];
  for (const [path, g] of byPath) {
    const info = tree.nodes.get(path)!;
    const prop = { layer, path };
    const keys = m.keyframes(layer, path);
    if (keys.length > 0) {
      const shifts = new Map(g.rebases.map((rb) => [rb.member, rb.delta * rb.factor] as const));
      if ([...shifts.values()].every((d) => Math.abs(d) < 1e-9)) continue;
      out.push({ type: 'setKeyframes', prop, keys: keys.map((k): Keyframe => ({ ...k, value: shiftedValue(k.value, shifts, info.valueType) })) });
      continue;
    }
    const nums = numbersOfValue(info.value);
    for (const rb of g.rebases) nums[rb.member] = rb.value * rb.factor;
    out.push({ type: 'setProperty', prop, value: valueOfNumbers(info.valueType, nums) });
  }
  return out;
}

/**
 * Create Orbit Null as ONE history entry (an engine gesture): a 3D null made
 * at the camera's pivot, the camera parented to it WITHOUT compensation, and
 * the camera's position / POI re-based (base values and every key) into the
 * null's space so nothing moves on screen.
 *
 * The compensation is done here and not by `setParent`'s keep-world path
 * because that path is 2D: it re-bases x/y and leaves `z` where it was, which
 * for a camera pulled back by its focal length is the whole picture. Resolves
 * to the null's id, or null when refused.
 */
export async function createOrbitNullEdit(camId: string, time: number): Promise<string | null> {
  const plan = await orbitPlan(camId, time);
  const comp = compOfLayer(camId);
  if (!plan || !comp) return null;
  const rebase = rebaseCommands(camId, plan.rebases);
  if (!rebase) return null;
  const e = engine();
  const began = await e.execute({ type: 'beginGesture', label: 'Create Orbit Null' });
  if (!began.ok) return null;
  let ok = false;
  let nullId: string | null = null;
  try {
    const made = await e.execute({
      type: 'createLayer', comp, kind: 'null', name: plan.name,
      init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x: plan.pivot.x, y: plan.pivot.y } } }],
    });
    if (!made.ok) return null;
    nullId = made.value.layer;
    const three = await e.execute({ type: 'setLayerSwitches', layers: [nullId], patch: { threeD: true } });
    if (!three.ok) return null;
    const placed = await e.execute({ type: 'setProperty', prop: { layer: nullId, path: 'transform/position' }, value: { kind: 'vec3', value: plan.pivot } });
    if (!placed.ok) return null;
    const parented = await e.execute({ type: 'setParent', layers: [camId], parent: nullId, keepWorldTransform: false });
    if (!parented.ok) return null;
    // A relink without compensation leaves the camera's values as they were: the re-base composed above still holds.
    if (rebase.length > 0) {
      const res = await e.batch('Create Orbit Null', rebase);
      if (!res.ok) return null;
    }
    ok = true;
  } finally {
    await e.execute({ type: 'endGesture', gesture: began.value.gesture, commit: ok });
  }
  if (nullId && ok) useSelectionStore.getState().set([nullId]);
  return ok ? nullId : null;
}

// ── Look at ─────────────────────────────────────────────────────────────────

/** A layer to frame: its world position and the radius of its box (scale included). */
export interface FramingSubject {
  p: Vec3;
  r: number;
}

/** The framing subjects of `ids` at comp `seconds` (layers with no position are left out). */
export async function framingSubjects(ids: ReadonlyArray<string>, seconds: number): Promise<FramingSubject[]> {
  const t = compTime(seconds);
  const out = await Promise.all(ids.map(async (id): Promise<FramingSubject | null> => {
    const [p, box, [sx = 1, sy = 1]] = await Promise.all([
      layerWorldPosition(id, seconds),
      fetchLayerBox(id, t),
      trackValuesAt(id, ['scaleX', 'scaleY'], seconds),
    ]);
    if (!p) return null;
    const r = box ? (Math.hypot(box.width, box.height) / 2) * Math.max(Math.abs(sx), Math.abs(sy)) : 0;
    return { p, r };
  }));
  return out.filter((s): s is FramingSubject => s !== null);
}

/**
 * The orbit that frames `subjects`: POI at their centroid, distance so the
 * sphere enclosing every layer's box fits the narrower field of view with a
 * little air. Pure — the caller decides which view receives it.
 */
export function framingFor(
  subjects: ReadonlyArray<FramingSubject>,
  width: number,
  height: number,
): { poi: Vec3; distance: number } | null {
  if (subjects.length === 0) return null;
  const n = subjects.length;
  const poi = subjects.reduce((acc, { p }) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n, z: acc.z + p.z / n }), { x: 0, y: 0, z: 0 });
  let radius = 1;
  for (const { p, r } of subjects) radius = Math.max(radius, Math.hypot(p.x - poi.x, p.y - poi.y, p.z - poi.z) + r);
  const focal = Project3D.defaultCamera(width, height).focalLength;
  const fovH = Project3D.fovForFocalLength(width, focal);
  const fovV = Project3D.fovForFocalLength(height, focal);
  const half = (Math.min(fovH, fovV) / 2) * (Math.PI / 180);
  const distance = Math.max(1, (radius / Math.sin(half)) * 1.1);
  return { poi, distance };
}

/**
 * Point the custom view at `ids`. In After Effects this verb is greyed out
 * in Active Camera and the ortho views — it aims a VIEW, never the shot camera.
 * Here it switches to the last custom view first, which is what the user is
 * about to do anyway. Resolves to the view it aimed.
 */
export async function lookAt(ids: ReadonlyArray<string>, seconds: number): Promise<CustomViewId | null> {
  const { width, height } = activeCompSize();
  const framing = framingFor(await framingSubjects(ids, seconds), width, height);
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
  const m = documentMirror();
  const canBe3D = async (ids: readonly string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const id of ids) if (mirrorCanBe3D(m.layer(id), await m.loadTree(id))) out.push(id);
    return out;
  };
  const selected = await canBe3D(subjectLayers());
  const targets = selected.length >= 2 ? selected : await canBe3D(frameableLayers());
  if (targets.length < 2) return null;

  // Stacking order, not selection order: later in the walk = higher in the
  // stack = nearer the camera.
  const order = new Map(flattenCompLayers(m, activeCompRootId()).map((id, i) => [id, i]));
  const sorted = [...targets].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const span = Math.round(Math.min(width, height) * 0.35);
  const step = span / (sorted.length - 1);
  const cam = commandCamera();
  const rig = cam ? await resolveCommandCamera(cam, time) : null;
  const focal = Math.max(1, rig ? rig.camera.focalLength : Project3D.defaultCamera(width, height).focalLength);

  const entries = await Promise.all(sorted.map(async (id, i) => {
    const z = Math.round(span - i * step);
    const values: Record<string, number> = { z };
    if (!m.layer(id)?.parent) {
      const factor = (focal + z) / focal;
      const [x = width / 2, y = height / 2, sx = 1, sy = 1] = await trackValuesAt(id, ['x', 'y', 'scaleX', 'scaleY'], time);
      values.x = width / 2 + (x - width / 2) * factor;
      values.y = height / 2 + (y - height / 2) * factor;
      values.scaleX = sx * factor;
      values.scaleY = sy * factor;
    }
    return { nodeId: id, values };
  }));
  const flat = sorted.filter((id) => m.layer(id)?.switches.threeD !== true);

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
    // The values below are composed on the trees the switch just grew a Z in.
    else await m.whenAt(res.revision);
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
      execute: async () => {
        const cam = commandCamera();
        if (!cam) return;
        const id = await createOrbitNullEdit(cam, playhead());
        notify(id ? `Created orbit null for ${nameOf(cam)} — rotate it to orbit the camera` : 'Could not create the orbit null', id ? 'success' : 'warning');
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
        const d = await setFocusDistanceToLayer(cam, target, playhead());
        notify(d === null ? `${nameOf(target)} is behind the camera` : `Focus distance set to ${Math.round(d)} px (${nameOf(target)})`, d === null ? 'warning' : 'success');
      },
    },
    {
      id: asCommandId('camera.linkFocusToLayer'),
      label: 'Link Focus Distance to Layer',
      description: 'Keep the focal plane on the selected layer as either moves (expression)',
      icon: 'camera',
      enabled: oneSubject,
      execute: async () => {
        const cam = commandCamera();
        const target = subjectLayers()[0];
        if (!cam || !target) return;
        if (await linkFocusDistanceToLayer(cam, target)) notify(`Focus distance linked to ${nameOf(target)}`, 'success');
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
      execute: async () => {
        const cam = commandCamera();
        if (cam && await linkFocusDistanceToPoi(cam)) notify('Focus distance linked to the point of interest', 'success');
      },
    },
    {
      id: asCommandId('view.lookAtSelected'),
      label: 'Look at Selected Layers',
      description: 'Aim the custom view at the selected layers and frame them',
      icon: 'frame',
      enabled: () => subjectLayers().length > 0,
      execute: async () => { await lookAt(subjectLayers(), playhead()); },
    },
    {
      id: asCommandId('view.lookAtAll'),
      label: 'Look at All Layers',
      description: 'Aim the custom view at every layer in the composition',
      icon: 'frame',
      enabled: () => frameableLayers().length > 0,
      execute: async () => { await lookAt(frameableLayers(), playhead()); },
    },
  ];
}
