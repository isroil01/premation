/**
 * useGizmo3d — React hook providing interactive 3D Transform Gizmo logic,
 * raycasting interaction, and real-time scene updates.
 *
 * ## Per-view, not per-app
 *
 * The hook used to read the MAIN viewport's globals directly: the view mode off
 * `guidesStore.camera3dMode` and the comp → canvas transform off
 * `getWorkspaceController().getView()`. That made it structurally impossible to
 * mount a second gizmo — a 2-up or 4-up secondary pane draws the same scene
 * through its OWN camera and its own framing, so a gizmo built from the main
 * viewport's numbers lands in a completely different place on the pane's pixels
 * (and hit-tests the pointer against a projection nothing on screen uses).
 *
 * Both are now injectable through {@link Gizmo3dViewOptions}, exactly as
 * `SceneGeometryOverlay` already took them as props. Omit them and the hook
 * behaves as before, reading the main viewport. What stays GLOBAL is everything
 * that should be: selection, the axis mode, the camera-tool gate, and the
 * transform write path — a drag in a pane is the same undoable command it is
 * anywhere else.
 */

import { useState, useEffect, useRef } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useRetainTrees } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { canBe3DLayer } from '@core/mirror/layerKinds';
import { gizmoFrameOf, toParentSpace, transform3DOf, type GizmoFrame } from '@core/mirror/viewGeometry';
import type { Gizmo3DNodeUpdate, Transform3DValues } from '@core/workspace/ports';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { beginViewportGesture, endViewportGesture } from '@core/workspace/viewportGesture';
import { GestureSession } from '@core/engine/uiEdits';
import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { trackValueCommands } from './viewportEdits';
import { useSceneRefGeometry } from './useSceneRefGeometry';
import type { RenderView } from '@core/workspace/renderView';
import { Project3D, type Vec3 } from '@motion/scene';
import { Gizmo3D, Gizmo3DMath, pointLines, type GizmoHandleType, type RenderedGizmo3D, type SnapLine, type SnapPointTarget } from '@motion/workspace';
import { useUIStore } from '@stores/uiStore';
import { readTrack } from '@core/mirror/selection';
import { snapActive, snapGizmoTranslate } from './gizmo3dSnap';
import { isSceneCameraView } from '@core/scene/cameraViewMode';

export interface DragState3D {
  active: boolean;
  handle: GizmoHandleType;
  startPos3D: Vec3;
  currentPos3D: Vec3;
  startRot3D: { rotX: number; rotY: number; rotZ: number };
  currentRot3D: { rotX: number; rotY: number; rotZ: number };
  startScale3D: { scaleX: number; scaleY: number; scaleZ: number };
  currentScale3D: { scaleX: number; scaleY: number; scaleZ: number };
  startMouseScreen: { x: number; y: number };
  /** Pointer-down position mapped into composition space. */
  startMouseComp: { x: number; y: number };
  mouseScreen: { x: number; y: number };
  /** A value typed while dragging (AE parity 4.6): '' = none; px, degrees or percent by handle. */
  typed: string;
  /** Pan Behind (Y): a position drag moves the anchor point (the pivot), the layer stays. */
  pivot: boolean;
  /** Scale handles: the arm's on-screen direction (unit) and the handle's distance from the centre, comp px. */
  scaleAxis?: { dir: { x: number; y: number }; dist: number };
  initialNodeStates?: Array<{
    id: string;
    pos: Vec3;
    /** The layer's world position at grab time; a move adds the delta here, then maps it into `parent`'s space. */
    world: Vec3;
    parent: readonly number[];
    rot: { rotX: number; rotY: number; rotZ: number };
    scale: { scaleX: number; scaleY: number; scaleZ: number };
    /** Orientation (degrees): with `parent`, what the trackball turns the rotation inside. */
    orientation: { x: number; y: number; z: number };
    /** Anchor point at grab time (Pan Behind edits it). */
    anchor: { x: number; y: number; z: number };
  }>;
}

/** Increments while Shift is held (AE parity 4.6): world px, degrees, scale factor. */
const SNAP_MOVE = 10;
const SNAP_DEG = 15;
const SNAP_SCALE = 0.1;

/** Identity view — the fallback while a pane's camera does not exist yet. */
const IDENTITY_VIEW: RenderView = { scale: 1, offsetX: 0, offsetY: 0 };

/** Which VIEW this gizmo belongs to. Omit every field for the main viewport. */
export interface Gizmo3dViewOptions {
  /** View mode to project through. Defaults to `guidesStore.camera3dMode`. */
  mode?: Camera3dMode;
  /**
   * This view's live comp → canvas transform (`canvasPx = compPx·scale + offset`,
   * CSS px, relative to `stageRef`'s box). Defaults to the main viewport's
   * controller view. A pane passes `usePaneWorkspace().getRenderView`.
   */
  getView?: () => RenderView | undefined;
  /**
   * Bumped whenever `getView` would answer differently for a reason no window
   * pointer/wheel event covers — a pane's `framingRev`. Without it a pane that
   * re-frames itself (auto-fit on resize) leaves the gizmo at the old framing
   * until the next stray pointer move.
   */
  viewRev?: number;
}

