import React, { useEffect, useState, useRef } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry, worldMatrix } from '@core/workspace/geometry';
import { rasterPadding } from '@core/rendering/raster/vectorDraw';
import { readNodePuppet, getCachedRestMesh, deform, silhouetteFromPathPoints, PuppetPin } from '@core/rig/puppet';
import { addPuppetPin, deletePuppetPin } from '@core/rig/puppetCommands';
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
import { upsertDataKeyframe } from '@motion/animation';
import { bumpScene } from '@stores/sceneStore';

// Invert 2D affine matrix mapping
function worldToLocal(m: any, w: { x: number; y: number }): { x: number; y: number } {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-6) return { x: 0, y: 0 };
  const invA = m.d / det;
  const invB = -m.b / det;
  const invC = -m.c / det;
  const invD = m.a / det;
  const invE = (m.c * m.f - m.d * m.e) / det;
  const invF = (m.b * m.e - m.a * m.f) / det;
  return {
    x: invA * w.x + invC * w.y + invE,
    y: invB * w.x + invD * w.y + invF,
  };
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

  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);
  const dragInfoRef = useRef<{
    pinId: string;
    startScreen: { x: number; y: number };
    animTx: any;
    /** Alt-drag rotates the pin's influence instead of translating it. */
    mode: 'move' | 'rotate';
    startAngleDeg: number;
    startRotationDeg: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Drag/element-origin guard: pointerup synthesizes a click even after a drag
  // (stopPropagation on pointerdown does NOT stop it), so every pin drag-release
  // used to also spawn a stray pin. Any pointerdown on an existing pin, any
  // completed drag, or travel past the slop suppresses the click-add.
  const suppressClickAddRef = useRef(false);


  // Force re-render on render ticks / camera movements
  const [, setTick] = useState(0);
  useEffect(() => {
    const controller = getWorkspaceController();
    controller.onRender(() => {
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
  const m = worldMatrix(geom);
  const controller = getWorkspaceController();
  const camera = controller.ws.camera;

  const localToScreen = (lx: number, ly: number) => {
    const wx = m.a * lx + m.c * ly + m.e;
    const wy = m.b * lx + m.d * ly + m.f;
    return camera.worldToScreen({ x: wx, y: wy });
  };

  const screenToLocal = (sx: number, sy: number) => {
    const world = camera.screenToWorld({ x: sx, y: sy });
    return worldToLocal(m, world);
  };

  // Build the rest mesh and deformed mesh for wireframe rendering. The static
  // path outline (Geometry component) mirrors buildSnapshot's silhouette so the
  // wireframe matches the rendered mesh for shape layers.
  const geometryComponent = node.components.find((c) => c.type === 'Geometry');
  const silhouette = silhouetteFromPathPoints(
    geometryComponent?.props.points as Array<{ x: number; y: number }> | undefined,
    geometryComponent?.props.open === true,
  );
  const restMesh = getCachedRestMesh(
    node.id,
    geom.width,
    geom.height,
    pad,
    puppetRig ?? { pins: [] },
    silhouette
  );

  // Canonical keyframe axis — the same forward map buildSnapshot samples.
  const layerT = compToKeyframeTime(node.id, time);

  const animatedPins = pins.map((pin) => {
    const livePos = defaultAnimation.sampleData(node.id, `puppet.${pin.id}.position`, layerT);
    let px = pin.x;
    let py = pin.y;
    if (Array.isArray(livePos) && livePos.length > 0 && livePos[0] && typeof livePos[0] === 'object' && 'x' in livePos[0]) {
      const pt = livePos[0] as { x: number; y: number };
      px = pt.x;
      py = pt.y;
    }
    const liveRot = defaultAnimation.sample(node.id, `puppet.${pin.id}.rotation`, layerT);
    const liveStiff = defaultAnimation.sample(node.id, `puppet.${pin.id}.stiffness`, layerT);
    return {
      id: pin.id,
      x: px,
      y: py,
      rotation: typeof liveRot === 'number' ? liveRot : pin.rotation,
      stiffness: typeof liveStiff === 'number' ? liveStiff : pin.stiffness,
    };
  });

  let deformedVertices = deform(animatedPins, restMesh, puppetRig?.solver ?? 'arap');

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

  // Pointer drag operations
  const onPointerDownPin = (e: React.PointerEvent, pinId: string) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    setSelectedPinId(pinId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Alt-drag = rotate sub-mode (AE-style: rotate the deformation around the
    // pin). Plain drag = move.
    const mode: 'move' | 'rotate' = e.altKey ? 'rotate' : 'move';
    let startAngleDeg = 0;
    let startRotationDeg = 0;
    if (mode === 'rotate') {
      const animPin = animatedPins.find((p) => p.id === pinId);
      const local = toRestSpace(screenToLocal(startScreen.x, startScreen.y));
      const cx = animPin?.x ?? 0;
      const cy = animPin?.y ?? 0;
      startAngleDeg = (Math.atan2(local.y - cy, local.x - cx) * 180) / Math.PI;
      startRotationDeg = animPin?.rotation ?? 0;
    }

    // Begin drag undo-redo transaction
    const animTx = beginAnimEdit();
    dragInfoRef.current = { pinId, startScreen, animTx, mode, startAngleDeg, startRotationDeg };
    svg.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
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
      const animPin = animatedPins.find((p) => p.id === drag.pinId);
      const cx = animPin?.x ?? 0;
      const cy = animPin?.y ?? 0;
      const angleDeg = (Math.atan2(localCoords.y - cy, localCoords.x - cx) * 180) / Math.PI;
      const rotation = drag.startRotationDeg + (angleDeg - drag.startAngleDeg);
      defaultAnimation.setKeyframe(node.id, `puppet.${drag.pinId}.rotation`, layerT, rotation);
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
    const drag = dragInfoRef.current;
    if (!drag) return;
    dragInfoRef.current = null;
    const svg = svgRef.current;
    if (svg) {
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {}
    }

    // Commit transaction to history
    recordAnimEdit(
      drag.animTx.commit(
        drag.mode === 'rotate' ? `Rotate Puppet Pin ${drag.pinId}` : `Move Puppet Pin ${drag.pinId}`,
      ),
    );
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

    const localCoords = screenToLocal(sx, sy);

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
    const pinId = `pin_${Date.now()}`;
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

      {/* Render pin dots */}
      {pins.map((pin) => {
        const animPin = animatedPins.find((p) => p.id === pin.id) ?? pin;
        // Draw the handle where the mesh actually IS, not where it rests.
        //
        // Pin positions are stored in REST space (the puppet solve runs before
        // the skeleton skins on top), so on a layer with both rigs the dot sat
        // off the mesh it controls. `skinPointAt` exists for exactly this — its
        // docstring says "so a puppet pin's dot lands on the composed mesh" —
        // and it had no callers.
        const posed = skelBinding && skelPoseWorld
          ? skinPointAt({ x: animPin.x, y: animPin.y }, { x: animPin.x, y: animPin.y }, skelBinding, skelPoseWorld)
          : { x: animPin.x, y: animPin.y };
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
            {/* Core dot */}
            <circle
              cx={screen.x}
              cy={screen.y}
              r={5}
              fill={isSelected ? '#ffc107' : '#00bfff'}
              stroke="#ffffff"
              strokeWidth={1.5}
            />
          </g>
        );
      })}
    </svg>
  );
}
