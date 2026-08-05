import React, { useEffect, useState, useRef } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { layerScreenMapping } from './layerScreen';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry } from '@core/workspace/geometry';
import { rasterPadding } from '@core/rendering/raster/vectorDraw';
import { readNodePuppet, getCachedRestMesh, deform, silhouetteFromPathPoints, PuppetPin } from '@core/rig/puppet';
import { resolveLivePins } from '@core/rig/livePins';
import { rigCoverageMask, rigLayerKind, readNodeMediaRef, resolveRigImageSrc } from '@core/rig/rigMeshInputs';
import { readNodeKind } from '@core/scene/sceneDerive';
import { useAssetStore } from '@stores/assetStore';
import { addPuppetPin, deletePuppetPin } from '@core/rig/puppetCommands';
import { nextRigId, usedRigIds } from '@core/rig/rigIds';
import { SketchRecorder, DEFAULT_SKETCH_TOLERANCE } from '@core/rig/puppetSketch';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { computeWorldTransforms, type Bone } from '@core/rig/skeleton';
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
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { upsertDataKeyframe, dataPathTangents, setDataSpatialTangent } from '@motion/animation';
import { bumpScene } from '@stores/sceneStore';

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

function getHeatmapColor(weight: number): string {
  // Map weight 0..1 to blue -> green/yellow -> red
  const r = Math.round(Math.min(255, Math.max(0, (weight - 0.5) * 2 * 255)));
  const g = Math.round(Math.min(255, Math.max(0, (1 - Math.abs(weight - 0.5) * 2) * 255)));
  const b = Math.round(Math.min(255, Math.max(0, (0.5 - weight) * 2 * 255)));
  return `rgba(${r}, ${g}, ${b}, 0.45)`;
}

