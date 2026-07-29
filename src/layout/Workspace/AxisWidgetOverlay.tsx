/**
 * AxisWidgetOverlay — persistent view-orientation indicator (AE/Blender-style).
 *
 * A small fixed-size widget in the bottom-left of the viewport showing the
 * world X/Y/Z axes projected through the CURRENT scene camera (or the active
 * orthographic view), so the user always sees how the 3D scene is oriented.
 * Screen-fixed: unaffected by viewport pan/zoom. Rendered whenever the comp
 * has any 3D layer — the same rule that makes the 3D chrome relevant.
 */

import React from 'react';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { is3DEnabled } from '@core/scene/threeD';
import { activeCameraNode, readSceneCamera } from '@core/scene/camera3d';
import { customViewCamera, isCustomViewId } from '@core/workspace/customViews';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { Project3D, type Camera3D, type OrthoView, type Vec3 } from '@motion/scene';

/** Same palette as the 3D gizmo (gizmo3d.ts): Red=X, Green=Y, Blue=Z. */
const AXIS_COLORS = { x: '#ff3b30', y: '#34c759', z: '#007aff' } as const;

const SIZE = 48;
const CENTER = SIZE / 2;
const AXIS_PX = 16;
const LABEL_PX = 21;

export const AxisWidgetOverlay: React.FC = () => {
  useSceneRevision((s) => s.rev);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  // Scoped like the renderer's, so the overlay never draws a different camera
  // than the one the frame was rendered through.
  const compRootId = useCompositionStore((s) => s.id);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const customViews = useGuidesStore((s) => s.customViews);
  const time = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0));

  // Visible only when the comp actually has 3D content.
  let has3D = false;
  for (const n of flattenScene(defaultSceneGraph)) {
    const k = readNodeKind(n);
    if (k === 'camera') continue;
    if (k !== 'light' && is3DEnabled(n)) has3D = true;
  }
  // One resolver for every camera read in the app. A local first-match search
  // here would draw the widget for a different camera than the frame was
  // rendered through — same scope and same tie-break, or neither is trustworthy.
  const cameraNode = activeCameraNode(defaultSceneGraph, compRootId);
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
    camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight, (id, p) =>
      id === camNode.id ? camValues.get(p) : undefined,
    );
  } else {
    camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight, undefined, compRootId);
  }
  const orthoView: OrthoView | null =
    camera3dMode === 'active' || isCustomViewId(camera3dMode) ? null : (camera3dMode as OrthoView);

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
          fill="rgba(14, 16, 22, 0.75)"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth={1}
          onClick={handleCenterClick}
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
              onClick={() => handleAxisClick(key)}
              style={{ cursor: 'pointer' }}
            >
              <title>{`Snap view to ${key.toUpperCase()} axis (${key === 'x' ? 'Right' : key === 'y' ? 'Top' : 'Front'})`}</title>
              <line
                x1={CENTER}
                y1={CENTER}
                x2={CENTER + nx}
                y2={CENTER + ny}
                stroke={AXIS_COLORS[key]}
                strokeWidth={isAxisActive ? 3 : 2}
                strokeLinecap="round"
              />
              <circle
                cx={CENTER + nx}
                cy={CENTER + ny}
                r={3}
                fill={AXIS_COLORS[key]}
              />
              <text
                x={CENTER + lx}
                y={CENTER + ly}
                fill={isAxisActive ? '#ffffff' : AXIS_COLORS[key]}
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


