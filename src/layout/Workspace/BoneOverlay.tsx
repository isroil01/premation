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
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { bumpScene } from '@stores/sceneStore';

import { computeWorldTransforms, boneRoot, boneTip, type Bone } from '@core/rig/skeleton';
import { resolveLiveBones } from '@core/rig/liveBones';
import { angleOf } from '@core/rig/mat2d';
import { applyIk, ikChainIds, type IkTargetResolved } from '@core/rig/rigDeform';
import {
  readNodeSkeleton, addBone, deleteBone, setIKTarget, setWeightPaint,
  previewSkeleton, recordSkeletonPose, type SkeletonRig,
} from '@core/rig/skeletonCommands';
import {
  controllerPosition, controllerDragKind,
  CONTROLLER_HIT_SLOP, type RigController,
} from '@core/rig/controllers';
import { usePreferenceStore } from '@stores/preferenceStore';
import { resolveActiveIkTargets, resolveIkTargets, chainModeOf } from '@core/rig/liveIkTargets';
import { nodeRestMesh } from '@core/rig/rigMeshInputs';
import { getSkeletonBinding, skinRigVertices } from '@core/rig/rigDeform';
import {
  paintWeights, emptyWeightPaint, weightPaintMatches, isWeightPaintEmpty,
  type PaintMode, type WeightPaintMap,
} from '@core/rig/weightPaint';
import { useAssetStore } from '@stores/assetStore';
import { useRigVertexSelection, selectRigVertex } from '@stores/rigVertexStore';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { nextRigId, usedRigIds } from '@core/rig/rigIds';

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

/** Pointer travel (screen px) below which a down→up pair still counts as a click. */
const CLICK_SLOP_PX = 3;

/**
 * Controller side colours — hardcoded hex, like every other colour in this file.
 *
 * NOT `--color-layer-*` tokens, and the reason is worth keeping. Those tokens
 * encode layer KIND (text / shape / image / video / …), not rig SIDE; there is
 * no left/right/centre triple to reuse, and borrowing three kind tokens would
 * give a rig colour a meaning the token does not carry and drift the moment
 * someone retints "video". Reading tokens at runtime is also not free here —
 * `getComputedStyle` forces a style recalculation (see the note in
 * `useWorkspace.ts`), and an overlay pays that per frame for the whole of a
 * drag.
 *
 * So this follows the convention already in the file (`#00e699` bones,
 * `#ff0055` IK targets, `#a855f7` poles) rather than inventing a second one.
 * If a runtime-token convention for canvas overlays is ever built, these move
 * with the rest of them — this should not be the thing that invents it.
 *
 * Values chosen to separate from those three at a glance: amber and cyan sit
 * away from the existing green/magenta/purple, and centre is a neutral grey so
 * a spine control never reads as a side.
 */
const CONTROLLER_SIDE_COLOR: Record<'left' | 'right' | 'centre', string> = {
  left: '#ffb020',
  right: '#3fd0ff',
  centre: '#c8cedb',
};

/** Halo drawn under every controller so it reads against arbitrary artwork. */
const CONTROLLER_HALO = 'rgba(0, 0, 0, 0.55)';

/** Inert controller — desaturated grey, so side colour reads as "live". */
const CONTROLLER_INERT = '#6b7280';

/**
 * The controller shape library, as an SVG path in SCREEN space.
 *
 * Built around (cx, cy) at radius `r` screen px, so the drawn size is constant
 * at any zoom — the same rule the 3D gizmo and the effect handles follow. A
 * path rather than per-shape elements keeps the halo trivial: the same `d`
 * drawn twice, once wide and dark underneath, once in the side colour on top.
 */
function controllerPath(shape: RigController['shape'], cx: number, cy: number, r: number): string {
  switch (shape) {
    case 'square':
      return `M ${cx - r} ${cy - r} H ${cx + r} V ${cy + r} H ${cx - r} Z`;
    case 'arrow':
      return `M ${cx} ${cy - r} L ${cx + r} ${cy + r * 0.6} L ${cx + r * 0.4} ${cy + r * 0.6} `
        + `L ${cx + r * 0.4} ${cy + r} L ${cx - r * 0.4} ${cy + r} L ${cx - r * 0.4} ${cy + r * 0.6} `
        + `L ${cx - r} ${cy + r * 0.6} Z`;
    case 'arc': {
      // Three-quarter ring with a tick — reads as "rotates" without a label.
      const a0 = -Math.PI * 0.75;
      const a1 = Math.PI * 0.75;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      return `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1} M ${cx} ${cy - r * 0.35} L ${cx} ${cy + r * 0.35}`;
    }
    case 'circle':
    default:
      return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
  }
}

