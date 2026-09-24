import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useActiveCompSize } from '@hooks/useMirrorFrame';
import { layerScreenMapping } from './layerScreen';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry } from '@core/workspace/geometry';
import { readNodePuppet, deform, pinKindOf, pinColor, pinHasTransformGizmo, restPointFromDeformed } from '@core/rig/puppet';
import { resolveLivePins } from '@core/rig/livePins';
import { resolveActiveIkTargets } from '@core/rig/liveIkTargets';
import { nodeRestMesh } from '@core/rig/rigMeshInputs';
import { useAssetStore } from '@stores/assetStore';
import { SketchRecorder, DEFAULT_SKETCH_TOLERANCE } from '@core/rig/puppetSketch';
import { readNodeSkeleton, bindPoseBones } from '@core/rig/skeletonCommands';
import { computeWorldTransforms, type Bone } from '@core/rig/skeleton';
import { resolveLiveBones } from '@core/rig/liveBones';
import {
  applyIk,
  getSkeletonBinding,
  skinRigVertices,
  unskinPoint,
  skinPointAt,
  type IkTargetResolved,
  type SkeletonBinding,
} from '@core/rig/rigDeform';
import type { Mat2D } from '@core/rig/mat2d';
import { dataPathTangents } from '@motion/animation';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { edit } from '@core/engine/uiEdits';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { rigPaths, rigMatch, rigValues, rigKey, rigRemove } from '@core/engine/rigPaths';
import { useGesture } from '@hooks/useGesture';

/** Radius (screen px) of the advanced-pin gizmo ring. */
const GIZMO_R = 26;


/**
 * Pointer capture is a nicety, not a precondition: it keeps a drag alive when
 * the pointer leaves the SVG. `setPointerCapture` throws NotFoundError if the
 * id is not an active pointer, and an uncaught throw here aborts the rest of
 * the pointerdown handler — losing the selection and the drag it was setting
 * up. The release path was already guarded; this is the missing other half.
 */
function capturePointer(svg: SVGSVGElement, pointerId: number): void {
  try {
    svg.setPointerCapture(pointerId);
  } catch {
    /* capture unavailable — the drag still works, it just won't track outside */
  }
}

/**
 * Unique mesh edges as one SVG path.
 *
 * After Effects' Puppet overlay is a regular lattice, not a filled triangulation.
 * Drawing every triangle as its own stroked polygon doubled every shared edge
 * and read as a noisy blueprint. Grid mode keeps only rest-axis edges so the
 * lattice is boxes; silhouette mode (an outline ear-clip) still needs every
 * edge or the wireframe would vanish.
 */
function puppetLatticePath(
  rest: Float32Array,
  posed: Float32Array,
  triangles: Uint16Array,
  toScreen: (x: number, y: number) => { x: number; y: number },
  boxesOnly: boolean,
): string {
  const seen = new Set<number>();
  let d = '';
  for (let i = 0; i < triangles.length; i += 3) {
    const tri = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!];
    for (let e = 0; e < 3; e++) {
      let a = tri[e]!;
      let b = tri[(e + 1) % 3]!;
      if (a > b) {
        const t = a;
        a = b;
        b = t;
      }
      const key = a * 65536 + b;
      if (seen.has(key)) continue;
      seen.add(key);
      if (boxesOnly) {
        const ax = rest[a * 4]!;
        const ay = rest[a * 4 + 1]!;
        const bx = rest[b * 4]!;
        const by = rest[b * 4 + 1]!;
        if (Math.abs(ax - bx) > 1e-3 && Math.abs(ay - by) > 1e-3) continue;
      }
      const p = toScreen(posed[a * 4]!, posed[a * 4 + 1]!);
      const q = toScreen(posed[b * 4]!, posed[b * 4 + 1]!);
      d += `M${p.x.toFixed(2)} ${p.y.toFixed(2)}L${q.x.toFixed(2)} ${q.y.toFixed(2)}`;
    }
  }
  return d;
}

