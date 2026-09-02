/**
 * FocusPlaneOverlay — where the camera is focused, drawn in the viewport and
 * draggable.
 *
 * ## The gap this closes
 *
 * A camera's depth of field is authored as three bare numbers in the inspector,
 * and one of them — Focus Distance — is a POSITION in the scene expressed as a
 * scalar. Everything else spatial about a camera already has viewport geometry:
 * the frustum says what it sees, the POI crosshair says what it aims at, both
 * are draggable. Focus was the one spatial property you had to type, guess at,
 * render, and look. This draws it where it actually is and lets you pull it.
 *
 * ## Why it is a separate overlay
 *
 * `SceneGeometryOverlay` is shared with the read-only inspection panes and is
 * rendered inside `Gizmo3dOverlay`'s pointer-transparent SVG. This one owns a
 * pointer interaction, so it follows `EffectHandleOverlay`'s shape instead: its
 * own SVG with `pointer-events: none`, and exactly one interactive circle at
 * the handle. Everything else on the stage — layer picking, the camera tools,
 * panning — keeps working untouched, because nothing but the handle can be hit.
 *
 * The projection is not a new one: the camera and ortho axis come from
 * `useSceneRefGeometry`, the same resolver the wireframes and the renderer use,
 * so the plane cannot land somewhere the frustum it belongs to is not.
 *
 * ## Where it deliberately does NOT appear
 *
 *  • **2D compositions.** No camera, nothing drawn — and `scene3d` gates it, so
 *    a flat comp never grows chrome describing a 3D concept.
 *  • **Through its own camera.** In Active Camera view the focus plane's
 *    cross-section is exactly the comp frame and its axis projects to a point:
 *    the rectangle would trace the comp edges and the handle could not be
 *    dragged in any direction that means anything. This is the same suppression
 *    `collectSceneGizmos` and `collectDeviceHandles` already apply to the
 *    camera being looked through. Switch to Top / Left / a custom view — which
 *    is where you pull focus in After Effects too.
 *
 * ## One overlay per VIEW
 *
 * Everything above is stated per view, not per app: the props let a secondary
 * 2-up / 4-up pane mount its own instance bound to ITS mode and ITS comp →
 * canvas transform. Mount it with no props and it reads the main viewport, as
 * it always did. The suppression rule then falls out correctly on its own — a
 * 4-up of Active / Top / Front / Right draws the plane in the three ortho
 * panes and not in the one looking down the barrel.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Project3D, type Vec3 } from '@motion/scene';
import { Gizmo3D, SceneGizmos } from '@motion/workspace';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useFocusPlaneStore } from '@stores/focusPlaneStore';
import { useSceneRevisionFrame } from '@hooks/useSceneRevisionFrame';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { applyNodePropsKeyframed } from '@core/workspace/ports';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { toWorldPointAt } from '@core/scene/liveWorld3d';
import {
  activeCameraNode,
  cameraFromNode,
  focusRangeAt,
  readNodeDof,
} from '@core/scene/camera3d';
import type { RenderView } from '@core/rendering/RenderBackend';
import { useSceneRefGeometry } from './useSceneRefGeometry';
import {
  buildFocusPlaneGizmo,
  focusDistanceFromDrag,
  screenAxisPerUnit,
  type FocusRingKind,
} from './focusPlane';
import styles from './FocusPlaneOverlay.module.css';

/**
 * The circle of confusion, in comp px, at which the near/far bands are drawn.
 *
 * A depth of field is only defined relative to how much softness counts as
 * sharp; a shade over one pixel is the familiar answer and is honest at any
 * zoom, because the blur radii the renderer computes are comp px too.
 */
const BAND_COC_PX = 1.2;

/** Screen-px grab radius — the 12px the device handles already use. */
const HANDLE_PICK_R = 12;

/**
 * Pink, dashed, and the same pink the POI crosshair uses.
 *
 * Both describe a RELATIONSHIP the camera has to a place in the scene rather
 * than a thing that exists there, which is exactly the distinction the overlay's
 * colour language already draws (see SEGMENT_STYLE in SceneGeometryOverlay:
 * frustums are blue "reach", bodies amber, POI pink and dashed). A new colour
 * here would have added a fourth meaning nobody could look up.
 */
