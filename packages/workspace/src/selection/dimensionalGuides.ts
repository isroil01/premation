/**
 * DimensionalGuides — Adobe After Effects dynamic 3D visual feedback guides engine.
 *
 * Computes live feedback overlays when manipulating 3D layers with the gizmo:
 *   • Trajectory indicator (pink line connecting drag origin to current position)
 *   • Ground plane / Axis drop lines and projection points
 *   • Rotation angle arcs with tick marks
 *   • Floating measurement badges next to the cursor with delta numerical values
 */

import type { Vec3 } from '@motion/scene';
import type { GizmoHandleType } from './gizmo3d';

export interface DimensionalGuideState {
  handle: GizmoHandleType;
  startPos3D: Vec3;
  currentPos3D: Vec3;
  startRot3D: { rotX: number; rotY: number; rotZ: number };
  currentRot3D: { rotX: number; rotY: number; rotZ: number };
  startScale3D: { scaleX: number; scaleY: number; scaleZ: number };
  currentScale3D: { scaleX: number; scaleY: number; scaleZ: number };
  mouseScreen: { x: number; y: number };
}

export interface DimensionalGuideRenderData {
  badgeText: string;
  badgeScreen: { x: number; y: number };
  originLineScreen: { start: { x: number; y: number }; end: { x: number; y: number } } | null;
  axisDropLinesScreen: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>;
  rotationArcAngleDeg?: number;
}

/**
 * Generate formatted dimensional guide visual elements and callout badge text.
 */
export function buildDimensionalGuideData(
  state: DimensionalGuideState,
  project: (p: Vec3) => { x: number; y: number },
): DimensionalGuideRenderData {
  const { handle, startPos3D, currentPos3D, startRot3D, currentRot3D, currentScale3D, mouseScreen } = state;

  const badgeOffsetScreen = { x: mouseScreen.x + 16, y: mouseScreen.y - 24 };

  // Default values
  let badgeText = '';
  let originLineScreen: { start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
  const axisDropLinesScreen: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> = [];
  let rotationArcAngleDeg: number | undefined;

  const dx = currentPos3D.x - startPos3D.x;
  const dy = currentPos3D.y - startPos3D.y;
  const dz = currentPos3D.z - startPos3D.z;

  if (handle.startsWith('pos_') || handle.startsWith('plane_')) {
    // ── Position / Planar Translation Guides ──
    const pStartScreen = project(startPos3D);
    const pCurrentScreen = project(currentPos3D);

    originLineScreen = { start: pStartScreen, end: pCurrentScreen };

    if (handle === 'pos_x') {
      badgeText = `ΔX: ${dx >= 0 ? '+' : ''}${dx.toFixed(1)} px`;
    } else if (handle === 'pos_y') {
      badgeText = `ΔY: ${dy >= 0 ? '+' : ''}${dy.toFixed(1)} px`;
    } else if (handle === 'pos_z') {
      badgeText = `ΔZ: ${dz >= 0 ? '+' : ''}${dz.toFixed(1)} px`;
    } else if (handle === 'plane_xy') {
      badgeText = `ΔX: ${dx.toFixed(1)}, ΔY: ${dy.toFixed(1)} px`;
    } else if (handle === 'plane_xz') {
      badgeText = `ΔX: ${dx.toFixed(1)}, ΔZ: ${dz.toFixed(1)} px`;
    } else if (handle === 'plane_yz') {
      badgeText = `ΔY: ${dy.toFixed(1)}, ΔZ: ${dz.toFixed(1)} px`;
    }

    // Drop line to ground plane (Y=0 plane)
    const groundPoint = { x: currentPos3D.x, y: 0, z: currentPos3D.z };
    const pGroundScreen = project(groundPoint);
    axisDropLinesScreen.push({ start: pCurrentScreen, end: pGroundScreen });
  } else if (handle.startsWith('rot_')) {
    // ── Rotation Guides ──
    if (handle === 'rot_x') {
      const deltaDeg = currentRot3D.rotX - startRot3D.rotX;
      badgeText = `Rotation X: ${currentRot3D.rotX.toFixed(1)}° (${deltaDeg >= 0 ? '+' : ''}${deltaDeg.toFixed(1)}°)`;
      rotationArcAngleDeg = deltaDeg;
    } else if (handle === 'rot_y') {
      const deltaDeg = currentRot3D.rotY - startRot3D.rotY;
      badgeText = `Rotation Y: ${currentRot3D.rotY.toFixed(1)}° (${deltaDeg >= 0 ? '+' : ''}${deltaDeg.toFixed(1)}°)`;
      rotationArcAngleDeg = deltaDeg;
    } else if (handle === 'rot_z') {
      const deltaDeg = currentRot3D.rotZ - startRot3D.rotZ;
      badgeText = `Rotation Z: ${currentRot3D.rotZ.toFixed(1)}° (${deltaDeg >= 0 ? '+' : ''}${deltaDeg.toFixed(1)}°)`;
      rotationArcAngleDeg = deltaDeg;
    }
  } else if (handle.startsWith('scale_')) {
    // ── Scale Guides ──
    if (handle === 'scale_x') {
      badgeText = `Scale X: ${currentScale3D.scaleX.toFixed(2)}×`;
    } else if (handle === 'scale_y') {
      badgeText = `Scale Y: ${currentScale3D.scaleY.toFixed(2)}×`;
    } else if (handle === 'scale_z') {
      badgeText = `Scale Z: ${currentScale3D.scaleZ.toFixed(2)}×`;
    } else if (handle === 'scale_center') {
      badgeText = `Uniform Scale: ${currentScale3D.scaleX.toFixed(2)}×`;
    }
  }

  return {
    badgeText,
    badgeScreen: badgeOffsetScreen,
    originLineScreen,
    axisDropLinesScreen,
    rotationArcAngleDeg,
  };
}
