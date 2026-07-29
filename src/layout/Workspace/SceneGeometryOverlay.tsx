/**
 * SceneGeometryOverlay — the 3D scene's reference geometry, drawn as SVG over a
 * viewport: ground plane, composition frame, camera frustums, light cones and
 * falloff spheres, and per-layer bounding boxes.
 *
 * None of it affects rendered output. It exists because a Classic-3D layer is a
 * plane of zero thickness: seen exactly edge-on it projects to zero area and
 * draws no pixels — correct, and what After Effects does too. Without these
 * wireframes a Left or Top view is a blank field; with them you can see where
 * every layer, camera and light actually sits.
 *
 * Shared by the interactive viewport (inside Gizmo3dOverlay, under the
 * transform handles) and by the read-only inspection panes, so the two cannot
 * disagree about where anything is.
 */

import React from 'react';
import type { Camera3D, OrthoView, Vec3 } from '@motion/scene';
import { Project3D } from '@motion/scene';
import { Gizmo3D, type GizmoSegmentKind, type SceneGizmo } from '@motion/workspace';

export interface SceneGeometryOverlayProps {
  camera: Camera3D;
  orthoView: OrthoView | null;
  compWidth: number;
  compHeight: number;
  /** Comp → canvas transform: canvasPx = compPx·scale + offset. */
  viewTransform: { scale: number; offsetX: number; offsetY: number };
  groundGridVisible: boolean;
  sceneGizmos: readonly SceneGizmo[];
  /**
   * Draggable camera / light points, drawn as grab dots.
   *
   * Passed in rather than recollected here so the dot cannot land anywhere the
   * hit test would not accept — one list, drawn and picked from the same values.
   */
  deviceHandles?: readonly { nodeId: string; kind: 'position' | 'poi'; world: Vec3 }[];
  /** The handle under the pointer, drawn highlighted. */
  hoveredDeviceHandle?: { nodeId: string; kind: 'position' | 'poi' } | null;
}

/**
 * Styling per segment kind. One table so the geometry builders never carry
 * presentation, and so the whole overlay reads as one visual language:
 * frustums and cones are the "what this device reaches" colour, bounds are
 * neutral, POI lines are dashed because they describe a relationship rather
 * than a thing.
 */
const SEGMENT_STYLE: Record<GizmoSegmentKind, { stroke: string; width: number; dash?: string; opacity: number }> = {
  body: { stroke: '#ffd166', width: 1.4, opacity: 0.95 },
  frustum: { stroke: '#7cc4ff', width: 1.1, opacity: 0.75 },
  cone: { stroke: '#ffd166', width: 1.1, opacity: 0.65 },
  feather: { stroke: '#ffd166', width: 1, dash: '4 4', opacity: 0.32 },
  radius: { stroke: '#ffd166', width: 1, dash: '3 4', opacity: 0.38 },
  direction: { stroke: '#ffd166', width: 1.1, opacity: 0.6 },
  poi: { stroke: '#ff9ecb', width: 1, dash: '5 4', opacity: 0.8 },
  bounds: { stroke: '#8ea0b5', width: 1, opacity: 0.5 },
};

