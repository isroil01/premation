import React, { useEffect, useState, useRef } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry, worldMatrix } from '@core/workspace/geometry';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { bumpScene } from '@stores/sceneStore';

import { computeWorldTransforms, boneRoot, boneTip, type Bone } from '@core/rig/skeleton';
import { readNodeSkeleton, addBone, deleteBone } from '@core/rig/skeletonCommands';

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

export function BoneOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const selectedNodeId = useSelectionStore((s) => s.ids[0]);
  const activeWorkspace = useActiveWorkspace();
  const time = activeWorkspace?.time ?? 0;

  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [hoveredBoneId, setHoveredBoneId] = useState<string | null>(null);

  const dragInfoRef = useRef<{
    boneId: string;
    startScreen: { x: number; y: number };
    animTx: any;
    startRotationDeg: number;
    startLocal: { x: number; y: number };
    isIkTarget?: boolean;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  // Force re-render on workspace render ticks
  const [, setTick] = useState(0);
  useEffect(() => {
    const controller = getWorkspaceController();
    controller.onRender(() => setTick((t) => t + 1));
  }, []);

  // Keyboard listener to delete selected bone
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTool !== 'bone' || !selectedNodeId || !selectedBoneId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteBone(selectedNodeId, selectedBoneId);
        setSelectedBoneId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, selectedNodeId, selectedBoneId]);

  if (activeTool !== 'bone' || !selectedNodeId) return null;

  const node = defaultSceneGraph.getNode(selectedNodeId);
  if (!node) return null;

  const geom = readGeometry(node);
  if (!geom) return null;

  const skel = readNodeSkeleton(node);
  const bones = skel?.bones ?? [];
  const ikTargets = skel?.ikTargets ?? [];

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

  const layerT = getRemappedTime(node.id, time);

  // Evaluate live animated bone poses
  const animatedBones: Bone[] = bones.map((b) => {
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

  const worldTransforms = computeWorldTransforms({ bones: animatedBones });

  // Pointer drag operations
  const onPointerDownBone = (e: React.PointerEvent, boneId: string) => {
    e.stopPropagation();
    setSelectedBoneId(boneId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const bone = animatedBones.find((b) => b.id === boneId);

    const animTx = beginAnimEdit();
    dragInfoRef.current = {
      boneId,
      startScreen,
      animTx,
      startRotationDeg: bone?.rotation ?? 0,
      startLocal: screenToLocal(startScreen.x, startScreen.y),
    };
    svg.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragInfoRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const currentScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const local = screenToLocal(currentScreen.x, currentScreen.y);

    const bone = animatedBones.find((b) => b.id === drag.boneId);
    if (!bone) return;

    // Check if bone is part of an IK chain or simple FK rotation
    const parentBone = animatedBones.find((b) => b.id === bone.parentId);
    if (parentBone) {
      // Rotate around parent root / origin
      const pMat = worldTransforms.get(parentBone.id);
      const pRoot = pMat ? boneRoot(pMat) : { x: 0, y: 0 };
      const startAngle = Math.atan2(drag.startLocal.y - pRoot.y, drag.startLocal.x - pRoot.x);
      const currAngle = Math.atan2(local.y - pRoot.y, local.x - pRoot.x);
      const deltaDeg = ((currAngle - startAngle) * 180) / Math.PI;
      const newRot = drag.startRotationDeg + deltaDeg;

      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.rotation`, layerT, newRot);
    } else {
      // Root bone translation or rotation
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.x`, layerT, local.x);
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.y`, layerT, local.y);
    }

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
    recordAnimEdit(drag.animTx.commit(`Pose Bone ${drag.boneId}`));
    bumpScene();
  };

  const onClickOverlay = (e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const local = screenToLocal(e.clientX - rect.left, e.clientY - rect.top);

    // If clicking outside existing bones, add a new bone
    const newBoneId = `bone_${Date.now().toString(36).slice(2, 6)}`;
    const parentId = selectedBoneId;
    let parentRoot = { x: 0, y: 0 };

    if (parentId) {
      const pMat = worldTransforms.get(parentId);
      if (pMat) parentRoot = boneRoot(pMat);
    }

    const dx = local.x - parentRoot.x;
    const dy = local.y - parentRoot.y;
    const length = Math.max(20, Math.hypot(dx, dy));
    const rotation = (Math.atan2(dy, dx) * 180) / Math.PI;

    const newBone: Bone = {
      id: newBoneId,
      parentId,
      length,
      x: parentId ? 0 : local.x,
      y: parentId ? 0 : local.y,
      rotation: parentId ? rotation : 0,
    };

    addBone(node.id, newBone);
    setSelectedBoneId(newBoneId);
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
      {/* Draw bone shapes and joint connections */}
      {animatedBones.map((b) => {
        const mat = worldTransforms.get(b.id);
        if (!mat) return null;
        const rootPos = boneRoot(mat);
        const tipPos = boneTip(mat, b.length);

        const rScreen = localToScreen(rootPos.x, rootPos.y);
        const tScreen = localToScreen(tipPos.x, tipPos.y);

        const isSelected = selectedBoneId === b.id;
        const isHovered = hoveredBoneId === b.id;

        // Draw bone body polygon (tapered bone shape)
        const dx = tScreen.x - rScreen.x;
        const dy = tScreen.y - rScreen.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const w = Math.min(12, Math.max(4, len * 0.15));

        const side1 = { x: rScreen.x + nx * w + dx * 0.2, y: rScreen.y + ny * w + dy * 0.2 };
        const side2 = { x: rScreen.x - nx * w + dx * 0.2, y: rScreen.y - ny * w + dy * 0.2 };

        const polyPoints = `${rScreen.x},${rScreen.y} ${side1.x},${side1.y} ${tScreen.x},${tScreen.y} ${side2.x},${side2.y}`;

        return (
          <g
            key={`bone-${b.id}`}
            style={{ cursor: 'pointer' }}
            onPointerDown={(e) => onPointerDownBone(e, b.id)}
            onMouseEnter={() => setHoveredBoneId(b.id)}
            onMouseLeave={() => setHoveredBoneId(null)}
          >
            {/* Bone polygon */}
            <polygon
              points={polyPoints}
              fill={isSelected ? 'rgba(43, 126, 255, 0.45)' : isHovered ? 'rgba(0, 230, 153, 0.35)' : 'rgba(255, 170, 0, 0.25)'}
              stroke={isSelected ? '#2b7eff' : isHovered ? '#00e699' : '#ffaa00'}
              strokeWidth={1.5}
            />

            {/* Bone root joint circle */}
            <circle
              cx={rScreen.x}
              cy={rScreen.y}
              r={6}
              fill={isSelected ? '#2b7eff' : '#ffaa00'}
              stroke="#ffffff"
              strokeWidth={1.5}
            />

            {/* Bone tip circle */}
            <circle
              cx={tScreen.x}
              cy={tScreen.y}
              r={4}
              fill={isSelected ? '#2b7eff' : '#00e699'}
              stroke="#ffffff"
              strokeWidth={1}
            />
          </g>
        );
      })}

      {/* Draw IK target markers */}
      {ikTargets.filter((t) => t.enabled !== false).map((t) => {
        const mat = worldTransforms.get(t.boneId);
        if (!mat) return null;
        const rootPos = boneRoot(mat);
        const tScreen = localToScreen(rootPos.x + t.x, rootPos.y + t.y);
        return (
          <g key={`ik-${t.boneId}`}>
            <circle cx={tScreen.x} cy={tScreen.y} r={8} fill="none" stroke="#ff0055" strokeWidth={2} />
            <line x1={tScreen.x - 10} y1={tScreen.y} x2={tScreen.x + 10} y2={tScreen.y} stroke="#ff0055" strokeWidth={1.5} />
            <line x1={tScreen.x} y1={tScreen.y - 10} x2={tScreen.x} y2={tScreen.y + 10} stroke="#ff0055" strokeWidth={1.5} />
          </g>
        );
      })}
    </svg>
  );
}