export function BoneOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const boneRigMode = useUIStore((s) => s.boneRigMode);
  const boneWeightMode = useUIStore((s) => s.boneWeightMode);
  const brushRadius = useUIStore((s) => s.boneBrushRadius);
  const setBrushRadius = useUIStore((s) => s.setBoneBrushRadius);
  const selectedNodeId = useSelectionStore((s) => s.ids[0]);
  const rigSelectionNodeId = useRigSelectionStore((s) => s.nodeId);
  const rigSelectedBoneId = useRigSelectionStore((s) => s.boneId);
  const rigSelectedControllerId = useRigSelectionStore((s) => s.controllerId);
  const activeWorkspace = useActiveWorkspace();
  const time = activeWorkspace?.time ?? 0;
  const comp = useCompositionStore((s) => s.comp());

  const selectedBoneId = rigSelectionNodeId === selectedNodeId ? rigSelectedBoneId : null;
  const selectedControllerId =
    rigSelectionNodeId === selectedNodeId ? rigSelectedControllerId : null;
  const setSelectedBoneId = (boneId: string | null): void => {
    if (!selectedNodeId) return;
    useRigSelectionStore.getState().selectBone(selectedNodeId, boneId);
  };
  const setSelectedControllerId = (controllerId: string | null, boneId?: string | null): void => {
    if (!selectedNodeId) return;
    useRigSelectionStore.getState().selectController(selectedNodeId, controllerId, boneId);
  };
  const [hoveredBoneId, setHoveredBoneId] = useState<string | null>(null);
  const [hoveredControllerId, setHoveredControllerId] = useState<string | null>(null);
  const paintMode: PaintMode | null =
    boneRigMode === 'weights' && boneWeightMode !== 'pick' ? boneWeightMode : null;
  const vertexPick = boneRigMode === 'weights' && boneWeightMode === 'pick';
  // Reactive, and ABOVE the guards — the highlight has to redraw when the panel
  // or another pick changes the selection, and a hook below an early return is
  // the "Rendered fewer hooks than expected" crash.
  const pickedVertex = useRigVertexSelection(selectedNodeId ?? '');
  /** Scratch paint map during a stroke — committed as ONE undo step on release. */
  const paintScratchRef = useRef<WeightPaintMap | null>(null);
  const [drawDraft, setDrawDraft] = useState<{
    start: { x: number; y: number };
    current: { x: number; y: number };
    parentId: string | null;
    pointerId: number;
  } | null>(null);

  const dragInfoRef = useRef<{
    /** 'fk' rotates/translates the bone; 'ik' drags an IK target (also the mode
     *  a bone drag redirects to when the bone sits in an active IK chain). */
    kind: 'fk' | 'ik' | 'pole';
    boneId: string;
    startScreen: { x: number; y: number };
    animTx: any;
    startRotation: number;
    startLocal: { x: number; y: number };
    startBoneX?: number;
    startBoneY?: number;
    /** Set when the gesture began on a controller — drives the active state. */
    controllerId?: string;
    /**
     * Rig snapshot taken at pointer-down, present ONLY for a non-keyframing
     * gesture. Its presence is what tells pointer-up to close the gesture as one
     * `SkeletonEditCommand` instead of an anim edit, so the two paths cannot
     * both fire.
     */
    staticBefore?: SkeletonRig | undefined;
  } | null>(null);

  // Drag/element-origin guard: a pointerup synthesizes a click even after a
  // drag, and stopPropagation on pointerdown does NOT stop that click — so
  // without this every drag-release (and every click on an existing bone or IK
  // handle) also spawned a stray bone. Any pointerdown on an existing element,
  // any completed drag, or pointer travel past the slop suppresses the add.
  const suppressClickAddRef = useRef(false);
  const downScreenRef = useRef<{ x: number; y: number } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  // Force re-render on workspace render ticks. `onRender` returns a disposer
  // now — see the note in WorkspaceController; this subscription used to be
  // overwritten by the viewport's, leaving bone/IK handles stale during a pan.
  const [, setTick] = useState(0);
  useEffect(() => {
    const controller = getWorkspaceController();
    return controller.onRender(() => setTick((t) => t + 1));
  }, []);

  // Keyboard listener to delete selected bone
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTool !== 'bone' || !selectedNodeId) return;
      if (e.key === 'Escape' && drawDraft) {
        e.preventDefault();
        setDrawDraft(null);
        return;
      }
      if (selectedBoneId && boneRigMode === 'draw' && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        deleteBone(selectedNodeId, selectedBoneId);
        setSelectedBoneId(null);
        return;
      }
      // Brush sizing, matching every other paint tool.
      if (boneRigMode === 'weights' && e.key === '[') {
        e.preventDefault();
        setBrushRadius(brushRadius / 1.25);
      }
      if (boneRigMode === 'weights' && e.key === ']') {
        e.preventDefault();
        setBrushRadius(brushRadius * 1.25);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, selectedNodeId, selectedBoneId, boneRigMode, brushRadius, drawDraft]);

  if (activeTool !== 'bone' || !selectedNodeId) return null;

  const node = defaultSceneGraph.getNode(selectedNodeId);
  if (!node) return null;

  const geom = readGeometry(node);
  if (!geom) return null;

  const skel = readNodeSkeleton(node);
  const bones = skel?.bones ?? [];
  const ikTargets = skel?.ikTargets ?? [];

  // ── Skinning mesh preview (Phase 4.1) ───────────────────────────────
  // The bone overlay drew bones and IK handles but never the mesh, so you could
  // not see the deformation or the weight falloff while rigging a skeleton —
  // the puppet overlay has always shown both. Same rest mesh buildSnapshot uses.
  // Assembled by `nodeRestMesh`, not here. The Rigging panel's weight editor
  // needs the SAME mesh — a weight override is stored against a vertex INDEX, so
  // two derivations at different densities would not be slightly inconsistent,
  // they would be addressing different vertices.
  const restMesh = nodeRestMesh(node, geom, (id) =>
    useAssetStore.getState().assets.find((a) => a.id === id));

  const controller = getWorkspaceController();
  const camera = controller.ws.camera;

  // ONE projection, shared with PuppetOverlay and the effect-handle overlay.
  // This pair was byte-identical to Puppet's and built on `worldMatrix(geom)`,
  // which composes only THIS node's transform — so bones and IK handles drew at
  // the unparented position on any parented layer (F23).
  const mapping = layerScreenMapping(node.id, time, comp, camera);
  const localToScreen = (lx: number, ly: number) =>
    mapping ? mapping.localToScreen(lx, ly) : { x: lx, y: ly };
  const screenToLocal = (sx: number, sy: number) =>
    mapping ? mapping.screenToLocal(sx, sy) : { x: sx, y: sy };

  // Canonical keyframe axis — the same forward map buildSnapshot samples.
  const layerT = compToKeyframeTime(node.id, time);

  // Evaluate live animated bone poses (rotation in RADIANS — the engine unit).
  const animatedBones: Bone[] = resolveLiveBones(bones, node.id, layerT, defaultAnimation);

  // Live IK targets (keyframeable) and the SOLVED pose — the overlay previews
  // exactly what buildSnapshot renders.
  // Shared with buildSnapshot and PuppetOverlay — one reader, so the canvas and
  // the render cannot disagree about which chains are solving.
  const activeIkTargets: IkTargetResolved[] = resolveActiveIkTargets(skel, node.id, layerT);
  const posedBones = applyIk(animatedBones, activeIkTargets);
  const worldTransforms = computeWorldTransforms({ bones: posedBones });
  const restWorldTransforms = computeWorldTransforms({ bones });

  // Posed mesh + binding: what the renderer will actually draw, and the weight
  // field the heatmap and the paint brush both read.
  const binding = getSkeletonBinding(restMesh, bones, skel?.weightPaint);
  const posedVertices = bones.length > 0
    ? skinRigVertices(binding, worldTransforms, restMesh.vertices)
    : restMesh.vertices;

  /** Effective weight of `boneId` at a vertex — drives the heatmap. */
  const weightAt = (boneId: string, vertexIndex: number): number =>
    binding.weights[vertexIndex]?.find((w) => w.boneId === boneId)?.weight ?? 0;

  type JointAnchor = { point: { x: number; y: number }; parentId: string | null };

  /** Nearest rest-pose joint, with the parent a new branch should attach to. */
  const nearestJoint = (point: { x: number; y: number }, radiusPx = 12): JointAnchor | null => {
    const radius = radiusPx / (camera.zoom || 1);
    let best: JointAnchor | null = null;
    let bestDistance = radius;
    for (const bone of bones) {
      const m = restWorldTransforms.get(bone.id);
      if (!m) continue;
      const candidates: JointAnchor[] = [
        // Starting from this bone's head creates a sibling branch.
        { point: boneRoot(m), parentId: bone.parentId },
        // Starting from its tail extends this bone.
        { point: boneTip(m, bone.length), parentId: bone.id },
      ];
      for (const candidate of candidates) {
        const distance = Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
    }
    return best;
  };

  const beginBoneDraw = (
    e: React.PointerEvent,
    forcedAnchor?: JointAnchor,
  ): void => {
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const raw = screenToLocal(e.clientX - rect.left, e.clientY - rect.top);
    const anchor = forcedAnchor ?? nearestJoint(raw) ?? { point: raw, parentId: null };
    suppressClickAddRef.current = true;
    setSelectedControllerId(null);
    setDrawDraft({
      start: anchor.point,
      current: anchor.point,
      parentId: anchor.parentId,
      pointerId: e.pointerId,
    });
    capturePointer(svg, e.pointerId);
  };

  const commitBoneDraw = (draft: NonNullable<typeof drawDraft>): void => {
    const dx = draft.current.x - draft.start.x;
    const dy = draft.current.y - draft.start.y;
    const length = Math.hypot(dx, dy);
    if (length < 4) return;

    const id = nextRigId('bone_', usedRigIds(bones));
    let bone: Bone;
    if (draft.parentId) {
      const parent = bones.find((candidate) => candidate.id === draft.parentId);
      const parentWorld = restWorldTransforms.get(draft.parentId);
      if (!parent || !parentWorld) return;
      bone = {
        id,
        name: `Bone ${bones.length + 1}`,
        parentId: parent.id,
        length,
        x: parent.length,
        y: 0,
        rotation: Math.atan2(dy, dx) - angleOf(parentWorld),
      };
    } else {
      bone = {
        id,
        name: `Bone ${bones.length + 1}`,
        parentId: null,
        length,
        x: draft.start.x,
        y: draft.start.y,
        rotation: Math.atan2(dy, dx),
      };
    }
    addBone(node.id, bone);
    setSelectedBoneId(id);
  };


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

  // ── Controllers ───────────────────────────────────────────────────────
  // Resolved through `controllerPosition`, the single reader for placement, so
  // the shape is drawn exactly where it is hit-tested and where the drag
  // measures from. The overlay contributes no placement maths of its own.
  const controllers = skel?.controllers ?? [];
  // PLACEMENT uses every enabled target, not just the solving ones. An IK
  // controller must still be drawn (greyed) while its chain is in FK — placing
  // it from the mode-filtered list made it VANISH instead, which runtime
  // verification caught and jsdom could not.
  const ikTargetPositions = new Map<string, { x: number; y: number }>(
    resolveIkTargets(skel, node.id, layerT).map((tg) => [tg.boneId, { x: tg.x, y: tg.y }]),
  );
  /**
   * Is this controller live in the chain's CURRENT mode?
   *
   * An IK controller drives a goal that is not solved in FK, and an FK
   * controller rotates a bone that IK overwrites — so each is inert in the
   * other mode. A bone in no chain at all is always FK, so its controller is
   * always live.
   *
   * GREYED, NOT HIDDEN, deliberately. Hiding is less cluttered but tells an
   * animator the control is gone, which invites re-creating one that already
   * exists; and the inert control is the visible evidence that the rig HAS the
   * other mode. Greying keeps the affordance legible while making it clear the
   * grab will do nothing — the same reason a disabled button is not simply
   * removed.
   */
  const controllerActive = (c: RigController): boolean => {
    const tg = (skel?.ikTargets ?? []).find((t) =>
      ikChainIds(animatedBones, t.boneId, t.chainLength).includes(c.link.boneId),
    );
    if (!tg) return c.link.kind === 'bone';   // no chain here: FK only
    const mode = chainModeOf(tg, node.id, layerT);
    return c.link.kind === 'ikTarget' ? mode === 'ik' : mode === 'fk';
  };

  const controllerLocal = (c: RigController) =>
    controllerPosition(c, { worldTransforms, ikTargets: ikTargetPositions });
  const controllerScreen = (c: RigController) => {
    const local = controllerLocal(c);
    return local ? localToScreen(local.x, local.y) : null;
  };

  /**
   * Does this gesture write keyframes?
   *
   * The app's rule, matching the inspector rows: keyframe when the track is
   * ALREADY animated, or when auto-keyframe is on. Otherwise the drag edits the
   * static rig value and leaves the track alone.
   *
   * Deliberately decided ONCE, at pointer-down, rather than per pointermove — a
   * gesture that started static must not begin keyframing halfway through
   * because the first write made the track animated.
   */
  const gestureKeyframes = (kind: 'fk' | 'ik' | 'pole', boneId: string): boolean => {
    if (usePreferenceStore.getState().timelineAutoKeyframe) return true;
    const paths = kind === 'ik'
      ? [`ikTarget.${boneId}.x`, `ikTarget.${boneId}.y`]
      : kind === 'pole'
        ? [`ikPole.${boneId}.x`, `ikPole.${boneId}.y`]
        : [`bone.${boneId}.rotation`, `bone.${boneId}.x`, `bone.${boneId}.y`];
    return paths.some((p) => defaultAnimation.isAnimated(node.id, p));
  };

  /** Write the STATIC rig value for a non-keyframing pose drag (no history). */
  const previewStaticPose = (
    kind: 'fk' | 'ik' | 'pole',
    boneId: string,
    local: { x: number; y: number },
    rotation: number,
  ) => {
    const current = readNodeSkeleton(defaultSceneGraph.getNode(node.id)!);
    if (!current) return;
    const next: SkeletonRig = kind === 'ik'
      ? {
          ...current,
          ikTargets: (current.ikTargets ?? []).map((t) =>
            t.boneId === boneId ? { ...t, x: local.x, y: local.y } : t,
          ),
        }
      : kind === 'pole'
        ? {
            ...current,
            ikTargets: (current.ikTargets ?? []).map((t) =>
              t.boneId === boneId ? { ...t, pole: { x: local.x, y: local.y } } : t,
            ),
          }
        : {
          ...current,
          bones: (current.bones ?? []).map((b) =>
            b.id === boneId
              ? {
                  ...b,
                  rotation,
                  ...(b.parentId === null ? { x: local.x, y: local.y } : {}),
                }
              : b,
          ),
        };
    previewSkeleton(node.id, next);
  };

  const onPointerDownController = (e: React.PointerEvent, c: RigController) => {
    e.stopPropagation();
    if (boneRigMode !== 'pose') return;
    suppressClickAddRef.current = true;
    setSelectedBoneId(c.link.boneId);
    setSelectedControllerId(c.id, c.link.boneId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // The drag mode is the one the LINK implies — a controller owns no drag
    // logic, it just enters the existing fk/ik gesture from a different target.
    const kind = controllerDragKind(c);
    const bone = animatedBones.find((b) => b.id === c.link.boneId);
    const keyframes = gestureKeyframes(kind, c.link.boneId);
    dragInfoRef.current = {
      kind,
      boneId: c.link.boneId,
      startScreen,
      animTx: keyframes ? beginAnimEdit() : null,
      startRotation: bone?.rotation ?? 0,
      startLocal: screenToLocal(startScreen.x, startScreen.y),
      controllerId: c.id,
      ...(keyframes ? {} : { staticBefore: skel }),
    };
    capturePointer(svg, e.pointerId);
  };

  // Pointer drag operations
  const onPointerDownBone = (e: React.PointerEvent, boneId: string) => {
    e.stopPropagation();
    const restBone = bones.find((bone) => bone.id === boneId);
    const restWorld = restWorldTransforms.get(boneId);
    if (boneRigMode === 'draw' && restBone && restWorld) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const pointer = screenToLocal(e.clientX - rect.left, e.clientY - rect.top);
      const root = boneRoot(restWorld);
      const tip = boneTip(restWorld, restBone.length);
      const rootDistance = Math.hypot(pointer.x - root.x, pointer.y - root.y);
      const tipDistance = Math.hypot(pointer.x - tip.x, pointer.y - tip.y);
      beginBoneDraw(e, tipDistance <= rootDistance
        ? { point: tip, parentId: restBone.id }
        : { point: root, parentId: restBone.parentId });
      return;
    }
    if (boneRigMode === 'weights') {
      suppressClickAddRef.current = true;
      setSelectedBoneId(boneId);
      return;
    }
    if (boneRigMode !== 'pose') return;
    suppressClickAddRef.current = true;
    setSelectedBoneId(boneId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const bone = animatedBones.find((b) => b.id === boneId);
    const ik = ikTargetForBone(boneId);

    const kind = ik ? 'ik' : 'fk';
    const keyframes = gestureKeyframes(kind, ik ? ik.boneId : boneId);
    dragInfoRef.current = {
      kind,
      boneId: ik ? ik.boneId : boneId,
      startScreen,
      animTx: keyframes ? beginAnimEdit() : null,
      startRotation: bone?.rotation ?? 0,
      startLocal: screenToLocal(startScreen.x, startScreen.y),
      startBoneX: bone?.x ?? 0,
      startBoneY: bone?.y ?? 0,
      ...(keyframes ? {} : { staticBefore: skel }),
    };
    capturePointer(svg, e.pointerId);
  };

  /** Drag an IK pole — writes the keyframeable ikPole.<boneId>.x/.y tracks. */
  const onPointerDownPole = (e: React.PointerEvent, boneId: string) => {
    e.stopPropagation();
    if (boneRigMode !== 'pose') return;
    suppressClickAddRef.current = true;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const keyframes = gestureKeyframes('pole', boneId);
    dragInfoRef.current = {
      kind: 'pole',
      boneId,
      startScreen,
      animTx: keyframes ? beginAnimEdit() : null,
      startRotation: 0,
      startLocal: screenToLocal(startScreen.x, startScreen.y),
      ...(keyframes ? {} : { staticBefore: skel }),
    };
    capturePointer(svg, e.pointerId);
  };

  const onPointerDownIkTarget = (e: React.PointerEvent, boneId: string) => {
    e.stopPropagation();
    if (boneRigMode !== 'pose') return;
    suppressClickAddRef.current = true;
    setSelectedBoneId(boneId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const keyframes = gestureKeyframes('ik', boneId);
    dragInfoRef.current = {
      kind: 'ik',
      boneId,
      startScreen,
      animTx: keyframes ? beginAnimEdit() : null,
      startRotation: 0,
      startLocal: screenToLocal(startScreen.x, startScreen.y),
      ...(keyframes ? {} : { staticBefore: skel }),
    };
    capturePointer(svg, e.pointerId);
  };

  const onPointerDownSvg = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    downScreenRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    if (boneRigMode === 'draw') {
      beginBoneDraw(e);
      return;
    }

    // Start a paint stroke. Alt inverts add↔subtract, matching every other
    // paint tool; the scratch map is committed as one undo step on release.
    if (paintMode && selectedBoneId) {
      suppressClickAddRef.current = true;
      const numVerts = restMesh.vertices.length / 4;
      paintScratchRef.current = weightPaintMatches(skel?.weightPaint, numVerts)
        ? skel!.weightPaint!
        : emptyWeightPaint(numVerts);
      const mode: PaintMode =
        paintMode === 'smooth' ? 'smooth' : e.altKey
          ? (paintMode === 'add' ? 'subtract' : 'add')
          : paintMode;
      capturePointer(svg, e.pointerId);
      paintAt(e.clientX - rect.left, e.clientY - rect.top, mode);
    }
  };

  /** Apply one brush dab at a screen position (paint mode only). */
  const paintAt = (sx: number, sy: number, mode: PaintMode) => {
    if (!selectedBoneId) return;
    const numVerts = restMesh.vertices.length / 4;
    const local = screenToLocal(sx, sy);
    const base = paintScratchRef.current
      ?? (weightPaintMatches(skel?.weightPaint, numVerts)
        ? skel!.weightPaint!
        : emptyWeightPaint(numVerts));
    // Brush radius is authored in SCREEN px; convert so the felt size is
    // constant regardless of zoom.
    const worldRadius = brushRadius / (camera.zoom || 1);
    paintScratchRef.current = paintWeights(
      base,
      selectedBoneId,
      restMesh.vertices,
      local,
      worldRadius,
      { mode, strength: 0.35, falloff: 0.6, baseWeightAt: (i) => weightAt(selectedBoneId, i) },
    );
    controller.requestRender();
    bumpScene();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drawDraft) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const raw = screenToLocal(e.clientX - rect.left, e.clientY - rect.top);
      const snapped = nearestJoint(raw);
      setDrawDraft({ ...drawDraft, current: snapped?.point ?? raw });
      return;
    }
    if (paintMode && paintScratchRef.current !== null) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      paintAt(e.clientX - rect.left, e.clientY - rect.top, paintMode);
      return;
    }

    const drag = dragInfoRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const currentScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const local = screenToLocal(currentScreen.x, currentScreen.y);

    if (drag.kind === 'pole') {
      if (drag.staticBefore !== undefined || drag.animTx === null) {
        previewStaticPose('pole', drag.boneId, local, 0);
        controller.requestRender();
        return;
      }
      defaultAnimation.setKeyframe(node.id, `ikPole.${drag.boneId}.x`, layerT, local.x);
      defaultAnimation.setKeyframe(node.id, `ikPole.${drag.boneId}.y`, layerT, local.y);
      controller.requestRender();
      return;
    }

    if (drag.kind === 'ik') {
      // A non-keyframing controller gesture edits the rig's static goal instead
      // of writing a track. `staticBefore` is only ever set by a controller
      // drag, so bone and IK-handle drags keep their existing always-keyframe
      // behaviour untouched.
      if (drag.staticBefore !== undefined || drag.animTx === null) {
        previewStaticPose('ik', drag.boneId, local, 0);
        controller.requestRender();
        return;
      }
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
      if (drag.staticBefore !== undefined || drag.animTx === null) {
        previewStaticPose('fk', drag.boneId, { x: bone.x, y: bone.y }, newRot);
        controller.requestRender();
        return;
      }
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.rotation`, layerT, newRot);
    } else {
      const x = (drag.startBoneX ?? bone.x) + (local.x - drag.startLocal.x);
      const y = (drag.startBoneY ?? bone.y) + (local.y - drag.startLocal.y);
      if (drag.staticBefore !== undefined || drag.animTx === null) {
        previewStaticPose('fk', drag.boneId, { x, y }, bone.rotation);
        controller.requestRender();
        return;
      }
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.x`, layerT, x);
      defaultAnimation.setKeyframe(node.id, `bone.${drag.boneId}.y`, layerT, y);
    }

    controller.requestRender();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (drawDraft) {
      commitBoneDraw(drawDraft);
      setDrawDraft(null);
      const svg = svgRef.current;
      if (svg) {
        try { svg.releasePointerCapture(e.pointerId); } catch {}
      }
      suppressClickAddRef.current = true;
      downScreenRef.current = null;
      return;
    }
    // Commit a paint stroke: ONE undo step for the whole gesture.
    if (paintScratchRef.current) {
      const painted = paintScratchRef.current;
      paintScratchRef.current = null;
      const svg = svgRef.current;
      if (svg) {
        try { svg.releasePointerCapture(e.pointerId); } catch {}
      }
      setWeightPaint(node.id, isWeightPaintEmpty(painted) ? undefined : painted);
      downScreenRef.current = null;
      suppressClickAddRef.current = true;
      return;
    }

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
    // A non-keyframing controller gesture closes as ONE SkeletonEditCommand —
    // the whole drag previewed the rig with no history, exactly as a weight-paint
    // stroke does, so undoing it restores the pose in a single step.
    if (drag.animTx === null) {
      recordSkeletonPose(node.id, drag.staticBefore, `Pose ${drag.boneId}`);
      bumpScene();
      return;
    }
    recordAnimEdit(
      drag.animTx.commit(
        drag.kind === 'pole' ? `Move IK Pole ${drag.boneId}`
          : drag.kind === 'ik' ? `Move IK Target ${drag.boneId}`
          : `Pose Bone ${drag.boneId}`,
      ),
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

    // Vertex pick: nearest POSED vertex to the click, because the posed mesh is
    // what the user is looking at. The index it yields addresses the REST mesh,
    // which is what weights are stored against — the two are index-aligned by
    // construction, since skinning transforms vertices without reordering them.
    if (vertexPick && bones.length > 0) {
      const n = posedVertices.length / 4;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(posedVertices[i * 4]! - local.x, posedVertices[i * 4 + 1]! - local.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) selectRigVertex(node.id, best);
      return;
    }

    // Construction is drag-only. A plain click intentionally creates no bone.
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
        cursor: boneRigMode === 'draw' ? 'crosshair' : boneRigMode === 'weights' ? 'none' : 'default',
      }}
      onPointerDown={onPointerDownSvg}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClickOverlay}
    >
      {/* ── Skinning mesh + weight heatmap (Phase 4.1 / 4.3) ─────────────
          Drawn from the POSED vertices, so it shows the deformation the
          renderer produces. With a bone selected the fill becomes that bone's
          weight field, which is what makes painting legible. */}
      {boneRigMode === 'weights' && bones.length > 0 && (() => {
        const tris: JSX.Element[] = [];
        const tri = restMesh.triangles;
        for (let i = 0; i < tri.length; i += 3) {
          const i0 = tri[i]!, i1 = tri[i + 1]!, i2 = tri[i + 2]!;
          const s0 = localToScreen(posedVertices[i0 * 4]!, posedVertices[i0 * 4 + 1]!);
          const s1 = localToScreen(posedVertices[i1 * 4]!, posedVertices[i1 * 4 + 1]!);
          const s2 = localToScreen(posedVertices[i2 * 4]!, posedVertices[i2 * 4 + 1]!);
          let fill = 'rgba(255, 170, 0, 0.04)';
          if (selectedBoneId) {
            const w =
              (weightAt(selectedBoneId, i0) +
                weightAt(selectedBoneId, i1) +
                weightAt(selectedBoneId, i2)) / 3;
            const r = Math.round(Math.min(255, Math.max(0, (w - 0.5) * 2 * 255)));
            const g = Math.round(Math.min(255, Math.max(0, (1 - Math.abs(w - 0.5) * 2) * 255)));
            const b = Math.round(Math.min(255, Math.max(0, (0.5 - w) * 2 * 255)));
            fill = `rgba(${r}, ${g}, ${b}, 0.45)`;
          }
          tris.push(
            <polygon
              key={`bm-${i}`}
              points={`${s0.x},${s0.y} ${s1.x},${s1.y} ${s2.x},${s2.y}`}
              stroke="rgba(255, 170, 0, 0.22)"
              strokeWidth={1}
              fill={fill}
              pointerEvents="none"
            />,
          );
        }
        return <g>{tris}</g>;
      })()}

      {/* The picked vertex. Drawn from the POSED position so the ring sits on
          the point the user clicked even on a deformed rig, and labelled with
          its index so the panel's `#N` badge is checkable against the canvas. */}
      {boneRigMode === 'weights' && bones.length > 0 && pickedVertex !== null && pickedVertex * 4 < posedVertices.length && (() => {
        const p = localToScreen(posedVertices[pickedVertex * 4]!, posedVertices[pickedVertex * 4 + 1]!);
        return (
          <g pointerEvents="none">
            <circle cx={p.x} cy={p.y} r={6} fill="none" stroke="#33aaff" strokeWidth={2} />
            <circle cx={p.x} cy={p.y} r={2} fill="#33aaff" />
            <text x={p.x + 9} y={p.y - 7} fontSize={10} fill="#33aaff" style={{ userSelect: 'none' }}>
              {`#${pickedVertex}`}
            </text>
          </g>
        );
      })()}

      {/* Brush cursor while painting */}
      {paintMode && (
        <circle
          cx={-999}
          cy={-999}
          r={brushRadius}
          fill="none"
          stroke="#00e699"
          strokeWidth={1}
          pointerEvents="none"
          ref={(el) => {
            if (!el) return;
            const svg = svgRef.current;
            if (!svg) return;
            const onMove = (ev: PointerEvent) => {
              const rect = svg.getBoundingClientRect();
              el.setAttribute('cx', String(ev.clientX - rect.left));
              el.setAttribute('cy', String(ev.clientY - rect.top));
            };
            svg.addEventListener('pointermove', onMove);
          }}
        />
      )}

      {/* Live construction preview. No scene mutation occurs until release. */}
      {drawDraft && (() => {
        const start = localToScreen(drawDraft.start.x, drawDraft.start.y);
        const end = localToScreen(drawDraft.current.x, drawDraft.current.y);
        const length = Math.hypot(
          drawDraft.current.x - drawDraft.start.x,
          drawDraft.current.y - drawDraft.start.y,
        );
        return (
          <g pointerEvents="none" data-bone-draft="">
            <line
              x1={start.x} y1={start.y} x2={end.x} y2={end.y}
              stroke="#00e699" strokeWidth={2} strokeDasharray="5 3"
            />
            <circle cx={start.x} cy={start.y} r={6} fill="#00e699" stroke="#fff" />
            <circle cx={end.x} cy={end.y} r={5} fill="none" stroke="#00e699" strokeWidth={2} />
            <text
              x={(start.x + end.x) / 2 + 8}
              y={(start.y + end.y) / 2 - 8}
              fill="#fff"
              fontSize={11}
              paintOrder="stroke"
              stroke="rgba(0,0,0,.8)"
              strokeWidth={3}
            >
              {`${Math.round(length)} px`}
            </text>
          </g>
        );
      })()}

      {/* Draw bone shapes and joint connections (SOLVED pose — FK + IK) */}
      {(boneRigMode === 'draw' ? bones : posedBones).map((b) => {
        const mat = (boneRigMode === 'draw' ? restWorldTransforms : worldTransforms).get(b.id);
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
      {boneRigMode === 'pose' && activeIkTargets.map((tg) => {
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

      {/* ── IK pole handles (Phase 4.4) ──────────────────────────────────
          The side a two-bone chain bends toward. Drag to flip the elbow/knee;
          without one the solver can only ever hold the current side. */}
      {boneRigMode === 'pose' && activeIkTargets.map((tg) => {
        if (!tg.pole) return null;
        const p = localToScreen(tg.pole.x, tg.pole.y);
        const chain = ikChainIds(animatedBones, tg.boneId, tg.chainLength);
        const jointId = chain[chain.length - 1];
        const jm = jointId ? worldTransforms.get(jointId) : undefined;
        const joint = jm ? localToScreen(boneRoot(jm).x, boneRoot(jm).y) : null;
        return (
          <g
            key={`pole-${tg.boneId}`}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => onPointerDownPole(e, tg.boneId)}
            onClick={(e) => e.stopPropagation()}
          >
            {joint && (
              <line
                x1={joint.x} y1={joint.y} x2={p.x} y2={p.y}
                stroke="#a855f7" strokeWidth={1} strokeDasharray="3 3" opacity={0.8}
                pointerEvents="none"
              />
            )}
            <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
            <polygon
              points={`${p.x},${p.y - 7} ${p.x + 6},${p.y + 5} ${p.x - 6},${p.y + 5}`}
              fill="#a855f7" stroke="#ffffff" strokeWidth={1.2}
            />
          </g>
        );
      })}

      {/* ── Rig controllers ──────────────────────────────────────────────
          Drawn LAST so they sit above bones, IK crosses and poles: a controller
          is the thing an animator is meant to grab, and the painter's order is
          also the pick order (`pickController` walks the list backwards). */}
      {boneRigMode === 'pose' && controllers.map((c) => {
        const s = controllerScreen(c);
        // A dangling link draws nothing rather than stacking at the origin.
        if (!s) return null;
        const active = controllerActive(c);
        const isSelected = selectedControllerId === c.id;
        const isHovered = hoveredControllerId === c.id;
        const color = CONTROLLER_SIDE_COLOR[c.side];
        // Hover grows the shape slightly; the transition uses the app's spring,
        // which is the token reserved for direct manipulation — which this is.
        const r = c.size * (isHovered || isSelected ? 1.12 : 1);
        const d = controllerPath(c.shape, s.x, s.y, r);
        // While selected, show WHAT this controller drives. Twelve controllers
        // on a character are indistinguishable without it.
        const driven = c.link.kind === 'ikTarget'
          ? ikTargetPositions.get(c.link.boneId)
          : (() => {
              const m = worldTransforms.get(c.link.boneId);
              return m ? boneRoot(m) : undefined;
            })();
        const drivenScreen = driven ? localToScreen(driven.x, driven.y) : null;
        return (
          <g
            key={`ctrl-${c.id}`}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => onPointerDownController(e, c)}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => setHoveredControllerId(c.id)}
            onMouseLeave={() => setHoveredControllerId(null)}
          >
            {/* Link indicator: only while selected, so a rig full of controls
                is not a cat's cradle of lines. */}
            {isSelected && drivenScreen && (
              <line
                x1={s.x} y1={s.y} x2={drivenScreen.x} y2={drivenScreen.y}
                stroke={active ? color : CONTROLLER_INERT} strokeWidth={1} strokeDasharray="3 3" opacity={0.7}
                pointerEvents="none"
              />
            )}
            {/* Hit target, larger than the drawn shape. Transparent, not
                `fill: none` — a `none` fill is not hit-testable. */}
            {/* Inert controllers are not grabbable — the hit target goes away
                even though the shape stays, so a stray click cannot pose a
                chain through a control the mode has switched off. */}
            {active && (
              <circle cx={s.x} cy={s.y} r={c.size + CONTROLLER_HIT_SLOP} fill="transparent" />
            )}
            {/* Halo first: a dark wide underlay is what keeps the outline legible
                on artwork that happens to share the side colour. */}
            <path
              d={d} fill="none" stroke={CONTROLLER_HALO}
              strokeWidth={4} strokeLinejoin="round" pointerEvents="none"
            />
            <path
              d={d} fill="none" stroke={active ? color : CONTROLLER_INERT}
              strokeWidth={isSelected ? 2.4 : 1.8}
              strokeLinejoin="round"
              opacity={active ? (isHovered || isSelected ? 1 : 0.85) : 0.28}
              pointerEvents="none"
              style={{ transition: 'stroke-width var(--motion-spring, 220ms cubic-bezier(0.34, 1.56, 0.64, 1))' }}
            />
            <title>{`${c.name ?? c.id} → ${c.link.kind === 'ikTarget' ? 'IK goal' : 'bone'} ${c.link.boneId}${active ? '' : ' (inactive in this mode)'}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
