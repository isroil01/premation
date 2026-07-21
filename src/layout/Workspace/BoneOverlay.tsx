import React, { useEffect, useState, useRef } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry, worldMatrix } from '@core/workspace/geometry';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { bumpScene } from '@stores/sceneStore';

import { computeWorldTransforms, boneRoot, boneTip, type Bone } from '@core/rig/skeleton';
import { angleOf } from '@core/rig/mat2d';
import { applyIk, ikChainIds, type IkTargetResolved } from '@core/rig/rigDeform';
import { readNodeSkeleton, addBone, deleteBone, setIKTarget } from '@core/rig/skeletonCommands';

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

/** Pointer travel (screen px) below which a down→up pair still counts as a click. */
const CLICK_SLOP_PX = 3;

export function BoneOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const selectedNodeId = useSelectionStore((s) => s.ids[0]);
  const activeWorkspace = useActiveWorkspace();
  const time = activeWorkspace?.time ?? 0;

  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [hoveredBoneId, setHoveredBoneId] = useState<string | null>(null);

  const dragInfoRef = useRef<{
    /** 'fk' rotates/translates the bone; 'ik' drags an IK target (also the mode
     *  a bone drag redirects to when the bone sits in an active IK chain). */
    kind: 'fk' | 'ik';
    boneId: string;
    startScreen: { x: number; y: number };
    animTx: any;
    startRotation: number;
    startLocal: { x: number; y: number };
  } | null>(null);

  // Drag/element-origin guard: a pointerup synthesizes a click even after a
  // drag, and stopPropagation on pointerdown does NOT stop that click — so
  // without this every drag-release (and every click on an existing bone or IK
  // handle) also spawned a stray bone. Any pointerdown on an existing element,
  // any completed drag, or pointer travel past the slop suppresses the add.
  const suppressClickAddRef = useRef(false);
  const downScreenRef = useRef<{ x: number; y: number } | null>(null);

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

  // Canonical keyframe axis — the same forward map buildSnapshot samples.
  const layerT = compToKeyframeTime(node.id, time);

  // Evaluate live animated bone poses (rotation in RADIANS — the engine unit).
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

  // Live IK targets (keyframeable) and the SOLVED pose — the overlay previews
  // exactly what buildSnapshot renders.
  const activeIkTargets: IkTargetResolved[] = ikTargets
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
  const posedBones = applyIk(animatedBones, activeIkTargets);
  const worldTransforms = computeWorldTransforms({ bones: posedBones });

  /** The IK target whose chain contains this bone (AE/DUIK: dragging a bone of
   *  an active chain moves the TARGET instead of fighting FK). */
  const ikTargetForBone = (boneId: string): IkTargetResolved | undefined =>
    activeIkTargets.find((tg) =>
      ikChainIds(animatedBones, tg.boneId, tg.chainLength).includes(boneId),
    );

  const writeIkTargetKeyframes = (boneId: string, local: { x: number; y: number }) => {
    defaultAnimation.setKeyframe(node.id, `ikTarget.${boneId}.x`, layerT, local.x);
    defaultAnimation.setKeyframe(node.id, `ikTarget.${boneId}.y`, layerT, local.y);
  };

  // Pointer drag operations
  const onPointerDownBone = (e: React.PointerEvent, boneId: string) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    setSelectedBoneId(boneId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const bone = animatedBones.find((b) => b.id === boneId);
    const ik = ikTargetForBone(boneId);

    const animTx = beginAnimEdit();
    dragInfoRef.current = {
      kind: ik ? 'ik' : 'fk',
      boneId: ik ? ik.boneId : boneId,
      startScreen,
      animTx,
      startRotation: bone?.rotation ?? 0,
      startLocal: screenToLocal(startScreen.x, startScreen.y),
    };
    svg.setPointerCapture(e.pointerId);
  };

  const onPointerDownIkTarget = (e: React.PointerEvent, boneId: string) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    setSelectedBoneId(boneId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const animTx = beginAnimEdit();
    dragInfoRef.current = {
      kind: 'ik',
      boneId,
      startScreen,
      animTx,
      startRotation: 0,
      startLocal: screenToLocal(startScreen.x, startScreen.y),
    };
    svg.setPointerCapture(e.pointerId);
  };

  const onPointerDownSvg = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    downScreenRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragInfoRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const currentScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const local = screenToLocal(currentScreen.x, currentScreen.y);

    if (drag.kind === 'ik') {
      // Drag the IK goal — the chain solves toward it live.
      writeIkTargetKeyframes(drag.boneId, local);
      controller.requestRender();
      return;
    }

    const bone = animatedBones.find((b) => b.id === drag.boneId);
    if (!bone) return;

    const parentBone = animatedBones.find((b) => b.id === bone.parentId);
    if (parentBone) {
      // FK: rotate around the bone's own root (radians end-to-end).
      const selfMat = worldTransforms.get(bone.id);
      const selfRoot = selfMat ? boneRoot(selfMat) : { x: 0, y: 0 };
      const startAngle = Math.atan2(drag.startLocal.y - selfRoot.y, drag.startLocal.x - selfRoot.x);
      const currAngle = Math.atan2(local.y - selfRoot.y, local.x - selfRoot.x);
      const newRot = drag.startRotation + (currAngle - startAngle);
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.rotation`, layerT, newRot);
    } else {
      // Root bone translation
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.x`, layerT, local.x);
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.y`, layerT, local.y);
    }

    controller.requestRender();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    // A real drag (travel past the slop) must not add a bone on the synthetic
    // click that follows this pointerup — even when it started on empty canvas.
    const down = downScreenRef.current;
    if (down) {
      const svg = svgRef.current;
      const rect = svg?.getBoundingClientRect();
      if (rect) {
        const dx = e.clientX - rect.left - down.x;
        const dy = e.clientY - rect.top - down.y;
        if (Math.hypot(dx, dy) > CLICK_SLOP_PX) suppressClickAddRef.current = true;
      }
      downScreenRef.current = null;
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
    recordAnimEdit(
      drag.animTx.commit(drag.kind === 'ik' ? `Move IK Target ${drag.boneId}` : `Pose Bone ${drag.boneId}`),
    );
    bumpScene();
  };

  const onClickOverlay = (e: React.MouseEvent) => {
    // Suppressed when the gesture started on an existing bone / IK handle or
    // travelled far enough to be a drag — click-add is for clean empty clicks.
    if (suppressClickAddRef.current) {
      suppressClickAddRef.current = false;
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const local = screenToLocal(e.clientX - rect.left, e.clientY - rect.top);

    // Chain drawing: a new bone grows from the selected parent's TIP toward the
    // click. Local pose is derived from the parent's world frame so the bone
    // points exactly at the clicked spot (rotation in radians — engine unit).
    const newBoneId = `bone_${Date.now().toString(36).slice(2, 8)}`;
    const parentId = selectedBoneId;
    const parent = parentId ? posedBones.find((b) => b.id === parentId) : undefined;

    let newBone: Bone;
    if (parent) {
      const pMat = worldTransforms.get(parent.id);
      const pTip = pMat ? boneTip(pMat, parent.length) : { x: 0, y: 0 };
      const pAngle = pMat ? angleOf(pMat) : 0;
      const dx = local.x - pTip.x;
      const dy = local.y - pTip.y;
      newBone = {
        id: newBoneId,
        parentId: parent.id,
        length: Math.max(4, Math.hypot(dx, dy)),
        x: parent.length,
        y: 0,
        rotation: Math.atan2(dy, dx) - pAngle,
      };
    } else {
      newBone = {
        id: newBoneId,
        parentId: null,
        length: 40,
        x: local.x,
        y: local.y,
        rotation: 0,
      };
    }

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
      onPointerDown={onPointerDownSvg}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClickOverlay}
    >
      {/* Draw bone shapes and joint connections (SOLVED pose — FK + IK) */}
      {posedBones.map((b) => {
        const mat = worldTransforms.get(b.id);
        if (!mat) return null;
        const rootPos = boneRoot(mat);
        const tipPos = boneTip(mat, b.length);

        const rScreen = localToScreen(rootPos.x, rootPos.y);
        const tScreen = localToScreen(tipPos.x, tipPos.y);

        const isSelected = selectedBoneId === b.id;
        const isHovered = hoveredBoneId === b.id;
        const inIkChain = !!ikTargetForBone(b.id);

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
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => setHoveredBoneId(b.id)}
            onMouseLeave={() => setHoveredBoneId(null)}
          >
            {/* Bone polygon (IK-driven bones tint magenta toward the target) */}
            <polygon
              points={polyPoints}
              fill={
                isSelected
                  ? 'rgba(43, 126, 255, 0.45)'
                  : isHovered
                    ? 'rgba(0, 230, 153, 0.35)'
                    : inIkChain
                      ? 'rgba(255, 0, 85, 0.22)'
                      : 'rgba(255, 170, 0, 0.25)'
              }
              stroke={isSelected ? '#2b7eff' : isHovered ? '#00e699' : inIkChain ? '#ff0055' : '#ffaa00'}
              strokeWidth={1.5}
            />

            {/* Bone root joint circle */}
            <circle
              cx={rScreen.x}
              cy={rScreen.y}
              r={6}
              fill={isSelected ? '#2b7eff' : inIkChain ? '#ff0055' : '#ffaa00'}
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

      {/* IK target handles — layer-local, keyframeable, draggable */}
      {activeIkTargets.map((tg) => {
        const tScreen = localToScreen(tg.x, tg.y);
        return (
          <g
            key={`ik-${tg.boneId}`}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => onPointerDownIkTarget(e, tg.boneId)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const stored = ikTargets.find((s) => s.boneId === tg.boneId);
              setIKTarget(node.id, {
                boneId: tg.boneId,
                x: tg.x,
                y: tg.y,
                chainLength: stored?.chainLength,
                enabled: false,
              });
            }}
          >
            {/* Invisible fat hit area so the crosshair is grabbable */}
            <circle cx={tScreen.x} cy={tScreen.y} r={14} fill="transparent" />
            <circle cx={tScreen.x} cy={tScreen.y} r={8} fill="none" stroke="#ff0055" strokeWidth={2} />
            <line x1={tScreen.x - 10} y1={tScreen.y} x2={tScreen.x + 10} y2={tScreen.y} stroke="#ff0055" strokeWidth={1.5} />
            <line x1={tScreen.x} y1={tScreen.y - 10} x2={tScreen.x} y2={tScreen.y + 10} stroke="#ff0055" strokeWidth={1.5} />
          </g>
        );
      })}
    </svg>
  );
}