const FOCUS_COLOR = '#ff9ecb';

const RING_STYLE: Record<FocusRingKind, { width: number; dash: string; opacity: number }> = {
  focus: { width: 1.6, dash: '7 4', opacity: 0.95 },
  // The band edges read as the SOFT limits they are: thinner, finer dash, and
  // faint enough that the focus plane stays the thing you look at.
  near: { width: 1, dash: '3 5', opacity: 0.4 },
  far: { width: 1, dash: '3 5', opacity: 0.4 },
};

/**
 * The comp → canvas transform, resynced at most once per frame.
 *
 * The same rAF coalescing `useGizmo3d` documents: wheel and pointermove fire
 * well above frame rate, and a setState per event re-renders the whole overlay
 * several times per painted frame during a zoom.
 */
function useViewTransform(getView?: () => RenderView | undefined, viewRev = 0): RenderView {
  // Behind a ref so a host re-rendering with a fresh closure does not re-attach
  // the window listeners; `viewRev` is the explicit "resync now" channel for
  // framing changes no pointer event announces (a pane auto-fitting).
  const readRef = useRef<() => RenderView>(() => getWorkspaceController().getView());
  readRef.current = getView
    ? (): RenderView => getView() ?? IDENTITY_VIEW
    : (): RenderView => getWorkspaceController().getView();
  const [view, setView] = useState<RenderView>(() => readRef.current());
  useEffect(() => {
    const sync = (): void => {
      const v = readRef.current();
      setView((prev) =>
        prev.scale === v.scale && prev.offsetX === v.offsetX && prev.offsetY === v.offsetY ? prev : v,
      );
    };
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
  }, [viewRev]);
  return view;
}

/** Identity view — the fallback while a pane's camera does not exist yet. */
const IDENTITY_VIEW: RenderView = { scale: 1, offsetX: 0, offsetY: 0 };

/** Which VIEW this overlay belongs to. Omit every field for the main viewport. */
export interface FocusPlaneOverlayProps {
  /** View mode to project through. Defaults to `guidesStore.camera3dMode`. */
  mode?: Camera3dMode;
  /**
   * This view's live comp → canvas transform, in CSS px relative to the
   * overlay's own box. Defaults to the main viewport's controller view.
   */
  getView?: () => RenderView | undefined;
  /** Bumped when `getView` would answer differently (a pane's `framingRev`). */
  viewRev?: number;
}