export function PuppetOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const selectedNodeId = useSelectionStore((s) => s.ids[0]);
  const activeWorkspace = useActiveWorkspace();
  const time = activeWorkspace?.time ?? 0;
  const comp = useCompositionStore((s) => s.comp());

  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);
  const dragInfoRef = useRef<{
    pinId: string;
    startScreen: { x: number; y: number };
    animTx: any;
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
    kfT: number;
    which: 'in' | 'out';
    animTx: any;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Drag/element-origin guard: pointerup synthesizes a click even after a drag
  // (stopPropagation on pointerdown does NOT stop it), so every pin drag-release
  // used to also spawn a stray pin. Any pointerdown on an existing pin, any
  // completed drag, or travel past the slop suppresses the click-add.
  const suppressClickAddRef = useRef(false);


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
  }, [activeTool, selectedNodeId, selectedPinId]);

  if (activeTool !== 'puppet-pin' || !selectedNodeId) return null;

  const node = defaultSceneGraph.getNode(selectedNodeId);
  if (!node) return null;

  const geom = readGeometry(node);
  if (!geom) return null;

  const puppetRig = readNodePuppet(node);
  const pins = puppetRig?.pins ?? [];

  // Construct dummy layer for padding extraction
  const dummyLayer: any = {
    kind: geom.ellipse ? 'shape' : 'rect',
    stroke: node.components.find((c) => c.type === 'Stroke')?.props.stroke,
    strokes: node.components.find((c) => c.type === 'Strokes')?.props.strokes,
    paint: node.components.find((c) => c.type === 'Paint')?.props.paint,
  };
  const pad = rasterPadding(dummyLayer);
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

  // Canonical keyframe axis — the same forward map buildSnapshot samples.
  const layerT = compToKeyframeTime(node.id, time);

  // Build the rest mesh and deformed mesh for wireframe rendering. The static
  // path outline (Geometry component) mirrors buildSnapshot's silhouette so the
  // wireframe matches the rendered mesh for shape layers.
  const geometryComponent = node.components.find((c) => c.type === 'Geometry');
  const silhouette = silhouetteFromPathPoints(
    geometryComponent?.props.points as Array<{ x: number; y: number }> | undefined,
    geometryComponent?.props.open === true,
  );
  // Image layers cull the mesh against the bitmap's alpha, exactly as
  // buildSnapshot does. Omitting this drew an untrimmed bbox grid over an
  // alpha-culled render — a different vertex count, different weights, and a
  // weight heatmap that described a mesh nobody was drawing. Both sides resolve
  // the source and the mask through rigMeshInputs so they cannot drift again.
  const media = readNodeMediaRef(node);
  const coverage = rigCoverageMask(
    rigLayerKind(readNodeKind(node)),
    resolveRigImageSrc(node, readNodeKind(node), media, layerT, (id) =>
      useAssetStore.getState().assets.find((asset) => asset.id === id),
    ),
    media.assetId,
    silhouette,
  );
  const restMesh = getCachedRestMesh(
    node.id,
    geom.width,
    geom.height,
    pad,
    puppetRig ?? { pins: [] },
    silhouette,
    coverage,
  );

  // Shared with buildSnapshot — see `livePins.ts` for why this is not written
  // out here a second time.
  const animatedPins = resolveLivePins(pins, node.id, layerT, defaultAnimation);

  let deformedVertices = deform(
    animatedPins, restMesh, puppetRig?.solver ?? 'arap', puppetRig?.maxRotationDeg,
  );

  // Skeleton composition preview — mirror buildSnapshot exactly: when the layer
  // also carries a skeleton, the puppet solve stays in REST space and the
  // skeleton skinning (FK + IK) poses the puppet-refined mesh on top. Pins are
  // authored/stored in rest space; pointer input is mapped back via unskinPoint.
  const skel = readNodeSkeleton(node);
  let skelBinding: SkeletonBinding | null = null;
  let skelPoseWorld: Map<string, Mat2D> | null = null;
  if (skel && skel.bones.length > 0) {
    const animatedBones: Bone[] = skel.bones.map((b) => {
      const liveRot = defaultAnimation.sample(node.id, `bone.${b.id}.rotation`, layerT);
      const liveX = defaultAnimation.sample(node.id, `bone.${b.id}.x`, layerT);
      const liveY = defaultAnimation.sample(node.id, `bone.${b.id}.y`, layerT);
      return {
        ...b,
        rotation: typeof liveRot === 'number' ? liveRot : b.rotation,
        x: typeof liveX === 'number' ? liveX : b.x,
        y: typeof liveY === 'number' ? liveY : b.y,
      };
    });
    const activeIk: IkTargetResolved[] = (skel.ikTargets ?? [])
      .filter((tg) => tg.enabled !== false)
      .map((tg) => {
        const liveX = defaultAnimation.sample(node.id, `ikTarget.${tg.boneId}.x`, layerT);
        const liveY = defaultAnimation.sample(node.id, `ikTarget.${tg.boneId}.y`, layerT);
        return {
          boneId: tg.boneId,
          x: typeof liveX === 'number' ? liveX : tg.x,
          y: typeof liveY === 'number' ? liveY : tg.y,
          chainLength: tg.chainLength,
        };
      });
    const posedBones = applyIk(animatedBones, activeIk);
    skelPoseWorld = computeWorldTransforms({ bones: posedBones });
    skelBinding = getSkeletonBinding(restMesh, skel.bones);
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

  // Render triangulation polygons
  const polygons: JSX.Element[] = [];
  const vertices = deformedVertices;
  const triangles = restMesh.triangles;

  for (let i = 0; i < triangles.length; i += 3) {
    const i0 = triangles[i]!;
    const i1 = triangles[i + 1]!;
    const i2 = triangles[i + 2]!;

    const s0 = localToScreen(vertices[i0 * 4 + 0]!, vertices[i0 * 4 + 1]!);
    const s1 = localToScreen(vertices[i1 * 4 + 0]!, vertices[i1 * 4 + 1]!);
    const s2 = localToScreen(vertices[i2 * 4 + 0]!, vertices[i2 * 4 + 1]!);

    let fill = 'rgba(0, 191, 255, 0.04)';
    if (selectedPinId && restMesh.weights[selectedPinId]) {
      const w0 = restMesh.weights[selectedPinId]![i0] ?? 0;
      const w1 = restMesh.weights[selectedPinId]![i1] ?? 0;
      const w2 = restMesh.weights[selectedPinId]![i2] ?? 0;
      const avgWeight = (w0 + w1 + w2) / 3;
      fill = getHeatmapColor(avgWeight);
    }

    polygons.push(
      <polygon
        key={`tri-${i}`}
        points={`${s0.x},${s0.y} ${s1.x},${s1.y} ${s2.x},${s2.y}`}
        stroke="rgba(0, 191, 255, 0.25)"
        strokeWidth={1}
        fill={fill}
      />
    );
  }

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

    // Begin drag undo-redo transaction
    const animTx = beginAnimEdit();
    dragInfoRef.current = { pinId, startScreen, animTx, mode, startAngleDeg, startRotationDeg };
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
      animTx: beginAnimEdit(),
      mode: 'scale',
      startAngleDeg: 0,
      startRotationDeg: 0,
      startDist: Math.max(1e-3, Math.hypot(local.x - c.x, local.y - c.y)),
      startScale: animPin?.scale ?? 1,
    };
    capturePointer(svg, e.pointerId);
  };

  /** Grab a spatial tangent handle on the selected pin's motion path. */
  const onPointerDownTangent = (
    e: React.PointerEvent,
    pinId: string,
    kfT: number,
    which: 'in' | 'out',
  ) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    const svg = svgRef.current;
    if (!svg) return;
    tangentDragRef.current = { pinId, kfT, which, animTx: beginAnimEdit() };
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
      const prop = `puppet.${tan.pinId}.position`;
      const track = defaultAnimation.getDataTrack(node.id, prop);
      if (!track) return;
      // Plain drag mirrors the opposite handle (a smooth point, the AE default);
      // Alt breaks the point so the two sides move independently.
      const keyframes = setDataSpatialTangent(
        track.keyframes, tan.kfT, 0, tan.which, handle, !e.altKey,
      );
      defaultAnimation.setDataTrack(node.id, prop, { ...track, keyframes });
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
      defaultAnimation.setKeyframe(node.id, `puppet.${drag.pinId}.rotation`, layerT, rotation);
      controller.requestRender();
      return;
    }

    if (drag.mode === 'scale') {
      const c = pinRotationCenter(drag.pinId);
      const d = Math.hypot(localCoords.x - c.x, localCoords.y - c.y);
      let scale = (drag.startScale ?? 1) * (d / (drag.startDist ?? 1));
      // Shift constrains scale to 5% steps, matching AE's gizmo.
      if (e.shiftKey) scale = Math.round(scale * 20) / 20;
      defaultAnimation.setKeyframe(
        node.id, `puppet.${drag.pinId}.scale`, layerT, Math.max(0.01, scale),
      );
      controller.requestRender();
      return;
    }

    if (drag.mode === 'sketch') {
      // Record against the LIVE playhead so the captured path is spread across
      // real time rather than collapsing onto one frame.
      sketchRef.current?.add(localCoords.x, localCoords.y, compToKeyframeTime(node.id, time));
      controller.requestRender();
      return;
    }

    // Live update the pin position in the animation engine directly
    const track = defaultAnimation.getDataTrack(node.id, `puppet.${drag.pinId}.position`) || {
      nodeId: node.id,
      prop: `puppet.${drag.pinId}.position`,
      kind: 'points',
      keyframes: [],
    };
    const value = [{ x: localCoords.x, y: localCoords.y }];
    const updatedKeyframes = upsertDataKeyframe(track.keyframes, { t: layerT, value });
    defaultAnimation.setDataTrack(node.id, `puppet.${drag.pinId}.position`, {
      ...track,
      keyframes: updatedKeyframes,
    });

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
      recordAnimEdit(tan.animTx.commit(`Curve Puppet Pin Path ${tan.pinId}`));
      bumpScene();
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
      if (kfs.length > 0) {
        const prop = `puppet.${drag.pinId}.position`;
        const existing = defaultAnimation.getDataTrack(node.id, prop);
        defaultAnimation.setDataTrack(node.id, prop, {
          nodeId: node.id,
          prop,
          kind: 'points',
          ...(existing ?? {}),
          keyframes: kfs.map((k) => ({ t: k.t, value: k.value, easing: k.easing })),
        } as never);
      }
      recordAnimEdit(drag.animTx.commit(`Sketch Puppet Pin ${drag.pinId}`));
      bumpScene();
      return;
    }

    // Commit transaction to history
    const label =
      drag.mode === 'rotate' ? `Rotate Puppet Pin ${drag.pinId}`
        : drag.mode === 'scale' ? `Scale Puppet Pin ${drag.pinId}`
        : `Move Puppet Pin ${drag.pinId}`;
    recordAnimEdit(drag.animTx.commit(label));
    bumpScene();
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

    // Add a new pin — one undoable command (PuppetEditCommand).
    // Id is the lowest free ordinal for this rig, NOT a timestamp: two pins
    // placed in the same millisecond used to collide and share one set of
    // animation tracks.
    const pinId = nextRigId('pin_', usedRigIds(pins));
    const newPin: PuppetPin = {
      id: pinId,
      name: `Pin ${pins.length + 1}`,
      x: localCoords.x,
      y: localCoords.y,
    };
    addPuppetPin(node.id, newPin);
    setSelectedPinId(pinId);
  };

  const deletePin = (nodeId: string, pinId: string) => {
    // One undoable command: removes the pin AND its animation tracks
    // (position/rotation/stiffness); undo restores both.
    deletePuppetPin(nodeId, pinId);
    if (selectedPinId === pinId) setSelectedPinId(null);
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
      {polygons}

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
                  onPointerDown={(e) => onPointerDownTangent(e, selectedPinId!, h.t, which)}
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
        const isBendPin = pin.kind === 'bend';
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
                stroke={isSelected ? '#ffc107' : 'rgba(255, 193, 7, 0.5)'}
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
                stroke={isSelected ? '#ffc107' : '#00bfff'}
                strokeWidth={2}
              />
            )}
            {/* Core dot. A bend pin is HOLLOW and green — it has to be tellable
                apart from an advanced pin at a glance, because the two respond
                to the same drag in different ways. */}
            <circle
              cx={screen.x}
              cy={screen.y}
              r={5}
              fill={isBendPin ? 'none' : isSelected ? '#ffc107' : '#00bfff'}
              stroke={isBendPin ? (isSelected ? '#ffc107' : '#7ee787') : '#ffffff'}
              strokeWidth={isBendPin ? 2.5 : 1.5}
            />

            {/* ── Advanced-pin gizmo (3B) ────────────────────────────────
                AE's shape: an outer circle you drag to rotate, plus one square
                handle you drag to scale. Shift constrains rotation to 15° and
                scale to 5%. Shown on the selected pin only. */}
            {isSelected && (
              <g>
                <circle
                  cx={screen.x} cy={screen.y} r={GIZMO_R}
                  fill="none" stroke="#ffc107" strokeWidth={1} opacity={0.55}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    // Dragging the ring rotates — reuse the rotate sub-mode.
                    const synthetic = { ...e, altKey: true } as React.PointerEvent;
                    onPointerDownPin(synthetic, pin.id);
                  }}
                />
                <rect
                  x={screen.x + GIZMO_R - 4} y={screen.y - 4} width={8} height={8}
                  fill="#ffffff" stroke="#ffc107" strokeWidth={1.5}
                  style={{ cursor: 'nwse-resize' }}
                  onPointerDown={(e) => onPointerDownScale(e, pin.id)}
                />
                {(animPin.scale ?? 1) !== 1 && (
                  <text
                    x={screen.x + GIZMO_R + 8} y={screen.y + 4}
                    fontSize={10} fill="#ffc107" style={{ userSelect: 'none' }}
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