export function PuppetOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const puppetPinKind = useUIStore((s) => s.puppetPinKind);
  const selectedNodeId = useSelectionStore((s) => s.ids[0]);
  const activeWorkspace = useActiveWorkspace();
  const time = activeWorkspace?.time ?? 0;
  const comp = useActiveCompSize();

  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);
  const dragInfoRef = useRef<{
    pinId: string;
    startScreen: { x: number; y: number };
    /** Alt-drag rotates; the gizmo's square handle scales; Ctrl records. */
    mode: 'move' | 'rotate' | 'scale' | 'sketch';
    startAngleDeg: number;
    startRotationDeg: number;
    startDist?: number;
    startScale?: number;
  } | null>(null);
  /** Live Puppet Sketch recorder (3A) — accumulates while Ctrl-dragging. */
  const sketchRef = useRef<SketchRecorder | null>(null);
  const [sketchTolerance, setSketchTolerance] = useState(DEFAULT_SKETCH_TOLERANCE);
  const [isRecording, setIsRecording] = useState(false);
  /** Spatial tangent handle being dragged (the pin motion path). */
  const tangentDragRef = useRef<{
    pinId: string;
    /** Index of the key in the pin's position track (the handles' order). */
    index: number;
    which: 'in' | 'out';
    /** The key's engine id, once the getKeyframes query answered. */
    keyId: string | null;
  } | null>(null);
  /** One pin drag / gizmo drag / tangent drag = one engine gesture = one undo entry. */
  const gesture = useGesture();
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Drag/element-origin guard: pointerup synthesizes a click even after a drag
  // (stopPropagation on pointerdown does NOT stop it), so every pin drag-release
  // used to also spawn a stray pin. Any pointerdown on an existing pin, any
  // completed drag, or travel past the slop suppresses the click-add.
  const suppressClickAddRef = useRef(false);

  const deletePin = useCallback((nodeId: string, pinId: string) => {
    // One undo entry: removePropertyGroups takes the pin AND its keyframes
    // (position/rotation/scale/stiffness/overlap); undo restores both.
    void edit('Delete Puppet Pin', rigRemove(nodeId, [rigPaths.pin(pinId)]));
    if (selectedPinId === pinId) setSelectedPinId(null);
  }, [selectedPinId]);

  // Force re-render on render ticks / camera movements. `onRender` returns a
  // disposer now (it used to be a single-slot setter, so this subscription was
  // being clobbered by the viewport's and the handles froze during a pan).
  const [, setTick] = useState(0);
  useEffect(() => {
    const controller = getWorkspaceController();
    return controller.onRender(() => {
      setTick((t) => t + 1);
    });
  }, []);

  // Keyboard listener to delete selected pin
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTool !== 'puppet-pin' || !selectedNodeId || !selectedPinId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deletePin(selectedNodeId, selectedPinId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, selectedNodeId, selectedPinId, deletePin]);

  if (activeTool !== 'puppet-pin' || !selectedNodeId) return null;

  const node = defaultSceneGraph.getNode(selectedNodeId);
  if (!node) return null;

  const geom = readGeometry(node);
  if (!geom) return null;

  const puppetRig = readNodePuppet(node);
  const pins = puppetRig?.pins ?? [];

  const controller = getWorkspaceController();
  const camera = controller.ws.camera;

  // ONE projection, shared with BoneOverlay and the effect-handle overlay.
  //
  // This was a local pair built on `worldMatrix(geom)`, byte-identical to
  // BoneOverlay's, and it composed only THIS node's transform — so on a
  // parented layer the pins drew at the unparented position while the artwork
  // rendered at the parented one (F23). `layerScreenMapping` goes through
  // `layerSpaceAt`, which walks the chain and handles 3D.
  const mapping = layerScreenMapping(node.id, time, comp, camera);
  const localToScreen = (lx: number, ly: number) =>
    mapping ? mapping.localToScreen(lx, ly) : { x: lx, y: ly };
  const screenToLocal = (sx: number, sy: number) =>
    mapping ? mapping.screenToLocal(sx, sy) : { x: sx, y: sy };

  // Canonical keyframe axis — the same forward map buildSnapshot samples. A
  // DISPLAY read only: every write below sends composition time.
  const layerT = keyAxisTimeForDisplay(node.id, time);

  // Same assembly BoneOverlay and the renderer use. `authoringPreview` hugs the
  // PNG silhouette before the first pin exists, so placing a pin does not
  // retopologize a bounding-box grid into a body mesh.
  const restMesh = nodeRestMesh(
    node,
    geom,
    (id) => useAssetStore.getState().assets.find((asset) => asset.id === id),
    true,
  );
  const pad = puppetRig?.meshExpansion ?? 0;

  // Shared with buildSnapshot — see `livePins.ts` for why this is not written
  // out here a second time.
  const animatedPins = resolveLivePins(pins, node.id, layerT, defaultAnimation);

  let deformedVertices = deform(
    animatedPins, restMesh, puppetRig?.solver ?? 'arap', puppetRig?.maxRotationDeg,
  );
  // The puppet solve alone, BEFORE any skeleton skinning: the space a pointer
  // lands in once `toRestSpace` has undone the skeleton, and therefore the
  // space a new pin's click has to be inverted from (see `onClickOverlay`).
  const puppetDeformed = deformedVertices;

  // Skeleton composition preview — mirror buildSnapshot exactly: when the layer
  // also carries a skeleton, the puppet solve stays in REST space and the
  // skeleton skinning (FK + IK) poses the puppet-refined mesh on top. Pins are
  // authored/stored in rest space; pointer input is mapped back via unskinPoint.
  const skel = readNodeSkeleton(node);
  let skelBinding: SkeletonBinding | null = null;
  let skelPoseWorld: Map<string, Mat2D> | null = null;
  if (skel && skel.bones.length > 0) {
    const animatedBones: Bone[] = resolveLiveBones(skel.bones, node.id, layerT, defaultAnimation);
    // Shared resolver. This copy had DRIFTED — it never sampled the pole, so a
    // keyframed pole previewed here differently from how it rendered.
    const activeIk: IkTargetResolved[] = resolveActiveIkTargets(skel, node.id, layerT);
    // B3-legacy: not a write — `applyIk` is the pure IK solve over a bone list (the ratchet's
    // exact-name match; belongs in the rule's NOT_WRITES).
    const posedBones = applyIk(animatedBones, activeIk);
    skelPoseWorld = computeWorldTransforms({ bones: posedBones });
    // BIND to the rig's rest pose, POSE with the live one — same rule as
    // buildSnapshot and BoneOverlay, so all three agree on where the skin sits.
    skelBinding = getSkeletonBinding(restMesh, bindPoseBones(skel), skel.weightPaint);
    deformedVertices = skinRigVertices(skelBinding, skelPoseWorld, deformedVertices);
  }

  /** Posed-space pointer position → rest space (identity without a skeleton). */
  const toRestSpace = (p: { x: number; y: number }): { x: number; y: number } =>
    skelBinding && skelPoseWorld ? unskinPoint(p, skelBinding, skelPoseWorld) : p;

  /** Rest-space point → screen, through the skeleton pose like the pin dots. */
  const restToScreen = (p: { x: number; y: number }) => {
    const posed = skelBinding && skelPoseWorld
      ? skinPointAt(p, p, skelBinding, skelPoseWorld)
      : p;
    return localToScreen(posed.x, posed.y);
  };

  // ── Pin motion path (spatial tangents) ──────────────────────────────
  // The trajectory the SELECTED pin travels, drawn from the same data track the
  // renderer samples. Straight lines read as robotic; the tangent handles are
  // how you arc a limb. Only the selected pin's path is drawn — every pin at
  // once is unreadable on a dense rig.
  const pathTrack = selectedPinId
    ? defaultAnimation.getDataTrack(node.id, `puppet.${selectedPinId}.position`)
    : null;
  const pathHandles = pathTrack && pathTrack.keyframes.length > 1
    ? dataPathTangents(pathTrack, 0)
    : [];
  /** Sampled polyline of the pin's trajectory, in screen space. */
  const motionPathD = (() => {
    if (!pathTrack || pathHandles.length < 2) return '';
    const SEGMENTS = 24; // per keyframe span — smooth without flooding the DOM
    const first = pathTrack.keyframes[0]!.t;
    const last = pathTrack.keyframes[pathTrack.keyframes.length - 1]!.t;
    const pts: string[] = [];
    const steps = SEGMENTS * (pathTrack.keyframes.length - 1);
    for (let i = 0; i <= steps; i++) {
      const tt = first + ((last - first) * i) / steps;
      const v = defaultAnimation.sampleData(node.id, `puppet.${selectedPinId}.position`, tt);
      if (!Array.isArray(v) || !v[0]) continue;
      const p = v[0] as { x: number; y: number };
      const s = restToScreen(p);
      pts.push(`${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`);
    }
    return pts.join(' ');
  })();

  // After Effects draws a gold lattice, not filled triangles. Grid mode is
  // boxes (the two-triangle cell's diagonal is omitted); an OUTLINE mesh keeps
  // every unique edge because it has no axis-aligned lattice to reduce to.
  //
  // The mesh says which it is. This used to try boxes first and fall back only
  // when that produced NOTHING — which held while the only outline mesh was an
  // ear-clipped vector path (no axis-aligned edges at all), and broke the moment
  // the alpha mesher started emitting some: a handful of edges survived the
  // filter and the overlay drew disconnected dashes instead of a wireframe.
  const latticeBoxes = (restMesh.layout ?? 'grid') === 'grid';
  const meshPath =
    (latticeBoxes
      ? puppetLatticePath(restMesh.vertices, deformedVertices, restMesh.triangles, localToScreen, true)
      : '')
    // Any mesh whose box filter leaves nothing (and every outline mesh) draws
    // every unique edge, so the wireframe can never come out empty.
    || puppetLatticePath(restMesh.vertices, deformedVertices, restMesh.triangles, localToScreen, false);

  /**
   * The point a pin's rotation gesture turns about, in the same local space the
   * pointer is mapped into.
   *
   * For an advanced pin that is its own live position. For a bend pin it is the
   * DERIVED centre — read out of the solved mesh — because that is where the
   * pin visibly is and where its rotation is actually applied. Measuring the
   * drag angle from the rest anchor instead would put the gesture's origin
   * somewhere the user cannot see, and the further the drivers carried the pin
   * the more the rotation would lag the pointer.
   */
  const pinRotationCenter = (pinId: string): { x: number; y: number } => {
    const pin = pins.find((p) => p.id === pinId);
    const animPin = animatedPins.find((p) => p.id === pinId);
    if (pin?.kind === 'bend') {
      const k = restMesh.pinVertexIndices[pinId];
      if (k !== undefined && deformedVertices.length >= k * 4 + 2) {
        return { x: deformedVertices[k * 4 + 0]!, y: deformedVertices[k * 4 + 1]! };
      }
    }
    return { x: animPin?.x ?? 0, y: animPin?.y ?? 0 };
  };

  // Pointer drag operations
  const onPointerDownPin = (e: React.PointerEvent, pinId: string) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    setSelectedPinId(pinId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Ctrl/Cmd = Puppet Sketch (record in real time during playback).
    // Alt = rotate the deformation around the pin. Plain drag = move.
    let mode: 'move' | 'rotate' | 'sketch' =
      e.ctrlKey || e.metaKey ? 'sketch' : e.altKey ? 'rotate' : 'move';
    // A bend pin has no position of its own to move or record — the solve
    // derives one from the pins around it. Dragging it rotates instead, which
    // is the one spatial thing it does own, rather than doing nothing at all.
    const isBend = pins.find((p) => p.id === pinId)?.kind === 'bend';
    if (isBend && mode !== 'rotate') mode = 'rotate';
    const animPin = animatedPins.find((p) => p.id === pinId);
    let startAngleDeg = 0;
    let startRotationDeg = 0;
    if (mode === 'rotate') {
      const local = toRestSpace(screenToLocal(startScreen.x, startScreen.y));
      const { x: cx, y: cy } = pinRotationCenter(pinId);
      startAngleDeg = (Math.atan2(local.y - cy, local.x - cx) * 180) / Math.PI;
      startRotationDeg = animPin?.rotation ?? 0;
    }
    if (mode === 'sketch') {
      sketchRef.current = new SketchRecorder();
      setIsRecording(true);
    }

    // One gesture = one undo entry; every move sends the absolute value.
    gesture.begin(
      mode === 'sketch' ? `Sketch Puppet Pin ${pinId}` : mode === 'rotate' ? `Rotate Puppet Pin ${pinId}` : `Move Puppet Pin ${pinId}`,
    );
    dragInfoRef.current = { pinId, startScreen, mode, startAngleDeg, startRotationDeg };
    capturePointer(svg, e.pointerId);
  };

  /** Grab the gizmo's square handle — uniform scale around the pin (3B). */
  const onPointerDownScale = (e: React.PointerEvent, pinId: string) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    setSelectedPinId(pinId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const animPin = animatedPins.find((p) => p.id === pinId);
    const local = toRestSpace(screenToLocal(startScreen.x, startScreen.y));
    const c = pinRotationCenter(pinId);
    dragInfoRef.current = {
      pinId,
      startScreen,
      mode: 'scale',
      startAngleDeg: 0,
      startRotationDeg: 0,
      startDist: Math.max(1e-3, Math.hypot(local.x - c.x, local.y - c.y)),
      startScale: animPin?.scale ?? 1,
    };
    gesture.begin(`Scale Puppet Pin ${pinId}`);
    capturePointer(svg, e.pointerId);
  };

  /** Grab a spatial tangent handle on the selected pin's motion path. */
  const onPointerDownTangent = (
    e: React.PointerEvent,
    pinId: string,
    index: number,
    which: 'in' | 'out',
  ) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    const svg = svgRef.current;
    if (!svg) return;
    const drag = { pinId, index, which, keyId: null as string | null };
    tangentDragRef.current = drag;
    gesture.begin(`Curve Puppet Pin Path ${pinId}`);
    // The key's engine id (keys are addressed by id, never by time).
    void engine().query({ type: 'getKeyframes', props: [{ layer: node.id, path: rigPaths.pinProp(pinId, 'position') }] }).then((res) => {
      if (res.ok) drag.keyId = res.value.sets[0]?.keyframes[index]?.id ?? null;
    });
    capturePointer(svg, e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // Tangent handles take precedence — they sit on top of the mesh.
    const tan = tangentDragRef.current;
    if (tan) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const handle = toRestSpace(
        screenToLocal(e.clientX - rect.left, e.clientY - rect.top),
      );
      const track = defaultAnimation.getDataTrack(node.id, `puppet.${tan.pinId}.position`);
      const k = track?.keyframes[tan.index];
      const p = (k?.value as Array<{ x: number; y: number }> | undefined)?.[0];
      if (!k || !p || !tan.keyId) return;
      // Plain drag mirrors the opposite handle (a smooth point, the AE default);
      // Alt breaks the point so the two sides move independently. Absolute
      // offsets from the key, per move.
      const d = [handle.x - p.x, handle.y - p.y];
      const other = e.altKey ? null : [-d[0]!, -d[1]!];
      const patch = tan.which === 'out'
        ? { spatialOut: d, spatialIn: other ?? [] }
        : { spatialIn: d, spatialOut: other ?? [] };
      gesture.send({ type: 'updateKeyframes', patches: [{ id: tan.keyId, ...patch }] });
      controller.requestRender();
      return;
    }

    const drag = dragInfoRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const currentScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Rest space, like the rotate branch below already does. Pin POSITION tracks
    // are stored in rest space (the puppet solve runs in rest space before the
    // skeleton skins on top), so writing a posed-space coordinate here made a pin
    // jump the moment a layer had both a skeleton and puppet pins.
    const localCoords = toRestSpace(screenToLocal(currentScreen.x, currentScreen.y));

    if (drag.mode === 'rotate') {
      // Live update the pin rotation (scalar keyframe track) directly.
      const { x: cx, y: cy } = pinRotationCenter(drag.pinId);
      const angleDeg = (Math.atan2(localCoords.y - cy, localCoords.x - cx) * 180) / Math.PI;
      let rotation = drag.startRotationDeg + (angleDeg - drag.startAngleDeg);
      // Shift constrains rotation to 15° increments, matching AE's gizmo.
      if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
      // Puppet pins always key (AE's pins are animated from the start).
      gesture.send(rigKey(node.id, rigPaths.pinProp(drag.pinId, 'rotation'), time, rigValues.scalar(rotation)));
      controller.requestRender();
      return;
    }

    if (drag.mode === 'scale') {
      const c = pinRotationCenter(drag.pinId);
      const d = Math.hypot(localCoords.x - c.x, localCoords.y - c.y);
      let scale = (drag.startScale ?? 1) * (d / (drag.startDist ?? 1));
      // Shift constrains scale to 5% steps, matching AE's gizmo.
      if (e.shiftKey) scale = Math.round(scale * 20) / 20;
      // API unit: percent.
      gesture.send(rigKey(node.id, rigPaths.pinProp(drag.pinId, 'scale'), time, rigValues.scalar(Math.max(0.01, scale) * 100)));
      controller.requestRender();
      return;
    }

    if (drag.mode === 'sketch') {
      // Record against the LIVE playhead (composition seconds — the axis the
      // keys are sent on) so the captured path is spread across real time
      // rather than collapsing onto one frame.
      sketchRef.current?.add(localCoords.x, localCoords.y, time);
      controller.requestRender();
      return;
    }

    // The pin's Position key at the playhead, absolute per move.
    gesture.send(rigKey(node.id, rigPaths.pinProp(drag.pinId, 'position'), time, rigValues.vec2(localCoords.x, localCoords.y)));

    controller.requestRender();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const tan = tangentDragRef.current;
    if (tan) {
      tangentDragRef.current = null;
      const svg = svgRef.current;
      if (svg) {
        try { svg.releasePointerCapture(e.pointerId); } catch {}
      }
      void gesture.end();
      return;
    }

    const drag = dragInfoRef.current;
    if (!drag) return;
    dragInfoRef.current = null;
    const svg = svgRef.current;
    if (svg) {
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {}
    }

    // Puppet Sketch: reduce the raw stream to a few eased keyframes and write
    // them as the pin's position track. One recording = one undo step.
    if (drag.mode === 'sketch') {
      const kfs = sketchRef.current?.finish({ tolerance: sketchTolerance }) ?? [];
      sketchRef.current = null;
      setIsRecording(false);
      if (kfs.length > 0) void sendSketch(drag.pinId, kfs);
      else void gesture.end();
      return;
    }

    void gesture.end();
  };

  /**
   * Puppet Sketch: the reduced keys as ONE batch inside the sketch's gesture —
   * the keys already inside the recorded span go (After Effects' Motion Sketch
   * replaces the keys of the interval it recorded), then the new ones land with
   * their easing.
   */
  const sendSketch = async (pinId: string, kfs: ReadonlyArray<{ t: number; value: Array<{ x: number; y: number }>; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' }>) => {
    const path = rigPaths.pinProp(pinId, 'position');
    const lo = compTime(kfs[0]!.t);
    const hi = compTime(kfs[kfs.length - 1]!.t);
    const res = await engine().query({ type: 'getKeyframes', props: [{ layer: node.id, path }], range: { start: lo, duration: hi - lo } });
    const inSpan = res.ok ? (res.value.sets[0]?.keyframes ?? []).filter((k) => k.time >= lo && k.time <= hi).map((k) => k.id) : [];
    gesture.send([
      ...(inSpan.length > 0 ? [{ type: 'deleteKeyframes' as const, ids: inSpan }] : []),
      {
        type: 'addKeyframes',
        keys: kfs.map((k) => ({
          prop: { layer: node.id, path }, time: compTime(k.t), value: rigValues.vec2(k.value[0]!.x, k.value[0]!.y),
          spatialIn: [], spatialOut: [], ...(k.easing ? { easing: k.easing } : {}),
        })),
      },
    ]);
    await gesture.end();
  };

  const onDoubleClickPin = (e: React.MouseEvent, pinId: string) => {
    e.stopPropagation();
    deletePin(node.id, pinId);
  };

  const onClickOverlay = (e: React.MouseEvent) => {
    // A pointerdown on an existing pin (or a completed drag) sets this guard so
    // the synthetic click that follows pointerup does NOT spawn a stray pin.
    if (suppressClickAddRef.current) {
      suppressClickAddRef.current = false;
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Pin positions are stored in REST space (the puppet solve runs in rest
    // space before the skeleton skins on top) — exactly like the drag path in
    // onPointerMove. Using the raw posed-space coordinate here stored a posed
    // point as a rest point, so on a layer with both a skeleton and pins a new
    // pin landed somewhere other than where you clicked. Identity when the
    // layer has no skeleton.
    const localCoords = toRestSpace(screenToLocal(sx, sy));

    // Click outside layers should not add pins, let's check local bounds
    const halfW = geom.width / 2;
    const halfH = geom.height / 2;
    if (
      localCoords.x < -halfW - pad ||
      localCoords.x > halfW + pad ||
      localCoords.y < -halfH - pad ||
      localCoords.y > halfH + pad
    ) {
      // Clears selection
      setSelectedPinId(null);
      return;
    }

    // Add a new pin — ONE undo entry. The engine mints the id (the lowest free
    // `pin_<n>`, never reused within the document).
    // `localCoords` is where the click landed on the artwork AS DRAWN — the
    // puppet-deformed mesh. A pin's anchor is a REST-space point, so map the
    // click back through the current deformation; the clicked point itself
    // becomes the pin's live position (a keyframe at the current time) so the
    // picture does not move when the pin lands. Identity while no pin has
    // moved: the inverse is the click and no keyframe is written.
    const restPoint = restPointFromDeformed(localCoords, restMesh, puppetDeformed) ?? localCoords;
    const displaced = Math.hypot(restPoint.x - localCoords.x, restPoint.y - localCoords.y) > 1e-3;
    void addPin(restPoint, displaced && puppetPinKind !== 'bend' ? localCoords : null);
  };

  /**
   * addPropertyGroup (the rig is created with the first pin), then — when the
   * mesh is displaced under the click — the pin's Position key at the playhead,
   * so the picture does not move when the pin lands. One gesture = one entry.
   */
  const addPin = async (rest: { x: number; y: number }, live: { x: number; y: number } | null) => {
    const client = engine();
    const label = 'Add Puppet Pin';
    const open = await client.beginGesture(label);
    if (!open.ok) return;
    const res = await client.execute({
      type: 'addPropertyGroup', layer: node.id, parent: rigPaths.pins, matchName: rigMatch.pin,
      init: [
        { path: 'kind', value: rigValues.choice(puppetPinKind) },
        { path: 'restPosition', value: rigValues.vec2(rest.x, rest.y) },
      ],
    });
    const path = res.ok ? (res.value as { groups: string[] }).groups[0] : undefined;
    if (path && live) {
      await client.execute({
        type: 'addKeyframes',
        keys: [{ prop: { layer: node.id, path: `${path}/position` }, time: compTime(time), value: rigValues.vec2(live.x, live.y), spatialIn: [], spatialOut: [] }],
      });
    }
    await client.endGesture(open.value.gesture, true);
    if (path) setSelectedPinId(path.split('/')[2]!);
  };

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'auto',
        zIndex: 10,
        cursor: 'crosshair',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClickOverlay}
    >
      {meshPath && (
        <path
          d={meshPath}
          data-puppet-mesh="true"
          fill="none"
          stroke="rgba(232, 196, 96, 0.55)"
          strokeWidth={1}
          strokeLinecap="butt"
          strokeLinejoin="miter"
          shapeRendering="geometricPrecision"
          pointerEvents="none"
        />
      )}

      {/* ── Selected pin's motion path + spatial tangent handles ──────────
          Drag a handle to arc the pin's trajectory; Alt-drag breaks the point
          so the two sides move independently. */}
      {motionPathD && (
        <path
          d={motionPathD}
          fill="none"
          stroke="#ffc107"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          pointerEvents="none"
          opacity={0.9}
        />
      )}
      {pathHandles.map((h) => {
        const anchor = restToScreen({ x: h.x, y: h.y });
        return (
          <g key={`tan-${selectedPinId}-${h.t}`}>
            {/* Keyframe marker on the path */}
            <rect
              x={anchor.x - 3}
              y={anchor.y - 3}
              width={6}
              height={6}
              transform={`rotate(45 ${anchor.x} ${anchor.y})`}
              fill="#ffc107"
              stroke="#ffffff"
              strokeWidth={1}
              pointerEvents="none"
            />
            {(['out', 'in'] as const).map((which) => {
              const hp = which === 'out' ? h.out : h.in;
              if (!hp) return null;
              const s = restToScreen(hp);
              return (
                <g
                  key={which}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => onPointerDownTangent(e, selectedPinId!, pathHandles.indexOf(h), which)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <line
                    x1={anchor.x}
                    y1={anchor.y}
                    x2={s.x}
                    y2={s.y}
                    stroke="#ffc107"
                    strokeWidth={1}
                    opacity={0.7}
                    pointerEvents="none"
                  />
                  {/* Fat invisible hit area so the small dot is grabbable */}
                  <circle cx={s.x} cy={s.y} r={10} fill="transparent" />
                  <circle cx={s.x} cy={s.y} r={3.5} fill="#ffffff" stroke="#ffc107" strokeWidth={1.5} />
                </g>
              );
            })}
          </g>
        );
      })}

      {/* Render pin dots */}
      {pins.map((pin) => {
        const animPin = animatedPins.find((p) => p.id === pin.id) ?? pin;
        const kind = pinKindOf(pin);
        const color = pinColor(kind);
        const isBendPin = kind === 'bend';
        // Draw the handle where the mesh actually IS, not where it rests.
        //
        // Pin positions are stored in REST space (the puppet solve runs before
        // the skeleton skins on top), so on a layer with both rigs the dot sat
        // off the mesh it controls. `skinPointAt` exists for exactly this — its
        // docstring says "so a puppet pin's dot lands on the composed mesh" —
        // and it had no callers.
        //
        // A bend pin has no rest position worth drawing: its whole point is that
        // it sits wherever the other pins carried it. Read that back out of the
        // solved mesh at the vertex the pin is bound to, so the dot travels with
        // the deformation. Drawn at its rest anchor it would sit off the artwork
        // the moment anything moved, and the control would read as broken.
        const bendVertex = isBendPin ? restMesh.pinVertexIndices[pin.id] : undefined;
        const anchor =
          bendVertex !== undefined && deformedVertices.length >= bendVertex * 4 + 2
            ? { x: deformedVertices[bendVertex * 4 + 0]!, y: deformedVertices[bendVertex * 4 + 1]! }
            : { x: animPin.x, y: animPin.y };
        const posed = skelBinding && skelPoseWorld
          ? skinPointAt(anchor, anchor, skelBinding, skelPoseWorld)
          : anchor;
        const screen = localToScreen(posed.x, posed.y);
        const isSelected = selectedPinId === pin.id;
        const isHovered = hoveredPinId === pin.id;

        return (
          <g
            key={`pin-g-${pin.id}`}
            style={{ cursor: 'pointer' }}
            onPointerDown={(e) => onPointerDownPin(e, pin.id)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => onDoubleClickPin(e, pin.id)}
            onMouseEnter={() => setHoveredPinId(pin.id)}
            onMouseLeave={() => setHoveredPinId(null)}
          >
            {/* Outer ring for highlight */}
            {(isSelected || isHovered) && (
              <circle
                cx={screen.x}
                cy={screen.y}
                r={10}
                fill="none"
                stroke={isSelected ? color : `${color}80`}
                strokeWidth={2}
              />
            )}
            {/* Rotation indicator (Alt-drag a pin to rotate its influence) */}
            {(animPin.rotation ?? 0) !== 0 && (
              <line
                x1={screen.x}
                y1={screen.y}
                x2={screen.x + 14 * Math.cos(((animPin.rotation ?? 0) * Math.PI) / 180)}
                y2={screen.y + 14 * Math.sin(((animPin.rotation ?? 0) * Math.PI) / 180)}
                stroke={isSelected ? color : color}
                strokeWidth={2}
              />
            )}
            {/* Core dot. Bend pins are hollow; the other four tools are solid
                circles in AE's colours so they are readable at a glance. */}
            <circle
              cx={screen.x}
              cy={screen.y}
              r={5}
              fill={isBendPin ? 'none' : color}
              stroke={isBendPin ? color : '#ffffff'}
              strokeWidth={isBendPin ? 2.5 : 1.5}
            />

            {/* Advanced / Bend gizmo — AE's rotate ring + scale square. Position,
                Starch and Overlap pins only move. */}
            {isSelected && pinHasTransformGizmo(kind) && (
              <g>
                <circle
                  cx={screen.x} cy={screen.y} r={GIZMO_R}
                  fill="none" stroke={color} strokeWidth={1} opacity={0.55}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    // Dragging the ring rotates — reuse the rotate sub-mode.
                    const synthetic = { ...e, altKey: true } as React.PointerEvent;
                    onPointerDownPin(synthetic, pin.id);
                  }}
                />
                <rect
                  x={screen.x + GIZMO_R - 4} y={screen.y - 4} width={8} height={8}
                  fill="#ffffff" stroke={color} strokeWidth={1.5}
                  style={{ cursor: 'nwse-resize' }}
                  onPointerDown={(e) => onPointerDownScale(e, pin.id)}
                />
                {(animPin.scale ?? 1) !== 1 && (
                  <text
                    x={screen.x + GIZMO_R + 8} y={screen.y + 4}
                    fontSize={10} fill={color} style={{ userSelect: 'none' }}
                    pointerEvents="none"
                  >
                    {(animPin.scale ?? 1).toFixed(2)}x
                  </text>
                )}
              </g>
            )}
          </g>
        );
      })}

      {/* ── Puppet Sketch (3A) ───────────────────────────────────────────
          Ctrl/Cmd-drag a pin to record its motion live; on release the stream
          is reduced to a few eased keyframes. Tolerance controls how hard that
          reduction bites — the difference between usable and a keyframe swamp. */}
      {isRecording ? (
        <g pointerEvents="none">
          <circle cx={20} cy={20} r={6} fill="#ff3b30" />
          <text x={34} y={24} fontSize={12} fill="#ff3b30" style={{ userSelect: 'none' }}>
            Recording — release to reduce to keyframes
          </text>
        </g>
      ) : (
        pins.length > 0 && (
          <g transform="translate(12, 12)" onPointerDown={(e) => e.stopPropagation()}>
            <text x={0} y={12} fontSize={10} fill="rgba(255,255,255,0.7)" style={{ userSelect: 'none' }}>
              Ctrl-drag a pin to sketch · tolerance {sketchTolerance}px
            </text>
            {([-1, 1] as const).map((dir, i) => (
              <g
                key={dir}
                style={{ cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSketchTolerance((t) => Math.max(0.5, Math.min(40, +(t + dir * 0.5).toFixed(1))));
                }}
              >
                <rect x={i * 24} y={20} width={20} height={18} rx={4} fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.25)" />
                <text x={i * 24 + 10} y={33} textAnchor="middle" fontSize={12} fill="#fff" style={{ userSelect: 'none' }}>
                  {dir < 0 ? '−' : '+'}
                </text>
              </g>
            ))}
          </g>
        )
      )}
    </svg>
  );
}
