/**
 * AxisWidgetOverlay — the 3D view cube (AE parity 4.6).
 *
 * A fixed-size cube in the bottom-left of the viewport, turned by the CURRENT
 * view (the scene camera, a custom view or the orthographic view), so the
 * user always sees how the 3D scene is oriented. All six faces are buttons
 * that snap to that orthographic view (clicking the face already shown goes
 * back to the Active Camera); the house button resets to the Active Camera;
 * dragging the cube orbits the view, exactly as the Orbit tool does (one undo
 * entry for a scene camera, view state for custom / axis views).
 * Screen-fixed: unaffected by viewport pan/zoom. Rendered whenever the comp
 * has any 3D layer — the same rule that makes the 3D chrome relevant.
 */

import React, { useMemo, useRef } from 'react';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useActiveCompRootId, useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { compHas3DContent } from '@core/mirror/compLayers';
import { viewCameraOf } from '@core/mirror/viewGeometry';
import { orthoViewOf } from '@core/scene/cameraViewMode';
import { isCustomViewId } from '@core/workspace/customViews';
import { orbitNavBy } from '@core/workspace/cameraNav';
import { beginViewportGesture, endViewportGesture } from '@core/workspace/viewportGesture';
import { useOverlayRequest } from '@hooks/useOverlayRequest';
import { MAIN_VIEWPORT, overlayView } from '@stores/overlayGeometry';
import { secondsToFlicks } from '@motion/engine-api';
import { Project3D, type Camera3D, type OrthoView, type Vec3 } from '@motion/scene';
import { navTargetNow } from './viewNav';

/**
 * Red=X, Green=Y, Blue=Z - the AE / Blender convention, through the TOKENS so
 * the colour-vision-deficiency preset (`[data-cvd]` in `tokens/domain.css`)
 * can swap the triple for an Okabe-Ito one.
 *
 * Applied through `style`, not the `stroke`/`fill` ATTRIBUTE: a presentation
 * attribute takes a CSS value, but browsers vary on resolving `var()` inside
 * one, and an unresolved paint falls back to black without saying so.
 */
const AXIS_COLORS = {
  x: 'var(--color-axis-x)',
  y: 'var(--color-axis-y)',
  z: 'var(--color-axis-z)',
} as const;

const SIZE = 96;
const CENTER = SIZE / 2;
/** Half the cube's edge on screen (px) for an axis facing the screen plane. */
const HALF = 22;
/** Pointer travel (px) that turns a press into an orbit drag instead of a click. */
const DRAG_SLOP = 3;

type FaceMode = Extract<Camera3dMode, 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'>;

/**
 * The six faces: their outward normal in comp space (x right, y DOWN, z away
 * from the default camera) and the orthographic view that looks at them.
 */
const FACES: ReadonlyArray<{ mode: FaceMode; label: string; n: Vec3; axis: 'x' | 'y' | 'z' }> = [
  { mode: 'front', label: 'Front', n: { x: 0, y: 0, z: -1 }, axis: 'z' },
  { mode: 'back', label: 'Back', n: { x: 0, y: 0, z: 1 }, axis: 'z' },
  { mode: 'right', label: 'Right', n: { x: 1, y: 0, z: 0 }, axis: 'x' },
  { mode: 'left', label: 'Left', n: { x: -1, y: 0, z: 0 }, axis: 'x' },
  { mode: 'top', label: 'Top', n: { x: 0, y: -1, z: 0 }, axis: 'y' },
  { mode: 'bottom', label: 'Bottom', n: { x: 0, y: 1, z: 0 }, axis: 'y' },
];