export const SceneGeometryOverlay: React.FC<SceneGeometryOverlayProps> = ({
  camera,
  orthoView,
  compWidth,
  compHeight,
  viewTransform,
  groundGridVisible,
  sceneGizmos,
  deviceHandles,
  hoveredDeviceHandle,
}) => {
  const projectScreen = (p: Vec3): { x: number; y: number } => {
    const cp = orthoView
      ? Project3D.projectOrtho(p, orthoView, compWidth, compHeight)
      : Project3D.projectPoint(p, camera);
    return Gizmo3D.compToViewport(cp, viewTransform);
  };

  const finite = (p: { x: number; y: number }): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

  /**
   * The ground plane. A floor seen from floor level correctly collapses to a
   * single horizontal line in Front / Back / Left / Right — that line IS the
   * horizon, and it is the cheapest thing on screen that tells you which way is
   * up in an otherwise empty side view.
   */
  const renderGroundGrid = () => {
    if (!groundGridVisible) return null;
    const lines = Gizmo3D.buildGroundGridLines(compWidth, compHeight).map((l) => ({
      start: projectScreen(l.start),
      end: projectScreen(l.end),
      alpha: l.major ? 0.4 : 0.15,
    }));
    return (
      <g className="ground-grid">
        {lines.map((line, idx) =>
          finite(line.start) && finite(line.end) ? (
            <line
              key={`grid_${idx}`}
              x1={line.start.x}
              y1={line.start.y}
              x2={line.end.x}
              y2={line.end.y}
              stroke="rgba(255, 255, 255, 0.9)"
              strokeOpacity={line.alpha}
              strokeWidth={line.alpha > 0.2 ? 1.5 : 1}
              strokeDasharray={line.alpha <= 0.2 ? '3 3' : undefined}
            />
          ) : null,
        )}
      </g>
    );
  };

  /**
   * The composition frame as 3D geometry — the z = 0 rectangle.
   *
   * Nothing clips to the comp box (render targets are viewport-sized), so from
   * a side view most of the scene sits outside the frame with no indication of
   * where the frame went. This is AE's Extended Viewer edge: the comp rect from
   * the front, a vertical line edge-on from Left/Right, a receding quad from a
   * custom view — which is exactly the cue that tells you how you are looking.
   */
  const renderCompFrame = () => {
    const corners = [
      { x: 0, y: 0, z: 0 },
      { x: compWidth, y: 0, z: 0 },
      { x: compWidth, y: compHeight, z: 0 },
      { x: 0, y: compHeight, z: 0 },
    ].map(projectScreen);
    if (!corners.every(finite)) return null;
    return (
      <polygon
        className="comp-frame-3d"
        points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="rgba(255, 255, 255, 0.55)"
        strokeWidth={1}
        strokeDasharray="6 4"
      />
    );
  };

  const renderSceneGizmos = () => {
    if (!sceneGizmos.length) return null;
    return (
      <g className="scene-gizmos">
        {sceneGizmos.map((giz) => (
          <g key={`${giz.type}_${giz.nodeId}`} opacity={giz.selected ? 1 : 0.62}>
            {giz.segments.map((s, i) => {
              const st = SEGMENT_STYLE[s.kind];
              const a = projectScreen(s.start);
              const b = projectScreen(s.end);
              // A projected point can be non-finite when a segment crosses the
              // camera's near plane; skipping keeps one bad segment from
              // blanking the whole group.
              if (!finite(a) || !finite(b)) return null;
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={st.stroke}
                  strokeWidth={st.width}
                  strokeOpacity={st.opacity}
                  strokeDasharray={st.dash}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
        ))}
      </g>
    );
  };

  /**
   * The grab dots. A wireframe alone gives no cue that it can be dragged, and
   * the camera body is only a few pixels across at a typical zoom — the dot is
   * what makes the handle findable and is sized to the same 12px tolerance the
   * hit test uses, so anything you can see you can also grab.
   */
  const renderDeviceHandles = () => {
    if (!deviceHandles || deviceHandles.length === 0) return null;
    return (
      <g className="device-handles">
        {deviceHandles.map((h) => {
          const p = projectScreen(h.world);
          if (!finite(p)) return null;
          const hot = hoveredDeviceHandle?.nodeId === h.nodeId && hoveredDeviceHandle?.kind === h.kind;
          // POI keeps the pink of its crosshair, position the amber of the
          // chassis, so a dot always reads as part of the wireframe it belongs to.
          const stroke = h.kind === 'poi' ? '#ff9ecb' : '#ffd166';
          return (
            <circle
              key={`${h.nodeId}_${h.kind}`}
              cx={p.x}
              cy={p.y}
              r={hot ? 7 : 5}
              fill={hot ? stroke : 'rgba(0,0,0,0.35)'}
              fillOpacity={hot ? 0.9 : 0.6}
              stroke={stroke}
              strokeWidth={1.5}
            />
          );
        })}
      </g>
    );
  };

  return (
    <>
      {renderGroundGrid()}
      {renderCompFrame()}
      {renderSceneGizmos()}
      {renderDeviceHandles()}
    </>
  );
};

/** Standalone SVG wrapper — for panes that have no other overlay to nest in. */
export const SceneGeometryOverlaySvg: React.FC<SceneGeometryOverlayProps> = (props) => (
  <svg
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
  >
    <SceneGeometryOverlay {...props} />
  </svg>
);