export function useGizmo3d(stageRef: React.RefObject<HTMLElement | null>, options?: Gizmo3dViewOptions) {
  const selectedIds = useSelectionStore((s) => s.ids);
  // A drag writes through the selected layers' property trees: keep them loaded.
  useRetainTrees(selectedIds);

  const pickedGizmo = useGuidesStore((s) => s.gizmo3dState);
  // AE: the Rotation tool (W) shows the rotation gizmo on a 3D layer, Pan
  // Behind (Y) the position gizmo — which then moves the pivot.
  const activeTool = useUIStore((s) => s.activeTool);
  const pivotMode = activeTool === 'pan-behind';
  const gizmoState = activeTool === 'rotate' ? 'rotation' : pivotMode ? 'position' : pickedGizmo;
  const pivotModeRef = useRef(pivotMode);
  pivotModeRef.current = pivotMode;
  const axisMode = useGuidesStore((s) => s.gizmo3dAxisMode);
  const mainMode = useGuidesStore((s) => s.camera3dMode);
  // The view this instance draws for: a pane's own mode when it passes one.
  const mode = options?.mode ?? mainMode;
  // Camera, ortho axis, ground-plane visibility and the scene wireframes all
  // come from ONE shared resolver — the inspection panes use it too.
  const refGeometry = useSceneRefGeometry(mode);
  const customViews = useGuidesStore((s) => s.customViews);

  /**
   * The view reader, behind a ref.
   *
   * Every consumer below (the rAF resync, the pointer handlers, the hit
   * tolerance) needs the CURRENT transform, and the pane's `getRenderView`
   * reads a live camera. Holding it in a ref keeps the pointer-listener effect
   * from re-attaching whenever the host re-renders with a new closure.
   */
  const getViewOpt = options?.getView;
  const viewRev = options?.viewRev ?? 0;
  const readViewRef = useRef<() => RenderView>(() => getWorkspaceController().getView());
  readViewRef.current = getViewOpt
    ? (): RenderView => getViewOpt() ?? IDENTITY_VIEW
    : (): RenderView => getWorkspaceController().getView();
  // Snapping reads the MAIN workspace's features, projected through the main
  // view — a secondary pane (own camera, own framing) must not snap to them.
  const mainViewRef = useRef(true);
  mainViewRef.current = !getViewOpt;

  const { width: compWidth, height: compHeight } = useActiveCompSize();

  // Current playhead time of the active tab — the camera must be sampled at it
  // (an animated/orbited camera otherwise leaves the gizmo at frame 0's view).
  const time = useCurrentTime();

  // Re-render on scene mutation (canvas drags, inspector edits, undo…) so the
  // gizmo tracks the object it is attached to — frame-coalesced: the raw rev
  // subscription re-rendered this hook (and the whole SVG overlay under it)
  // once per POINTER EVENT during a drag. See useMirrorRevisionFrame.
  useMirrorRevisionFrame();

  const [hoverHandle, setHoverHandle] = useState<GizmoHandleType | null>(null);
  const [activeHandle, setActiveHandle] = useState<GizmoHandleType | null>(null);
  const [dragState, setDragState] = useState<DragState3D | null>(null);
  // The LIVE drag state the pointer handlers read and write. React state is a
  // rAF-coalesced mirror for the HUD — keeping `dragState` itself out of the
  // handler effect's deps is what stops every pointermove from tearing down
  // and re-attaching the stage/window listeners.
  const dragRef = useRef<DragState3D | null>(null);
  /** The drag's engine gesture: every move's absolute values, one undo entry. */
  const gestureRef = useRef<GestureSession | null>(null);
  const dragHudRaf = useRef<number | null>(null);
  /**
   * Snap features for the current TRANSLATE drag, collected once at grab time
   * (nothing else moves during the drag). `shown` tracks whether the indicator
   * is up, so a move that snaps nothing clears it exactly once.
   */
  const snapRef = useRef<{ points: SnapPointTarget[]; thresholdWorld: number; enabled: boolean; shown: boolean } | null>(null);

  // Filter selected nodes to those with 3D enabled (AE multi-layer 3D selection).
  //
  // `canBe3D` — not bare `is3DEnabled` — is the gate, and it is the SAME predicate
  // the renderer, the selection chrome (ports.ts) and the axis widget use.
  // insertCamera writes `z = -focalLength`, so every camera satisfies
  // `is3DEnabled` and used to get a full layer transform gizmo whose drags wrote
  // camera x/y/z; lights had the same problem. Cameras and lights are positioned
  // with the camera-navigation tools and their own inspector, not this gizmo.
  // The gate reads the mirror's layer header (`canBe3DLayer` is `canBe3D`'s
  // twin, the 3D switch is `is3DEnabled`); the per-frame transform sample below
  // is the layer's pushed scene3d record (B4 round 5) — the local transform the
  // engine sampled for the frame on screen.
  const mirror = documentMirror();
  const { recordOf } = refGeometry;
  const recordOfRef = useRef(recordOf);
  recordOfRef.current = recordOf;
  const selected3DNodes = selectedIds
    .filter((id) => {
      const layer = mirror.layer(id);
      return canBe3DLayer(layer) && layer?.switches.threeD === true;
    })
    .map((id) => ({ id, tv: transform3DOf(recordOf(id)), frame: gizmoFrameOf(recordOf(id)) }))
    .filter((n): n is { id: string; tv: Transform3DValues; frame: GizmoFrame } => n.tv !== null && n.frame !== null);

  const is3D = selected3DNodes.length > 0;
  const singleId = selectedIds.length === 1 ? selectedIds[0] : (selected3DNodes[0]?.id ?? null);

  // Compute centroid (group center) for single or multi-layer selection
  let sumX = 0, sumY = 0, sumZ = 0;
  let firstRot = { rotX: 0, rotY: 0, rotZ: 0 };
  let firstScale = { scaleX: 1, scaleY: 1, scaleZ: 1 };

  selected3DNodes.forEach(({ tv, frame }, idx) => {
    // SAMPLED at the frame (animated tracks win) — the renderer draws the
    // sampled value, so anchoring the gizmo on static base props desynced it
    // off any keyframed layer (Bug: gizmo/object desync). The WORLD position:
    // a parented layer's local x/y/z is in its parent's space.

    sumX += frame.world.x;
    sumY += frame.world.y;
    sumZ += frame.world.z;

    if (idx === 0) {
      firstRot = { rotX: tv.rotationX, rotY: tv.rotationY, rotZ: tv.rotation };
      firstScale = { scaleX: tv.scaleX, scaleY: tv.scaleY, scaleZ: tv.scaleZ };
    }
  });

  const count = Math.max(1, selected3DNodes.length);
  const position3D: Vec3 = {
    x: sumX / count,
    y: sumY / count,
    z: sumZ / count,
  };

  const nodeRotation = firstRot;
  const nodeScale = firstScale;
  // The first layer's frame (parent chain + Orientation) orients the Local axes.
  const firstFrame = selected3DNodes[0]?.frame;
  const localFrame = firstFrame ? { parent: firstFrame.parent, orientation: firstFrame.orientation } : undefined;
  const localFrameRef = useRef(localFrame);
  localFrameRef.current = localFrame;

  // Camera / ortho axis / scene gizmos come from the SHARED resolver, which the
  // read-only inspection panes use too — one resolution path, so the panes and
  // the interactive viewport cannot disagree about where anything sits.
  const { camera, orthoView, sceneGizmos, groundGridVisible, groundLevel, scene3d } = refGeometry;

  // Comp → canvas view transform (RenderView: canvasPx = compPx·scale + offset,
  // CSS px). Kept in state and re-synced on wheel / pointer input so the SVG
  // overlay follows viewport pan & zoom.
  const [viewTransform, setViewTransform] = useState<RenderView>(() => readViewRef.current());
  useEffect(() => {
    const sync = (): void => {
      const v = readViewRef.current();
      setViewTransform((prev) =>
        prev.scale === v.scale && prev.offsetX === v.offsetX && prev.offsetY === v.offsetY ? prev : v,
      );
    };
    // Coalesced to one sync per animation frame. Wheel and pointermove fire
    // far above frame rate (120+ Hz on trackpads), and each changed view used
    // to setState → re-render the whole SVG overlay (every frustum, light
    // cone and layer box re-projected through React) per EVENT — several full
    // reconciliations per painted frame during a zoom, which is exactly the
    // "the 3D wireframes lag and stutter while zooming" feel. One rAF behind
    // the engine's own rAF-coalesced render keeps the overlay at most a frame
    // behind the canvas, at a fraction of the work.
    let rafId: number | null = null;
    const queueSync = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        sync();
      });
    };
    sync();
    window.addEventListener('wheel', queueSync, { passive: true, capture: true });
    window.addEventListener('pointermove', queueSync, { capture: true });
    window.addEventListener('pointerup', queueSync, { capture: true });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('wheel', queueSync, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', queueSync, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointerup', queueSync, { capture: true } as EventListenerOptions);
    };
    // `viewRev` re-syncs for framing changes no pointer event announces (a
    // pane auto-fitting on resize); the reader itself lives in a ref.
  }, [viewRev]);

  const renderedGizmoRef = useRef<RenderedGizmo3D | null>(null);

  if (is3D) {
    // Screen-constant gizmo (AE-style): the overlay group is scaled by the
    // viewport zoom, so build the gizmo in comp px sized 85 / scale — it then
    // always occupies ~85 CSS px on screen regardless of zoom.
    const viewScale = viewTransform.scale || 1;
    renderedGizmoRef.current = Gizmo3D.buildRenderedGizmo3D(
      position3D,
      nodeRotation,
      camera,
      orthoView,
      { gizmoState, axisMode, gizmoLengthPx: 85 / viewScale, frame: localFrame },
      compWidth,
      compHeight,
    );
  } else {
    // Clear it. Leaving the last gizmo behind meant the capture-phase pointerdown
    // handler could hit-test against a stale gizmo for a selection that is no
    // longer 3D (or no longer selected) and swallow the click.
    renderedGizmoRef.current = null;
  }

  // Pointer event handlers for 3D Gizmo interaction
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !is3D || selected3DNodes.length === 0) return;

    const getStageLocal = (e: MouseEvent): { x: number; y: number } => {
      const rect = stage.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // Comp space mouse coordinate (factoring out viewport zoom and pan).
    // RenderView is canvasPx = compPx·scale + offset ⇒ comp = (canvas − offset)/scale.
    const getCompLocal = (stagePt: { x: number; y: number }): { x: number; y: number } => {
      return Gizmo3D.viewportToComp(stagePt, readViewRef.current());
    };

    // Hit thresholds are in comp px — scale a fixed on-screen tolerance down.
    const hitTolerance = (): number => {
      const s = readViewRef.current().scale || 1;
      return 12 / s;
    };

    const showSnapIndicator = (lines: readonly SnapLine[]): void => {
      try {
        getWorkspaceController().ws.setSnapIndicator(lines);
      } catch {
        /* no workspace (tests) */
      }
    };
    const endSnap = (): void => {
      if (snapRef.current?.shown) showSnapIndicator([]);
      snapRef.current = null;
    };

    /**
     * Snap a translate move's result onto a feature, constrained to the axis
     * (`dir` = axis) or plane (`dir` = normal) being dragged. Ctrl/Cmd toggles
     * snapping for the move, like the 2D tools.
     */
    const snapTranslate = (kind: 'axis' | 'plane', moved: Vec3, dir: Vec3, start: Vec3, e: PointerEvent): Vec3 => {
      const snap = snapRef.current;
      if (!snap) return moved;
      const hit = snapActive(snap.enabled, e.ctrlKey || e.metaKey)
        ? snapGizmoTranslate({
            kind,
            start,
            moved,
            dir,
            view: { camera, orthoView: orthoView ?? null, width: compWidth, height: compHeight },
            points: snap.points,
            threshold: snap.thresholdWorld,
          })
        : null;
      if (hit || snap.shown) {
        showSnapIndicator(hit ? pointLines(hit.target, snap.thresholdWorld) : []);
        snap.shown = hit !== null;
      }
      return hit ? hit.pos : moved;
    };

    /** The live drag: recompute every selected layer's values from the drag-start state. */
    const applyDrag = (dragState: DragState3D, stagePt: { x: number; y: number }, compPt: { x: number; y: number }, mods: { shift: boolean; snapToggle: boolean; event: PointerEvent | null }): void => {
      const ray = Project3D.unprojectScreenRay(compPt.x, compPt.y, camera, orthoView, compWidth, compHeight);
      const basis = Gizmo3D.getGizmoBasis(axisMode, dragState.startRot3D, camera, localFrameRef.current);
      const typed = Gizmo3DMath.typedValue(dragState.typed);

      let newPos = { ...dragState.startPos3D };
      const newRot = { ...dragState.startRot3D };
      const newScale = { ...dragState.startScale3D };
      /** A world-axis turn every layer takes in place (view ring, trackball). */
      let worldTurn: { axis: Vec3; angleRad: number } | null = null;

      const handle = dragState.handle;

      if (handle === 'pos_x' || handle === 'pos_y' || handle === 'pos_z') {
        const axisDir = handle === 'pos_x' ? basis.x : handle === 'pos_y' ? basis.y : basis.z;
        // Ray/axis intersection is SINGULAR when the axis points at the camera:
        // `closestPointRayAxis` divides by `a*c - b*b`, which goes to 0, and
        // returns tAxis = 0 — so dragging the Z arrow in a front view (the
        // default view, where basis.z faces the viewer) did precisely nothing.
        // Fall back to vertical screen travel, AE-style: drag up pushes the
        // layer along +axis, away from the camera.
        const axisEntry = renderedGizmoRef.current?.axes.find((a) => a.type === handle);
        let tAxis: number;
        if (typed !== null) {
          tAxis = typed;
        } else if (axisEntry?.degenerate) {
          const viewScale = readViewRef.current().scale || 1;
          tAxis = -(stagePt.y - dragState.startMouseScreen.y) / viewScale;
        } else {
          tAxis = Project3D.closestPointRayAxis(ray, dragState.startPos3D, axisDir).tAxis;
        }
        if (mods.shift && typed === null) tAxis = Gizmo3DMath.snapIncrement(tAxis, SNAP_MOVE);
        newPos = {
          x: dragState.startPos3D.x + axisDir.x * tAxis,
          y: dragState.startPos3D.y + axisDir.y * tAxis,
          z: dragState.startPos3D.z + axisDir.z * tAxis,
        };
        // An axis pointing at the camera has no screen line to snap along.
        if (!axisEntry?.degenerate && typed === null && !mods.shift && mods.event) {
          newPos = snapTranslate('axis', newPos, axisDir, dragState.startPos3D, mods.event);
        }
      } else if (handle === 'plane_xy' || handle === 'plane_xz' || handle === 'plane_yz') {
        const normal = handle === 'plane_xy' ? basis.z : handle === 'plane_xz' ? basis.y : basis.x;
        const hit = Project3D.intersectRayPlane(ray, dragState.startPos3D, normal);
        if (hit) {
          if (mods.shift) {
            // Increment-snap the move along the plane's two axes.
            const u = handle === 'plane_yz' ? basis.y : basis.x;
            const v = handle === 'plane_xy' ? basis.y : basis.z;
            const d = { x: hit.x - dragState.startPos3D.x, y: hit.y - dragState.startPos3D.y, z: hit.z - dragState.startPos3D.z };
            const du = Gizmo3DMath.snapIncrement(d.x * u.x + d.y * u.y + d.z * u.z, SNAP_MOVE);
            const dv = Gizmo3DMath.snapIncrement(d.x * v.x + d.y * v.y + d.z * v.z, SNAP_MOVE);
            newPos = {
              x: dragState.startPos3D.x + u.x * du + v.x * dv,
              y: dragState.startPos3D.y + u.y * du + v.y * dv,
              z: dragState.startPos3D.z + u.z * du + v.z * dv,
            };
          } else {
            newPos = mods.event ? snapTranslate('plane', hit, normal, dragState.startPos3D, mods.event) : hit;
          }
        }
      } else if (handle === 'rot_x' || handle === 'rot_y' || handle === 'rot_z') {
        // Delta rotation relative to the grab point:
        //   rot_z — true relative angle around the gizmo centre (comp space);
        //   rot_x / rot_y — the pointer ray against the ring's plane.
        let deltaDeg = 0;
        if (handle === 'rot_z') {
          deltaDeg = screenAngleDeg(dragState, compPt);
        } else {
          // rot_x / rot_y: TRUE arc-following, like rot_z above — intersect
          // the pointer ray with the ring's plane at grab time and now, and
          // take the angle between the two hits about the centre in the
          // plane's own basis. The travel mapping survives as the fallback
          // when the ring is edge-on (the plane intersection degenerates there).
          const axis = handle === 'rot_x' ? basis.x : basis.y;
          const u = handle === 'rot_x' ? basis.y : basis.z;
          const v = handle === 'rot_x' ? basis.z : basis.x;
          const edgeOn =
            Math.abs(ray.direction.x * axis.x + ray.direction.y * axis.y + ray.direction.z * axis.z) < 0.08;
          const ray0 = Project3D.unprojectScreenRay(
            dragState.startMouseComp.x, dragState.startMouseComp.y,
            camera, orthoView, compWidth, compHeight,
          );
          const hitNow = edgeOn ? null : Project3D.intersectRayPlane(ray, dragState.startPos3D, axis);
          const hit0 = edgeOn ? null : Project3D.intersectRayPlane(ray0, dragState.startPos3D, axis);
          if (hitNow && hit0) {
            const C = dragState.startPos3D;
            const ang = (p: Vec3): number => Math.atan2(
              (p.x - C.x) * v.x + (p.y - C.y) * v.y + (p.z - C.z) * v.z,
              (p.x - C.x) * u.x + (p.y - C.y) * u.y + (p.z - C.z) * u.z,
            );
            deltaDeg = ((ang(hitNow) - ang(hit0)) * 180) / Math.PI;
            if (deltaDeg > 180) deltaDeg -= 360;
            if (deltaDeg < -180) deltaDeg += 360;
          } else if (handle === 'rot_x') {
            deltaDeg = -(stagePt.y - dragState.startMouseScreen.y) * 0.5;
          } else {
            deltaDeg = (stagePt.x - dragState.startMouseScreen.x) * 0.5;
          }
        }
        if (typed !== null) deltaDeg = typed;
        // Shift snaps rotation to 15° increments (AE standard)
        else if (mods.shift) deltaDeg = Gizmo3DMath.snapIncrement(deltaDeg, SNAP_DEG);

        if (handle === 'rot_x') newRot.rotX = dragState.startRot3D.rotX + deltaDeg;
        else if (handle === 'rot_y') newRot.rotY = dragState.startRot3D.rotY + deltaDeg;
        else newRot.rotZ = dragState.startRot3D.rotZ + deltaDeg;
      } else if (handle === 'rot_outer') {
        // The view-facing ring: about the view axis, by the angle swept round the centre.
        let deltaDeg = typed ?? screenAngleDeg(dragState, compPt);
        if (typed === null && mods.shift) deltaDeg = Gizmo3DMath.snapIncrement(deltaDeg, SNAP_DEG);
        const view = Gizmo3D.getGizmoBasis('view', dragState.startRot3D, camera);
        worldTurn = { axis: view.z, angleRad: (deltaDeg * Math.PI) / 180 };
      } else if (handle === 'rot_free') {
        // Free trackball: the pointer's travel turns about the view's up / right axes.
        const view = Gizmo3D.getGizmoBasis('view', dragState.startRot3D, camera);
        const t = Gizmo3DMath.trackballRotation(stagePt.x - dragState.startMouseScreen.x, stagePt.y - dragState.startMouseScreen.y, view.x, view.y);
        worldTurn = mods.shift
          ? { axis: t.axis, angleRad: (Gizmo3DMath.snapIncrement((t.angleRad * 180) / Math.PI, SNAP_DEG) * Math.PI) / 180 }
          : t;
      } else if (handle === 'scale_x' || handle === 'scale_y' || handle === 'scale_z') {
        // Axis-projected: travel along the arm AS DRAWN on screen, so a handle
        // that points down-left grows when dragged down-left (AE parity 4.6).
        const dir = dragState.scaleAxis?.dir ?? { x: handle === 'scale_x' ? 1 : 0, y: handle === 'scale_x' ? 0 : -1 };
        const dist = dragState.scaleAxis?.dist ?? 60;
        let factor = typed !== null
          ? typed / 100
          : Gizmo3DMath.axisScaleFactor(compPt.x - dragState.startMouseComp.x, compPt.y - dragState.startMouseComp.y, dir, dist);
        if (typed === null && mods.shift) factor = Math.max(SNAP_SCALE, Gizmo3DMath.snapIncrement(factor, SNAP_SCALE));
        if (handle === 'scale_x') newScale.scaleX = dragState.startScale3D.scaleX * factor;
        if (handle === 'scale_y') newScale.scaleY = dragState.startScale3D.scaleY * factor;
        if (handle === 'scale_z') newScale.scaleZ = dragState.startScale3D.scaleZ * factor;
      } else if (handle === 'scale_center') {
        // Uniform: up-right grows, down-left shrinks, 1% per px.
        const dxPx = stagePt.x - dragState.startMouseScreen.x;
        const dyPx = stagePt.y - dragState.startMouseScreen.y;
        let factor = typed !== null ? typed / 100 : Math.max(0.01, 1 + ((dxPx - dyPx) / 2) * 0.01);
        if (typed === null && mods.shift) factor = Math.max(SNAP_SCALE, Gizmo3DMath.snapIncrement(factor, SNAP_SCALE));
        newScale.scaleX = dragState.startScale3D.scaleX * factor;
        newScale.scaleY = dragState.startScale3D.scaleY * factor;
        newScale.scaleZ = dragState.startScale3D.scaleZ * factor;
      }

      const deltaX = newPos.x - dragState.startPos3D.x;
      const deltaY = newPos.y - dragState.startPos3D.y;
      const deltaZ = newPos.z - dragState.startPos3D.z;

      const deltaRotX = newRot.rotX - dragState.startRot3D.rotX;
      const deltaRotY = newRot.rotY - dragState.startRot3D.rotY;
      const deltaRotZ = newRot.rotZ - dragState.startRot3D.rotZ;

      // Per-axis factors. A single factor derived from scaleX made `scale_y` a
      // no-op: that handle only changes scaleY, so the X ratio stayed 1 and the
      // update below multiplied both axes by 1.
      const scaleFactorX = newScale.scaleX / Math.max(0.001, dragState.startScale3D.scaleX);
      const scaleFactorY = newScale.scaleY / Math.max(0.001, dragState.startScale3D.scaleY);
      const scaleFactorZ = newScale.scaleZ / Math.max(0.001, dragState.startScale3D.scaleZ);

      // Apply to all selected 3D nodes by the viewport's dual write rule:
      // props with a lit stopwatch (or Auto-Keyframe on) key at the playhead —
      // a base-only write is invisible on keyframed layers because the
      // renderer samples the track first — and static props write the base.
      // One undo entry per drag (the engine gesture opened on press).
      // Only the handle's own props: a position drag must not touch (and
      // possibly keyframe) rotation or scale tracks, and vice versa.
      // Several layers: each moves by the same world delta, turns in place by
      // the same amount and scales by the same factors (AE's multi-layer gizmo).
      const isPosHandle = handle.startsWith('pos_') || handle.startsWith('plane_');
      const isScaleHandle = handle.startsWith('scale_');
      const updates: Gizmo3DNodeUpdate[] = (dragState.initialNodeStates ?? []).map((st) => {
        const values: Record<string, number> = {};
        if (isPosHandle) {
          // The move is a WORLD delta; a parented layer stores parent-space values.
          Object.assign(values, toParentSpace(st.parent, { x: st.world.x + deltaX, y: st.world.y + deltaY, z: st.world.z + deltaZ }));
          if (dragState.pivot) {
            // Pan Behind: the anchor follows in the layer's own space, so the
            // layer stays put while its pivot (and the gizmo) moves.
            const { anchorDelta } = Gizmo3DMath.pivotEdit(
              { x: deltaX, y: deltaY, z: deltaZ },
              { parent: st.parent, orientation: st.orientation },
              st.rot,
              { x: st.scale.scaleX, y: st.scale.scaleY, z: st.scale.scaleZ },
            );
            values.anchorX = st.anchor.x + anchorDelta.x;
            values.anchorY = st.anchor.y + anchorDelta.y;
            values.anchorZ = st.anchor.z + anchorDelta.z;
          }
        }
        if (handle === 'rot_x') values.rotationX = st.rot.rotX + deltaRotX;
        if (handle === 'rot_y') values.rotationY = st.rot.rotY + deltaRotY;
        if (handle === 'rot_z') values.rotation = st.rot.rotZ + deltaRotZ;
        if (worldTurn) {
          const r = Gizmo3DMath.rotateEulerAboutWorldAxis(st.rot, { parent: st.parent, orientation: st.orientation }, worldTurn.axis, worldTurn.angleRad);
          values.rotationX = r.rotX;
          values.rotationY = r.rotY;
          values.rotation = r.rotZ;
        }
        // Each axis only from a handle that changes it: writing an unchanged
        // value alongside would put a keyframe on a track the drag never
        // touched under Auto-Keyframe.
        if (isScaleHandle && (handle === 'scale_x' || handle === 'scale_center')) values.scaleX = st.scale.scaleX * scaleFactorX;
        if (isScaleHandle && (handle === 'scale_y' || handle === 'scale_center')) values.scaleY = st.scale.scaleY * scaleFactorY;
        if (isScaleHandle && (handle === 'scale_z' || handle === 'scale_center')) values.scaleZ = st.scale.scaleZ * scaleFactorZ;
        return { id: st.id, values: values as Gizmo3DNodeUpdate['values'] };
      });
      // The dual path as commands: a property with a lit stopwatch (or any
      // while Auto-Keyframe is on) keys at the playhead, the rest take the
      // value. Absolute (drag-start state + this move), latest wins.
      const s = useProjectStore.getState();
      const cmds = trackValueCommands(
        updates.map((u) => ({ nodeId: u.id, values: u.values as Record<string, number> })),
        { seconds: s.tabs[s.activeTabId ?? '']?.time ?? 0, autoKeyframe: usePreferenceStore.getState().timelineAutoKeyframe },
      );
      // null: a node the engine does not address (not a composition's layer,
      // or a member with no API property) — nothing the API can record.
      if (cmds) gestureRef.current?.send(cmds);

      // Live truth into the ref; the React mirror (which the measurement
      // HUD renders from) syncs at most once per frame.
      const first = updates[0]?.values as Record<string, number> | undefined;
      dragRef.current = {
        ...dragState,
        currentPos3D: newPos,
        currentRot3D: worldTurn && first
          ? { rotX: first.rotationX ?? newRot.rotX, rotY: first.rotationY ?? newRot.rotY, rotZ: first.rotation ?? newRot.rotZ }
          : newRot,
        currentScale3D: newScale,
        mouseScreen: stagePt,
      };
      if (dragHudRaf.current === null) {
        dragHudRaf.current = requestAnimationFrame(() => {
          dragHudRaf.current = null;
          setDragState(dragRef.current);
        });
      }
    };

    /** The angle (degrees, -180…180) swept round the gizmo centre since the grab, comp space. */
    const screenAngleDeg = (dragState: DragState3D, compPt: { x: number; y: number }): number => {
      const center = renderedGizmoRef.current
        ? { x: renderedGizmoRef.current.centerScreen.x, y: renderedGizmoRef.current.centerScreen.y }
        : { x: dragState.startPos3D.x, y: dragState.startPos3D.y };
      const a0 = Math.atan2(dragState.startMouseComp.y - center.y, dragState.startMouseComp.x - center.x);
      const a1 = Math.atan2(compPt.y - center.y, compPt.x - center.x);
      let deltaDeg = ((a1 - a0) * 180) / Math.PI;
      if (deltaDeg > 180) deltaDeg -= 360;
      if (deltaDeg < -180) deltaDeg += 360;
      return deltaDeg;
    };

    /** The last pointer position and modifiers, so a typed key can re-run the drag. */
    const lastPointer = { stage: { x: 0, y: 0 }, comp: { x: 0, y: 0 }, shift: false };

    const onPointerMove = (e: PointerEvent) => {
      const stagePt = getStageLocal(e);
      const compPt = getCompLocal(stagePt);

      const dragState = dragRef.current;
      if (dragState && dragState.active) {
        lastPointer.stage = stagePt;
        lastPointer.comp = compPt;
        lastPointer.shift = e.shiftKey;
        applyDrag(dragState, stagePt, compPt, { shift: e.shiftKey, snapToggle: e.ctrlKey || e.metaKey, event: e });
        return;
      }

      // Hover hit-testing
      if (renderedGizmoRef.current) {
        const hit = Gizmo3D.hitTestGizmo3D(compPt, renderedGizmoRef.current, hitTolerance());
        setHoverHandle(hit);
      }
    };

    /**
     * Keys while dragging (AE parity 4.6): digits, '.', '-' and Backspace type
     * an exact value (px along the axis, degrees, or percent), Enter commits
     * the drag, Escape cancels it (the engine reverts the gesture).
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      const dragState = dragRef.current;
      if (!dragState?.active) return;
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finishDrag(e.key === 'Enter');
        return;
      }
      const next = Gizmo3DMath.typedValueKey(dragState.typed, e.key);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      const updated = { ...dragState, typed: next };
      dragRef.current = updated;
      applyDrag(updated, lastPointer.stage, lastPointer.comp, { shift: lastPointer.shift, snapToggle: false, event: null });
    };

    /** End the drag: commit (pointer up, Enter) or cancel (Escape). */
    const finishDrag = (commit: boolean, pointerId?: number): void => {
      if (pointerId !== undefined) {
        try {
          stage.releasePointerCapture(pointerId);
        } catch {
          /* best-effort */
        }
      }
      endViewportGesture();
      const g = gestureRef.current;
      gestureRef.current = null;
      void (commit ? g?.end() : g?.cancel());
      endSnap();
      dragRef.current = null;
      if (dragHudRaf.current !== null) {
        cancelAnimationFrame(dragHudRaf.current);
        dragHudRaf.current = null;
      }
      setActiveHandle(null);
      setDragState(null);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !renderedGizmoRef.current) return;
      // Alt+drag is viewport camera navigation (orbit / track — useWorkspace);
      // never start a gizmo transform drag from an Alt press.
      if (e.altKey) return;
      // The C-key camera tool owns plain left-drags while active — let the
      // press fall through to useWorkspace's camera navigation.
      if (useGuidesStore.getState().cameraTool !== 'none') return;
      const stagePt = getStageLocal(e);
      const compPt = getCompLocal(stagePt);

      const hit = Gizmo3D.hitTestGizmo3D(compPt, renderedGizmoRef.current, hitTolerance());
      if (hit) {
        // CLAIM the press before the canvas selection layer sees it. This
        // listener runs on the STAGE in the CAPTURE phase — useWorkspace's
        // pointerdown listens on the overlay canvas (a descendant), so
        // stopPropagation here is what keeps a gizmo grab from clearing /
        // re-running selection (which unmounted the gizmo mid-click).
        e.stopPropagation();
        e.preventDefault();
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }

        // Anchor the drag on the SAMPLED transform at the playhead (same read
        // the gizmo display and the renderer use), not the static base props.
        // Nodes are re-fetched at event time so the anchor is never a stale
        // render-closure value.
        const initialNodeStates = selected3DNodes
          .map((n) => ({ id: n.id, tv: transform3DOf(recordOfRef.current(n.id)), frame: gizmoFrameOf(recordOfRef.current(n.id)) }))
          .filter((n): n is { id: string; tv: Transform3DValues; frame: GizmoFrame } => n.tv !== null && n.frame !== null)
          .map(({ id, tv, frame }) => {
            const m = documentMirror();
            const sec = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
            const anchor = (track: string): number => readTrack(m, id, track, sec) ?? 0;
            return {
              id,
              pos: { x: tv.x, y: tv.y, z: tv.z },
              world: frame.world,
              parent: frame.parent,
              rot: { rotX: tv.rotationX, rotY: tv.rotationY, rotZ: tv.rotation },
              scale: { scaleX: tv.scaleX, scaleY: tv.scaleY, scaleZ: tv.scaleZ },
              orientation: frame.orientation,
              anchor: { x: anchor('anchorX'), y: anchor('anchorY'), z: anchor('anchorZ') },
            };
          });
        if (initialNodeStates.length === 0) return;

        // Translate drags snap (main viewport only). Features of the dragged
        // layers themselves are excluded, as a 2D move excludes them.
        endSnap();
        if (mainViewRef.current && (hit.startsWith('pos_') || hit.startsWith('plane_'))) {
          try {
            const f = getWorkspaceController().ws.snapFeatures(new Set(initialNodeStates.map((s) => s.id)));
            snapRef.current = { ...f, shown: false };
          } catch {
            snapRef.current = null;
          }
        }

        // Fresh centroid + first-node rot/scale (mirrors the render-path math).
        const n = initialNodeStates.length;
        const startPos: Vec3 = {
          x: initialNodeStates.reduce((a, s) => a + s.world.x, 0) / n,
          y: initialNodeStates.reduce((a, s) => a + s.world.y, 0) / n,
          z: initialNodeStates.reduce((a, s) => a + s.world.z, 0) / n,
        };
        const first = initialNodeStates[0]!;
        const startRot = { ...first.rot };
        const startScale = { scaleX: first.scale.scaleX, scaleY: first.scale.scaleY, scaleZ: first.scale.scaleZ };

        // The drag flag for the whole gizmo drag (viewportGesture) — the RAM
        // preview must not serve the pre-drag frame while the layer moves.
        beginViewportGesture();
        void gestureRef.current?.end();
        const pivot = pivotModeRef.current && (hit.startsWith('pos_') || hit.startsWith('plane_'));
        gestureRef.current = new GestureSession(
          pivot ? 'Move Anchor Point' : hit.startsWith('rot_') ? 'Rotate' : hit.startsWith('scale_') ? 'Scale' : 'Move',
        );
        // A scale handle's arm on screen (axis-projected scale): the Universal
        // cube, or the Scale gizmo's arm tip.
        const g = renderedGizmoRef.current;
        let scaleAxis: DragState3D['scaleAxis'];
        if (hit === 'scale_x' || hit === 'scale_y' || hit === 'scale_z') {
          const cube = g.scaleHandles.find((h) => h.type === hit);
          const arm = g.axes.find((a) => a.type === hit);
          if (cube) scaleAxis = { dir: cube.screenDir, dist: cube.screenDist };
          else if (arm && arm.screenLen > 0) {
            scaleAxis = {
              dir: { x: (arm.endScreen.x - arm.startScreen.x) / arm.screenLen, y: (arm.endScreen.y - arm.startScreen.y) / arm.screenLen },
              dist: arm.screenLen,
            };
          }
        }
        setActiveHandle(hit);
        const start: DragState3D = {
          active: true,
          handle: hit,
          startPos3D: startPos,
          currentPos3D: { ...startPos },
          startRot3D: startRot,
          currentRot3D: { ...startRot },
          startScale3D: startScale,
          currentScale3D: { ...startScale },
          startMouseScreen: stagePt,
          startMouseComp: compPt,
          mouseScreen: stagePt,
          typed: '',
          pivot,
          ...(scaleAxis ? { scaleAxis } : {}),
          initialNodeStates,
        };
        lastPointer.stage = stagePt;
        lastPointer.comp = compPt;
        lastPointer.shift = e.shiftKey;
        dragRef.current = start;
        setDragState(start);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (dragRef.current && dragRef.current.active) finishDrag(true, e.pointerId);
    };

    // Capture phase on the STAGE (the overlay canvas' ancestor): the gizmo
    // must see the press BEFORE useWorkspace's overlay-level pointerdown.
    // Both used to listen on the same canvas element, where stopPropagation
    // cannot suppress a sibling listener — so clicking the gizmo also ran
    // canvas selection (deselect on empty backdrop → gizmo vanished).
    stage.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    // Capture: typed values and Esc while dragging win over the shortcut manager.
    window.addEventListener('keydown', onKeyDown, { capture: true });

    return () => {
      stage.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
      // Rebinding (or unmounting) mid-drag must close the gesture transaction.
      if (dragRef.current) {
        endViewportGesture();
        dragRef.current = null;
      }
      // Commit (nothing the user saw is lost) — the rebinding / unmount rule.
      void gestureRef.current?.end();
      gestureRef.current = null;
      endSnap();
      if (dragHudRaf.current !== null) {
        cancelAnimationFrame(dragHudRaf.current);
        dragHudRaf.current = null;
      }
    };
    // `dragState` is deliberately NOT a dep — the handlers read `dragRef`, so
    // listeners survive a whole drag instead of re-attaching per pointermove.
    // `selectedIds` (not just `singleId`) because onPointerDown snapshots the
    // selection's nodes: a multi-select change that keeps the same primary id
    // must still rebind the closure.
  }, [is3D, singleId, selectedIds, axisMode, mode, customViews, compWidth, compHeight, time, gizmoState]);

  return {
    /** Looking THROUGH a scene camera (Active Camera / Camera N), not at the scene from outside. */
    throughSceneCamera: isSceneCameraView(mode),
    is3D,
    scene3d,
    sceneGizmos,
    singleId,
    position3D,
    nodeRotation,
    nodeScale,
    localFrame,
    camera,
    orthoView,
    compWidth,
    compHeight,
    viewTransform,
    gizmoState,
    axisMode,
    groundGridVisible,
    groundLevel,
    activeHandle,
    hoverHandle,
    dragState,
  };
}
