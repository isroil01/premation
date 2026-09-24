/**
 * AxisWidgetOverlay — persistent view-orientation indicator (AE/Blender-style).
 *
 * A small fixed-size widget in the bottom-left of the viewport showing the
 * world X/Y/Z axes projected through the CURRENT scene camera (or the active
 * orthographic view), so the user always sees how the 3D scene is oriented.
 * Screen-fixed: unaffected by viewport pan/zoom. Rendered whenever the comp
 * has any 3D layer — the same rule that makes the 3D chrome relevant.
 */

import React, { useMemo } from 'react';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useGuidesStore } from '@stores/guidesStore';
import { useActiveCompRootId, useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { compHas3DContent } from '@core/mirror/compLayers';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readSceneCamera, viewCameraNode } from '@core/scene/camera3d';
import { orthoViewOf } from '@core/scene/cameraViewMode';
import { toWorldPointAt } from '@core/scene/liveWorld3d';
import { customViewCamera, isCustomViewId } from '@core/workspace/customViews';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { Project3D, type Camera3D, type OrthoView, type Vec3 } from '@motion/scene';

/**
 * Red=X, Green=Y, Blue=Z - the AE / Blender convention, through the TOKENS so
 * the colour-vision-deficiency preset (`[data-cvd]` in `tokens/domain.css`)
 * can swap the triple for an Okabe-Ito one. The literals these replaced
 * (`#ff3b30 / #34c759 / #007aff`) put a red-green pair on two of the three
 * axes, which a deuteranope cannot separate and had no way to change.
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

const SIZE = 48;
const CENTER = SIZE / 2;
const AXIS_PX = 16;
const LABEL_PX = 21;

export const AxisWidgetOverlay: React.FC = () => {
  const sceneRev = useMirrorRevisionFrame();
  const { width: compWidth, height: compHeight } = useActiveCompSize();
  // Scoped like the renderer's, so the overlay never draws a different camera
  // than the one the frame was rendered through.
  const compRootId = useActiveCompRootId();
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const customViews = useGuidesStore((s) => s.customViews);
  const time = useCurrentTime();

  // Visible only when the comp actually has 3D content.
  // Comp-scoped: another composition's 3D layers must not make THIS comp's
  // viewport claim it is 3D.
  // Memoised on the scene revision — this widget re-renders every frame.
  const has3D = useMemo(
    () => compHas3DContent(documentMirror(), compRootId, false),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneRev is the walk's dependency
    [compRootId, sceneRev],
  );
  // One resolver for every camera read in the app. A local first-match search
  // here would draw the widget for a different camera than the frame was
  // rendered through — same scope and same tie-break, or neither is trustworthy.
  // The view's camera, so a `camera:<id>` view orients the widget by the
  // camera on screen rather than the topmost one.
  const cameraNode = viewCameraNode(defaultSceneGraph, camera3dMode, compRootId);
  if (!has3D) return null;

  // Resolve the view camera at the playhead — same resolver chain the gizmo
  // (useGizmo3d) and renderer use, so the widget always matches the view.
  // Custom views build their camera FROM STORED PARAMS (scene camera ignored).
  let camera: Camera3D;
  if (isCustomViewId(camera3dMode)) {
    camera = customViewCamera(customViews[camera3dMode], compWidth, compHeight);
  } else if (cameraNode) {
    const camNode = cameraNode;
    const camValues = defaultAnimation.evaluateNode(camNode.id, getRemappedTime(camNode.id, time));
    // Comp-scoped and parent-LIFTED, like the renderer: see `currentViewCamera`.
    camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight, (id, p) =>
      id === camNode.id ? camValues.get(p) : undefined,
    compRootId, (id, p) => toWorldPointAt(id, time, p), { view: camera3dMode });
  } else {
    camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight, undefined, compRootId);
  }
  const orthoView: OrthoView | null = orthoViewOf(camera3dMode);

  const project = (p: Vec3): { x: number; y: number } =>
    orthoView ? Project3D.projectOrtho(p, orthoView, compWidth, compHeight) : Project3D.projectPoint(p, camera);

  // Project the three world axes about the comp centre and normalise the
  // longest to a fixed on-screen length (foreshortening preserved).
  const anchor: Vec3 = { x: compWidth / 2, y: compHeight / 2, z: 0 };
  const len = 200;
  const o = project(anchor);
  const dirs: Array<{ key: 'x' | 'y' | 'z'; d: { x: number; y: number } }> = (
    [
      { key: 'x' as const, v: { x: 1, y: 0, z: 0 } },
      { key: 'y' as const, v: { x: 0, y: 1, z: 0 } },
      { key: 'z' as const, v: { x: 0, y: 0, z: 1 } },
    ]
  ).map(({ key, v }) => {
    const p = project({ x: anchor.x + v.x * len, y: anchor.y + v.y * len, z: anchor.z + v.z * len });
    return { key, d: { x: p.x - o.x, y: p.y - o.y } };
  });

  const maxLen = Math.max(1e-6, ...dirs.map(({ d }) => Math.hypot(d.x, d.y)));

  const handleAxisClick = (axisKey: 'x' | 'y' | 'z') => {
    const setCamera3dMode = useGuidesStore.getState().setCamera3dMode;
    if (axisKey === 'x') {
      setCamera3dMode(camera3dMode === 'right' ? 'active' : 'right');
    } else if (axisKey === 'y') {
      setCamera3dMode(camera3dMode === 'top' ? 'active' : 'top');
    } else if (axisKey === 'z') {
      setCamera3dMode(camera3dMode === 'front' ? 'active' : 'front');
    }
  };

  const handleCenterClick = () => {
    useGuidesStore.getState().setCamera3dMode('active');
  };

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
        cursor: 'pointer',
      }}
      title="3D View Cube — Click axes to snap orthographic camera views"
      data-axis-widget=""
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{
          opacity: 0.95,
          cursor: 'pointer',
        }}
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={CENTER - 1}
          style={{
            fill: 'var(--color-overlay-panel-bg)',
            stroke: 'var(--color-overlay-panel-border)',
            cursor: 'pointer',
          }}
          strokeWidth={1}
          role="button"
          tabIndex={0}
          aria-label="Reset to the Active Camera view"
          onClick={handleCenterClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleCenterClick();
            }
          }}
        >
          <title>Reset to Active Camera View</title>
        </circle>
        {dirs.map(({ key, d }) => {
          const nx = (d.x / maxLen) * AXIS_PX;
          const ny = (d.y / maxLen) * AXIS_PX;
          const frac = Math.hypot(d.x, d.y) / maxLen;
          // A fully foreshortened axis (pointing at the camera) draws as a dot.
          const lx = frac < 0.08 ? 0 : (d.x / maxLen) * LABEL_PX;
          const ly = frac < 0.08 ? 0 : (d.y / maxLen) * LABEL_PX;
          const isAxisActive =
            (key === 'x' && camera3dMode === 'right') ||
            (key === 'y' && camera3dMode === 'top') ||
            (key === 'z' && camera3dMode === 'front');

          return (
            <g
              key={key}
              // A view-cube face is a BUTTON: it changes the camera. With no
              // role and no tab stop it was reachable by mouse only, so a
              // keyboard user could not snap the view at all.
              role="button"
              tabIndex={0}
              aria-label={`Snap the view to the ${key.toUpperCase()} axis (${key === 'x' ? 'Right' : key === 'y' ? 'Top' : 'Front'})`}
              aria-pressed={isAxisActive}
              onClick={() => handleAxisClick(key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleAxisClick(key);
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              <title>{`Snap view to ${key.toUpperCase()} axis (${key === 'x' ? 'Right' : key === 'y' ? 'Top' : 'Front'})`}</title>
              <line
                x1={CENTER}
                y1={CENTER}
                x2={CENTER + nx}
                y2={CENTER + ny}
                style={{ stroke: AXIS_COLORS[key] }}
                strokeWidth={isAxisActive ? 3 : 2}
                strokeLinecap="round"
              />
              <circle
                cx={CENTER + nx}
                cy={CENTER + ny}
                r={3}
                style={{ fill: AXIS_COLORS[key] }}
              />
              <text
                x={CENTER + lx}
                y={CENTER + ly}
                style={{ fill: isAxisActive ? 'var(--color-overlay-text)' : AXIS_COLORS[key] }}
                fontSize={7.5}
                fontWeight={700}
                fontFamily="system-ui, sans-serif"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {key.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};


