/**
 * Gizmo3dOverlay — Adobe After Effects-grade 3D Transform Gizmo, Ground Grid,
 * and Dynamic Dimensional Guides viewport overlay.
 *
 * Renders crisp SVG elements over active 3D layer selections:
 *   • 3D Transform Gizmo (Universal / Position / Scale / Rotation handles)
 *   • Ground Grid (3D Floor Grid at Y=0)
 *   • Dimensional Guides (pink trajectory line, drop lines to floor, live callout badge)
 */

import React from 'react';
import type { Camera3D, OrthoView, Vec3 } from '@motion/scene';
import { Project3D } from '@motion/scene';
import {
  Gizmo3D,
  DimensionalGuides,
  type GizmoHandleType,
  type RenderedGizmo3D,
  type SceneGizmo,
} from '@motion/workspace';
import { SceneGeometryOverlay } from './SceneGeometryOverlay';
import type { DragState3D } from './useGizmo3d';

export interface Gizmo3dOverlayProps {
  nodeId: string | null;
  /**
   * Draw the transform gizmo (a 3D layer is selected). The overlay itself
   * mounts whenever the viewport shows a 3D scene, because the ground plane
   * and comp frame are SCENE reference geometry — they must not depend on
   * what happens to be selected.
   */
  showGizmo: boolean;
  position3D: Vec3;
  nodeRotation: { rotX: number; rotY: number; rotZ: number };
  nodeScale: { scaleX: number; scaleY: number; scaleZ: number };
  camera: Camera3D;
  orthoView: OrthoView | null;
  compWidth: number;
  compHeight: number;
  /** Comp → canvas transform (RenderView): canvasPx = compPx·scale + offset. */
  viewTransform: { scale: number; offsetX: number; offsetY: number };
  gizmoState: 'universal' | 'position' | 'scale' | 'rotation';
  axisMode: 'local' | 'world' | 'view';
  groundGridVisible: boolean;
  /** Camera frustums, light cones and 3D layer boxes, in comp space. */
  sceneGizmos: readonly SceneGizmo[];
  activeHandle: GizmoHandleType | null;
  hoverHandle: GizmoHandleType | null;
  dragState: DragState3D | null;
}