export function FocusPlaneOverlay({ mode: modeProp, getView, viewRev }: FocusPlaneOverlayProps = {}): JSX.Element | null {
  const visibility = useFocusPlaneStore((s) => s.visibility);
  const dragDistance = useFocusPlaneStore((s) => s.dragDistance);
  const mainMode = useGuidesStore((s) => s.camera3dMode);
  const camera3dMode = modeProp ?? mainMode;
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compRootId = useCompositionStore((s) => s.id);
  // Camera, ortho axis, the 3D-scene gate and the id of the camera this view
  // looks through — all from the resolver the wireframes and the inspection
  // panes share, so this overlay cannot disagree with them about the view.
  const { camera, orthoView, activeCameraId, scene3d } = useSceneRefGeometry(camera3dMode);
  const selectedIds = useSelectionStore((s) => s.ids);
  const time = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0));
  // Frame-coalesced: a focus drag bumps the revision per pointer event and this
  // overlay only has to track it visually.
  const sceneTick = useSceneRevisionFrame();
  const viewTransform = useViewTransform(getView, viewRev);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState(false);

  /**
   * The camera whose focus is on show.
   *
   * A SELECTED camera wins over the active one: if you picked a camera up, that
   * is the one you are asking about, even when the comp renders through
   * another. Selection is scanned back-to-front because paint order is
   * back-to-front, so the LAST match is the topmost — the same tie-break
   * `activeCameraNode` documents.
   */
  const target = useMemo(() => {
    if (visibility === 'off' || !scene3d) return null;
    const nodes = flattenComposition(defaultSceneGraph, compRootId);
    const picked = new Set(selectedIds);
    let node = null as (typeof nodes)[number] | null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n || !picked.has(n.id)) continue;
      if (readNodeKind(n) !== 'camera' || n.visible === false) continue;
      node = n;
      break;
    }
    if (!node && visibility === 'always') node = activeCameraNode(defaultSceneGraph, compRootId);
    if (!node) return null;
    // Never for the camera this view looks THROUGH — see the header note.
    if (camera3dMode === 'active' && node.id === activeCameraId) return null;

    const cameraNode = node;
    const values = defaultAnimation.evaluateNode(cameraNode.id, getRemappedTime(cameraNode.id, time));
    const sample = (id: string, prop: string): number | undefined =>
      id === cameraNode.id ? values.get(prop) : undefined;
    // Depth of field OFF (no blur level) means there is no focus plane to draw:
    // the property exists but changes no pixel, and chrome for an inert setting
    // is worse than none.
    const dof = readNodeDof(cameraNode, compWidth, compHeight, sample);
    if (!dof) return null;

    // The resolved eye — the parent lift `cameraFromNode` gets from the
    // renderer, so a camera on a null rig draws its plane where the rig put it.
    const cam = cameraFromNode(cameraNode, compWidth, compHeight, sample, (id, p) =>
      toWorldPointAt(id, time, p),
    );
    const gizmo = buildFocusPlaneGizmo({
      nodeId: cameraNode.id,
      eye: cam.position,
      frame: SceneGizmos.cameraBasis(
        cam.orientation?.yaw ?? 0,
        cam.orientation?.pitch ?? 0,
        cam.orientation?.roll ?? 0,
      ),
      focalLength: cam.focalLength,
      // `dof.focus` rather than a second read of the prop: it is the distance
      // the RENDERER focuses at, defaults folded in and all.
      distance: dof.focus,
      range: focusRangeAt(dof, BAND_COC_PX),
      compWidth,
      compHeight,
    });
    return gizmo;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneTick drives scene reads
  }, [visibility, scene3d, selectedIds, compRootId, compWidth, compHeight, time, camera3dMode, activeCameraId, sceneTick]);

  /** World → canvas CSS px, exactly as the scene wireframes are drawn. */
  const toScreen = useMemo(() => {
    return (p: Vec3): { x: number; y: number } => {
      const cp = orthoView
        ? Project3D.projectOrtho(p, orthoView, compWidth, compHeight)
        : Project3D.projectPoint(p, camera);
      return Gizmo3D.compToViewport(cp, viewTransform);
    };
  }, [orthoView, camera, compWidth, compHeight, viewTransform]);

  // Live values for the pointer listeners, which are attached once per element.
  const stateRef = useRef({ target, toScreen, time });
  stateRef.current = { target, toScreen, time };

  /**
   * The SVG only exists while there is a plane to draw, so the listeners have
   * to be re-attached when one appears. Keying the effect on the boolean — not
   * on `target` itself — means a camera MOVING does not tear the listeners
   * down and rebuild them on every frame of a drag.
   */
  const mounted = target !== null;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const localPt = (e: PointerEvent): { x: number; y: number } => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    let drag: {
      nodeId: string;
      startDistance: number;
      startPt: { x: number; y: number };
      axisPerUnit: { x: number; y: number };
    } | null = null;

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || e.altKey) return;
      const { target: giz, toScreen: project } = stateRef.current;
      if (!giz) return;
      // The camera tools own plain left-drags while one is armed.
      if (useGuidesStore.getState().cameraTool !== 'none') return;
      const at = project(giz.centre);
      const pt = localPt(e);
      if (Math.hypot(at.x - pt.x, at.y - pt.y) > HANDLE_PICK_R) return;

      e.stopPropagation();
      e.preventDefault();
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      drag = {
        nodeId: giz.nodeId,
        startDistance: giz.distance,
        startPt: pt,
        // Measured ONCE, at the press. Re-measuring per move against a plane
        // that has itself moved feeds the gesture back into its own input and
        // makes a slow drag accelerate.
        axisPerUnit: screenAxisPerUnit(giz.centre, giz.forward, project),
      };
      useFocusPlaneStore.getState().setDragDistance(giz.distance);
    };

    const onMove = (e: PointerEvent): void => {
      const pt = localPt(e);
      if (!drag) {
        const { target: giz, toScreen: project } = stateRef.current;
        if (!giz) {
          setHovered(false);
          return;
        }
        const at = project(giz.centre);
        setHovered(Math.hypot(at.x - pt.x, at.y - pt.y) <= HANDLE_PICK_R);
        return;
      }
      const next = focusDistanceFromDrag(drag.startDistance, drag.axisPerUnit, {
        x: pt.x - drag.startPt.x,
        y: pt.y - drag.startPt.y,
      });
      // The SAME write path the inspector's focus-distance row uses: the static
      // prop always, plus a keyframe at the playhead when the property is
      // animated or Auto-Keyframe is on. A base-only write is invisible on an
      // animated property — the renderer having sampled the track first — which
      // is exactly how a handle drag ends up looking broken on a rack focus.
      applyNodePropsKeyframed(drag.nodeId, { focusDistance: next }, `focusplane:${drag.nodeId}`);
      useFocusPlaneStore.getState().setDragDistance(next);
    };

    const onUp = (e: PointerEvent): void => {
      if (!drag) return;
      drag = null;
      useFocusPlaneStore.getState().setDragDistance(null);
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    return () => {
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
      useFocusPlaneStore.getState().setDragDistance(null);
    };
  }, [mounted]);

  if (!target) return null;

  const finite = (p: { x: number; y: number }): boolean =>
    Number.isFinite(p.x) && Number.isFinite(p.y);
  const centre = toScreen(target.centre);
  const active = dragDistance !== null;

  return (
    <svg
      ref={svgRef}
      aria-label="Camera focus plane"
      className={styles.overlay}
    >
      {target.rings.map((ring) => {
        const pts = ring.corners.map(toScreen);
        // A ring whose corners cross the near plane projects to non-finite
        // points; dropping it beats drawing a rectangle through infinity.
        if (!pts.every(finite)) return null;
        const st = RING_STYLE[ring.kind];
        return (
          <polygon
            key={ring.kind}
            points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill={ring.kind === 'focus' ? 'rgba(255, 158, 203, 0.06)' : 'none'}
            stroke={FOCUS_COLOR}
            strokeWidth={st.width}
            strokeOpacity={active && ring.kind === 'focus' ? 1 : st.opacity}
            strokeDasharray={st.dash}
          />
        );
      })}

      {finite(centre) && (
        <g>
          {/* The invisible fat target, at the same radius the hit test uses —
              anything you can see you can also grab. */}
          <circle
            cx={centre.x}
            cy={centre.y}
            r={HANDLE_PICK_R}
            fill="transparent"
            className={styles.hit}
          />
          {/* A dark ring under the fill keeps the dot legible over bright
              artwork as well as dark. */}
          <circle cx={centre.x} cy={centre.y} r={(hovered || active ? 7 : 5) + 1.5} fill="rgba(0,0,0,0.45)" />
          <circle
            cx={centre.x}
            cy={centre.y}
            r={hovered || active ? 7 : 5}
            fill={hovered || active ? FOCUS_COLOR : 'rgba(0,0,0,0.35)'}
            stroke={FOCUS_COLOR}
            strokeWidth={1.5}
          />
          {active && (
            <foreignObject
              x={centre.x + 12}
              y={centre.y - 30}
              width={200}
              height={32}
              className={styles.hudHost}
            >
              <div className={styles.hud}>
                <span className={styles.hudDot} />
                Focus {Math.round(dragDistance)} px
              </div>
            </foreignObject>
          )}
        </g>
      )}
    </svg>
  );
}

export default FocusPlaneOverlay;