export const AxisWidgetOverlay: React.FC = () => {
  const sceneRev = useMirrorRevisionFrame();
  const { width: compWidth, height: compHeight } = useActiveCompSize();
  // Scoped like the renderer's, so the overlay never draws a different camera
  // than the one the frame was rendered through.
  const compRootId = useActiveCompRootId();
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const customViews = useGuidesStore((s) => s.customViews);
  const time = useCurrentTime();
  /** A press on the cube: where it started, the last point, and whether it became an orbit. */
  const press = useRef<{ x: number; y: number; lastX: number; lastY: number; orbiting: boolean; pointerId: number } | null>(null);
  /** Swallow the click that follows an orbit drag's release. */
  const swallowClick = useRef(false);

  // Visible only when the comp actually has 3D content.
  // Comp-scoped: another composition's 3D layers must not make THIS comp's
  // viewport claim it is 3D.
  // Memoised on the scene revision — this widget re-renders every frame.
  const has3D = useMemo(
    () => compHas3DContent(documentMirror(), compRootId, false),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneRev is the walk's dependency
    [compRootId, sceneRev],
  );
  // The view camera — resolved engine-side at the frame on screen, exactly as the
  // renderer resolves it (the overlay geometry push, B4 round 5): a `camera:<id>`
  // view orients the widget by the camera on screen rather than the topmost one.
  // Custom views build their camera FROM STORED PARAMS (scene camera ignored).
  useOverlayRequest('axisWidget', [], [], has3D && !isCustomViewId(camera3dMode) ? [camera3dMode] : []);
  if (!has3D) return null;
  const view = isCustomViewId(camera3dMode) ? undefined : overlayView(MAIN_VIEWPORT, camera3dMode, secondsToFlicks(time));
  const camera: Camera3D = viewCameraOf(camera3dMode, view, customViews, compWidth, compHeight);
  const orthoView: OrthoView | null = orthoViewOf(camera3dMode);

  const project = (p: Vec3): Project3D.Projected =>
    orthoView ? Project3D.projectOrtho(p, orthoView, compWidth, compHeight) : Project3D.projectPoint(p, camera);

  // Each world axis as seen from the view: its on-screen direction (normalised
  // so the longest is 1, foreshortening kept) and whether it points away.
  const anchor: Vec3 = { x: compWidth / 2, y: compHeight / 2, z: 0 };
  const len = 200;
  const o = project(anchor);
  const raw = (v: Vec3): { x: number; y: number; depth: number } => {
    const p = project({ x: anchor.x + v.x * len, y: anchor.y + v.y * len, z: anchor.z + v.z * len });
    return { x: p.x - o.x, y: p.y - o.y, depth: p.depth - o.depth };
  };
  const ax = raw({ x: 1, y: 0, z: 0 });
  const ay = raw({ x: 0, y: 1, z: 0 });
  const az = raw({ x: 0, y: 0, z: 1 });
  const maxLen = Math.max(1e-6, Math.hypot(ax.x, ax.y), Math.hypot(ay.x, ay.y), Math.hypot(az.x, az.y));
  // The axis's depth component: what is left of a unit vector once its screen part is taken.
  const depthOf = (a: { x: number; y: number; depth: number }): number => {
    const sl = Math.min(1, Math.hypot(a.x, a.y) / maxLen);
    return Math.sign(a.depth || 0) * Math.sqrt(Math.max(0, 1 - sl * sl));
  };
  const basis = {
    x: { x: (ax.x / maxLen) * HALF, y: (ax.y / maxLen) * HALF, d: depthOf(ax) },
    y: { x: (ay.x / maxLen) * HALF, y: (ay.y / maxLen) * HALF, d: depthOf(ay) },
    z: { x: (az.x / maxLen) * HALF, y: (az.y / maxLen) * HALF, d: depthOf(az) },
  };
  const toScreen = (v: Vec3): { x: number; y: number; d: number } => ({
    x: CENTER + v.x * basis.x.x + v.y * basis.y.x + v.z * basis.z.x,
    y: CENTER + v.x * basis.x.y + v.y * basis.y.y + v.z * basis.z.y,
    d: v.x * basis.x.d + v.y * basis.y.d + v.z * basis.z.d,
  });

  // A face is drawn when it faces the viewer (its normal points toward the
  // camera: negative depth); far faces first so near ones paint over them.
  const faces = FACES.map((f) => {
    const n = f.n;
    // Two in-face axes, orthogonal to the normal.
    const u: Vec3 = n.x !== 0 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const w: Vec3 = n.z !== 0 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const corner = (a: number, b: number): { x: number; y: number } => {
      const p = toScreen({ x: n.x + u.x * a + w.x * b, y: n.y + u.y * a + w.y * b, z: n.z + u.z * a + w.z * b });
      return { x: p.x, y: p.y };
    };
    const c = toScreen(n);
    return { ...f, depth: c.d, center: { x: c.x, y: c.y }, pts: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] };
  })
    .filter((f) => f.depth < 0.02)
    .sort((a, b) => b.depth - a.depth);

  const snapTo = (mode: FaceMode): void => {
    const g = useGuidesStore.getState();
    g.setCamera3dMode(camera3dMode === mode ? 'active' : mode);
  };
  const handleHome = (): void => {
    useGuidesStore.getState().setCamera3dMode('active');
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    press.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, orbiting: false, pointerId: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = press.current;
    if (!p) return;
    if (!p.orbiting) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
      const target = navTargetNow();
      if (!target) return;
      p.orbiting = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      // One engine gesture for the whole orbit (a scene camera), as the Orbit tool's drag.
      beginViewportGesture();
    }
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (dx === 0 && dy === 0) return;
    const target = navTargetNow();
    if (target) orbitNavBy(target, dx, dy);
  };
  const endPress = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = press.current;
    press.current = null;
    if (!p?.orbiting) return;
    swallowClick.current = true;
    try {
      e.currentTarget.releasePointerCapture(p.pointerId);
    } catch {
      /* best-effort */
    }
    endViewportGesture();
  };
  /** A face or the house: ignored right after an orbit drag (its release is not a click). */
  const clickGuard = (run: () => void) => (e: React.MouseEvent): void => {
    if (swallowClick.current) {
      swallowClick.current = false;
      e.preventDefault();
      return;
    }
    run();
  };
  const keyActivate = (run: () => void) => (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      run();
    }
  };

  // The three positive axes as short lines from the cube centre, under the faces' labels.
  const axisTips = (['x', 'y', 'z'] as const).map((k) => {
    const t = toScreen(k === 'x' ? { x: 1.55, y: 0, z: 0 } : k === 'y' ? { x: 0, y: 1.55, z: 0 } : { x: 0, y: 0, z: 1.55 });
    return { k, x: t.x, y: t.y, d: t.d };
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        pointerEvents: 'auto',
        zIndex: 21,
        width: SIZE,
        height: SIZE,
        cursor: 'grab',
        touchAction: 'none',
      }}
      title="View cube — click a face for that view, drag to orbit"
      data-axis-widget=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ opacity: 0.95 }}>
        <circle
          cx={CENTER}
          cy={CENTER}
          r={CENTER - 1}
          style={{ fill: 'var(--color-overlay-panel-bg)', stroke: 'var(--color-overlay-panel-border)' }}
          strokeWidth={1}
        />
        {/* Axes that point away from the viewer, drawn under the faces. */}
        {axisTips.filter((t) => t.d > 0).map((t) => (
          <line key={t.k} x1={CENTER} y1={CENTER} x2={t.x} y2={t.y} style={{ stroke: AXIS_COLORS[t.k] }} strokeWidth={2} strokeLinecap="round" opacity={0.6} />
        ))}
        {faces.map((f) => {
          const active = camera3dMode === f.mode;
          return (
            <g
              key={f.mode}
              // A view-cube face is a BUTTON: it changes the camera.
              role="button"
              tabIndex={0}
              aria-label={`${f.label} view`}
              aria-pressed={active}
              data-cube-face={f.mode}
              onClick={clickGuard(() => snapTo(f.mode))}
              onKeyDown={keyActivate(() => snapTo(f.mode))}
              style={{ cursor: 'pointer' }}
            >
              <title>{active ? `${f.label} view (click for the Active Camera)` : `${f.label} view`}</title>
              <polygon
                points={f.pts.map((p) => `${p.x},${p.y}`).join(' ')}
                style={{
                  fill: active ? AXIS_COLORS[f.axis] : 'var(--color-overlay-panel-bg)',
                  stroke: AXIS_COLORS[f.axis],
                }}
                fillOpacity={active ? 0.55 : 0.92}
                strokeWidth={1.25}
                strokeLinejoin="round"
              />
              {-f.depth > 0.35 && (
                <text
                  x={f.center.x}
                  y={f.center.y}
                  style={{ fill: 'var(--color-overlay-text)' }}
                  fontSize={8.5}
                  fontWeight={700}
                  fontFamily="system-ui, sans-serif"
                  textAnchor="middle"
                  dominantBaseline="central"
                  pointerEvents="none"
                >
                  {f.label}
                </text>
              )}
            </g>
          );
        })}
        {/* Axes that point at the viewer, over the faces. */}
        {axisTips.filter((t) => t.d <= 0).map((t) => (
          <g key={t.k} pointerEvents="none">
            <line x1={CENTER} y1={CENTER} x2={t.x} y2={t.y} style={{ stroke: AXIS_COLORS[t.k] }} strokeWidth={2} strokeLinecap="round" />
            <text x={t.x} y={t.y} style={{ fill: AXIS_COLORS[t.k] }} fontSize={8} fontWeight={700} fontFamily="system-ui, sans-serif" textAnchor="middle" dominantBaseline="central">
              {t.k.toUpperCase()}
            </text>
          </g>
        ))}
        {/* Home: back to the Active Camera. */}
        <g
          role="button"
          tabIndex={0}
          aria-label="Reset to the Active Camera view"
          data-cube-home=""
          onClick={clickGuard(handleHome)}
          onKeyDown={keyActivate(handleHome)}
          style={{ cursor: 'pointer' }}
        >
          <title>Active Camera view</title>
          <circle cx={SIZE - 12} cy={12} r={8} style={{ fill: 'var(--color-overlay-panel-bg)', stroke: 'var(--color-overlay-panel-border)' }} strokeWidth={1} />
          <path
            d={`M ${SIZE - 16} ${13} L ${SIZE - 12} ${9} L ${SIZE - 8} ${13} M ${SIZE - 15} ${12.5} L ${SIZE - 15} ${16} L ${SIZE - 9} ${16} L ${SIZE - 9} ${12.5}`}
            style={{ stroke: 'var(--color-overlay-text)' }}
            fill="none"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </div>
  );
};