export const Gizmo3dOverlay: React.FC<Gizmo3dOverlayProps> = ({
  showGizmo,
  position3D,
  nodeRotation,
  camera,
  orthoView,
  compWidth,
  compHeight,
  viewTransform,
  gizmoState,
  axisMode,
  groundGridVisible,
  sceneGizmos,
  activeHandle,
  hoverHandle,
  dragState,
}) => {
  const projectComp = (p: Vec3) => {
    return orthoView
      ? Project3D.projectOrtho(p, orthoView, compWidth, compHeight)
      : Project3D.projectPoint(p, camera);
  };

  // Map comp-space coordinates to viewport canvas screen pixels (including pan and zoom)
  const projectScreen = (p: Vec3) => {
    const cp = projectComp(p);
    return Gizmo3D.compToViewport(cp, viewTransform);
  };

  // Screen-constant sizing (AE-style): the gizmo group below is scaled by the
  // viewport zoom, so every fixed pixel size is divided by the scale to stay
  // constant on screen regardless of zoom level.
  const s = viewTransform.scale || 1;

  const renderedGizmo: RenderedGizmo3D = Gizmo3D.buildRenderedGizmo3D(
    position3D,
    nodeRotation,
    camera,
    orthoView,
    { gizmoState, axisMode, gizmoLengthPx: 85 / s },
    compWidth,
    compHeight,
  );


  // ── Render Dimensional Guides (Active Drag Feedback) ──
  const renderDimensionalGuides = () => {
    if (!dragState || !dragState.active) return null;

    const guideData = DimensionalGuides.buildDimensionalGuideData(
      dragState,
      (p) => projectScreen(p),
    );

    return (
      <g className="dimensional-guides">
        {/* Trajectory pink line from start position to current position */}
        {guideData.originLineScreen && (
          <>
            <line
              x1={guideData.originLineScreen.start.x}
              y1={guideData.originLineScreen.start.y}
              x2={guideData.originLineScreen.end.x}
              y2={guideData.originLineScreen.end.y}
              stroke="#ff2d55"
              strokeWidth={2}
              strokeDasharray="4 4"
            />
            {/* Origin marker dot */}
            <circle
              cx={guideData.originLineScreen.start.x}
              cy={guideData.originLineScreen.start.y}
              r={4}
              fill="#ff2d55"
            />
          </>
        )}

        {/* Drop lines to ground plane / axes */}
        {guideData.axisDropLinesScreen.map((line, idx) => (
          <g key={`drop_${idx}`}>
            <line
              x1={line.start.x}
              y1={line.start.y}
              x2={line.end.x}
              y2={line.end.y}
              stroke="#ff2d55"
              strokeWidth={1.5}
              strokeDasharray="2 2"
              strokeOpacity={0.8}
            />
            <circle cx={line.end.x} cy={line.end.y} r={3} fill="#ff2d55" />
          </g>
        ))}

        {/* Dynamic Measurement Badge */}
        {guideData.badgeText && (
          <foreignObject
            x={guideData.badgeScreen.x}
            y={guideData.badgeScreen.y}
            width={240}
            height={36}
            style={{ overflow: 'visible', pointerEvents: 'none' }}
          >
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '4px 10px',
                borderRadius: '6px',
                background: 'rgba(18, 20, 26, 0.90)',
                backdropFilter: 'blur(8px)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: '#ffffff',
                fontSize: '11px',
                fontWeight: 600,
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontVariantNumeric: 'tabular-nums',
                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.5)',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#ff2d55', marginRight: 6 }} />
              {guideData.badgeText}
            </div>
          </foreignObject>
        )}
      </g>
    );
  };

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    >
      <defs>
        {/* markerUnits="userSpaceOnUse" + size ÷ view scale keeps the arrow
            heads a constant ~13px on screen inside the zoom-scaled group. */}
        <marker id="arrow-x" viewBox="0 0 10 10" refX="6" refY="5" markerUnits="userSpaceOnUse" markerWidth={13.2 / s} markerHeight={13.2 / s} orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={activeHandle === 'pos_x' || hoverHandle === 'pos_x' ? '#ff6961' : '#ff3b30'} />
        </marker>
        <marker id="arrow-y" viewBox="0 0 10 10" refX="6" refY="5" markerUnits="userSpaceOnUse" markerWidth={13.2 / s} markerHeight={13.2 / s} orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={activeHandle === 'pos_y' || hoverHandle === 'pos_y' ? '#30d158' : '#34c759'} />
        </marker>
        <marker id="arrow-z" viewBox="0 0 10 10" refX="6" refY="5" markerUnits="userSpaceOnUse" markerWidth={13.2 / s} markerHeight={13.2 / s} orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={activeHandle === 'pos_z' || hoverHandle === 'pos_z' ? '#409cff' : '#007aff'} />
        </marker>
      </defs>

      {/* Scene reference geometry, drawn UNDER the handles so the interactive
          gizmo always wins. Shared with the inspection panes — one component,
          so the two cannot disagree about where a camera or light sits. */}
      <SceneGeometryOverlay
        camera={camera}
        orthoView={orthoView}
        compWidth={compWidth}
        compHeight={compHeight}
        viewTransform={viewTransform}
        groundGridVisible={groundGridVisible}
        sceneGizmos={sceneGizmos}
      />

      {/* ── Render 3D Gizmo Handles ── */}
      <g
        className="gizmo-3d"
        style={{ display: showGizmo ? undefined : 'none' }}
        transform={`translate(${viewTransform.offsetX}, ${viewTransform.offsetY}) scale(${viewTransform.scale})`}
      >
        {/* Planar Quad Handles */}
        {renderedGizmo.planes.map((plane) => {
          const isSelected = activeHandle === plane.type || hoverHandle === plane.type;
          const pointsStr = plane.pointsScreen.map((p) => `${p.x},${p.y}`).join(' ');
          return (
            <polygon
              key={plane.type}
              points={pointsStr}
              fill={isSelected ? plane.hoverColor : plane.color}
              stroke={isSelected ? '#ffffff' : 'none'}
              strokeWidth={1 / s}
            />
          );
        })}

        {/* Rotation Rings */}
        {renderedGizmo.arcs.map((arc) => {
          const isSelected = activeHandle === arc.type || hoverHandle === arc.type;
          const pathD = arc.pointsScreen.reduce(
            (acc, p, idx) => (idx === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`),
            '',
          );
          return (
            <g key={arc.type}>
              {isSelected && (
                <path
                  d={pathD}
                  fill="none"
                  stroke={arc.hoverColor}
                  strokeWidth={6 / s}
                  strokeOpacity={0.3}
                  strokeLinecap="round"
                />
              )}
              <path
                d={pathD}
                fill="none"
                stroke={isSelected ? arc.hoverColor : arc.color}
                strokeWidth={(isSelected ? 3.5 : 2) / s}
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {/* Position & Scale Axes */}
        {renderedGizmo.axes.map((axis) => {
          const isSelected = activeHandle === axis.type || hoverHandle === axis.type;
          const markerId = axis.type === 'pos_x' ? 'url(#arrow-x)' : axis.type === 'pos_y' ? 'url(#arrow-y)' : axis.type === 'pos_z' ? 'url(#arrow-z)' : undefined;

          return (
            <g key={axis.type}>
              {isSelected && (
                <line
                  x1={axis.startScreen.x}
                  y1={axis.startScreen.y}
                  x2={axis.endScreen.x}
                  y2={axis.endScreen.y}
                  stroke={axis.hoverColor}
                  strokeWidth={6 / s}
                  strokeOpacity={0.35}
                />
              )}
              <line
                x1={axis.startScreen.x}
                y1={axis.startScreen.y}
                x2={axis.endScreen.x}
                y2={axis.endScreen.y}
                stroke={isSelected ? axis.hoverColor : axis.color}
                strokeWidth={(isSelected ? 3.5 : 2.2) / s}
                markerEnd={markerId}
              />
              {/* Scale Handle Cubes */}
              {axis.type.startsWith('scale_') && (
                <rect
                  x={axis.endScreen.x - 4 / s}
                  y={axis.endScreen.y - 4 / s}
                  width={8 / s}
                  height={8 / s}
                  fill={isSelected ? axis.hoverColor : axis.color}
                  stroke="#ffffff"
                  strokeWidth={1 / s}
                  rx={1 / s}
                />
              )}
            </g>
          );
        })}

        {/* Center Point / Uniform Scale handle */}
        <circle
          cx={renderedGizmo.centerScreen.x}
          cy={renderedGizmo.centerScreen.y}
          r={(activeHandle === 'scale_center' || hoverHandle === 'scale_center' ? 7 : 5) / s}
          fill={activeHandle === 'scale_center' || hoverHandle === 'scale_center' ? '#ffffff' : 'rgba(255, 255, 255, 0.85)'}
          stroke="rgba(0, 0, 0, 0.8)"
          strokeWidth={1.5 / s}
        />
      </g>

      {renderDimensionalGuides()}
    </svg>
  );
};
