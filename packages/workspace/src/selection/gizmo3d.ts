/**
 * Gizmo3D — interactive 3D Transform Gizmo math and hit testing engine.
 *
 * Implements Adobe After Effects 3D Design Space transform handles:
 *   • Universal state (Position arrows + Scale cubes + Rotation rings combined)
 *   • Position-specific state (X, Y, Z arrows & XY, XZ, YZ planar handles)
 *   • Scale-specific state (X, Y, Z scale boxes & uniform scale center)
 *   • Rotation-specific state (X, Y, Z rotation arcs & outer trackball ring)
 *
 * Supports Local, World, and View coordinate spaces.
 */

import { Project3D, Matrix4Math, type Camera3D, type OrthoView, type Vec3 } from '@motion/scene';

export type GizmoHandleType =
  | 'pos_x'
  | 'pos_y'
  | 'pos_z'
  | 'plane_xy'
  | 'plane_xz'
  | 'plane_yz'
  | 'scale_x'
  | 'scale_y'
  | 'scale_z'
  | 'scale_center'
  | 'rot_x'
  | 'rot_y'
  | 'rot_z'
  | 'rot_outer';

export interface Gizmo3DConfig {
  gizmoState: 'universal' | 'position' | 'scale' | 'rotation';
  axisMode: 'local' | 'world' | 'view';
  gizmoLengthPx: number; // Length of gizmo axis vectors in px on screen (~90px)
}

export interface RenderedGizmoAxis {
  type: GizmoHandleType;
  color: string;
  hoverColor: string;
  startScreen: { x: number; y: number };
  endScreen: { x: number; y: number };
  headScreen: { x: number; y: number };
  axis3DDir: Vec3;
}

export interface RenderedGizmoArc {
  type: GizmoHandleType;
  color: string;
  hoverColor: string;
  centerScreen: { x: number; y: number };
  radiusPx: number;
  axis3DNormal: Vec3;
  pointsScreen: Array<{ x: number; y: number }>;
}

export interface RenderedGizmoPlane {
  type: GizmoHandleType;
  color: string;
  hoverColor: string;
  pointsScreen: Array<{ x: number; y: number }>;
}

export interface RenderedGizmo3D {
  centerScreen: { x: number; y: number; scale: number; depth: number };
  axes: RenderedGizmoAxis[];
  arcs: RenderedGizmoArc[];
  planes: RenderedGizmoPlane[];
  basisX: Vec3;
  basisY: Vec3;
  basisZ: Vec3;
}

const DEG = Math.PI / 180;

/**
 * Comp → canvas view transform, in CSS px (mirror of the renderer's
 * RenderView): canvasPx = compPx * scale + offset.
 */
export interface GizmoViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Map a viewport (canvas CSS px) point into composition space. */
export function viewportToComp(
  pt: { x: number; y: number },
  view: GizmoViewTransform,
): { x: number; y: number } {
  const s = view.scale || 1;
  return { x: (pt.x - view.offsetX) / s, y: (pt.y - view.offsetY) / s };
}

/** Map a composition-space point onto the viewport (canvas CSS px). */
export function compToViewport(
  pt: { x: number; y: number },
  view: GizmoViewTransform,
): { x: number; y: number } {
  return { x: pt.x * view.scale + view.offsetX, y: pt.y * view.scale + view.offsetY };
}

/** One ground-grid line in 3D comp space (project + draw in the overlay). */
export interface GroundGridLine3D {
  start: Vec3;
  end: Vec3;
  /** The two centre lines (through the comp's horizontal middle / z = 0). */
  major: boolean;
}

/**
 * AE-style ground-plane grid: a floor of lines centred UNDER the comp
 * (x centred on compWidth/2, z centred on the comp plane z = 0) lying on the
 * horizontal plane y = compHeight — the comp's bottom edge. World origin (0,0)
 * is the comp's TOP-LEFT corner, so a grid around the origin renders off in
 * the top-left; centring on the comp makes it a perspective-receding floor
 * under the default camera's view (which looks at the comp centre).
 */
export function buildGroundGridLines(
  compWidth: number,
  compHeight: number,
  step = 200,
  count = 5,
): GroundGridLine3D[] {
  const cx = compWidth / 2;
  const groundY = compHeight;
  const extent = count * step;
  const lines: GroundGridLine3D[] = [];
  for (let i = -count; i <= count; i++) {
    const major = i === 0;
    // Z-parallel lines (constant x, running toward/away from the camera)
    lines.push({
      start: { x: cx + i * step, y: groundY, z: -extent },
      end: { x: cx + i * step, y: groundY, z: extent },
      major,
    });
    // X-parallel lines (constant z, running across the view)
    lines.push({
      start: { x: cx - extent, y: groundY, z: i * step },
      end: { x: cx + extent, y: groundY, z: i * step },
      major,
    });
  }
  return lines;
}

/**
 * Compute the 3D basis vectors (X, Y, Z unit directions) for the requested axis mode.
 */
export function getGizmoBasis(
  axisMode: 'local' | 'world' | 'view',
  nodeRotation: { rotX: number; rotY: number; rotZ: number },
  cam: Camera3D,
): { x: Vec3; y: Vec3; z: Vec3 } {
  if (!cam) cam = Project3D.defaultCamera(1920, 1080);

  if (axisMode === 'world') {
    return {
      x: { x: 1, y: 0, z: 0 },
      y: { x: 0, y: 1, z: 0 },
      z: { x: 0, y: 0, z: 1 },
    };
  }

  if (axisMode === 'view') {
    const yaw = (cam.orientation?.yaw ?? 0) * DEG;
    const pitch = (cam.orientation?.pitch ?? 0) * DEG;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    // Camera view right vector (X), down vector (Y), forward vector (Z)
    return {
      x: { x: cy, y: 0, z: -sy },
      y: { x: sy * sx, y: cx, z: cy * sx },
      z: { x: sy * cx, y: -sx, z: cy * cx },
    };
  }

  // Local space basis: apply layer's rotations (rotX, rotY, rotZ) to identity basis
  const rx = nodeRotation.rotX * DEG;
  const ry = nodeRotation.rotY * DEG;
  const rz = nodeRotation.rotZ * DEG;

  const M = Matrix4Math.compose({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: rx, y: ry, z: rz },
    scale: { x: 1, y: 1, z: 1 },
    anchor: { x: 0, y: 0, z: 0 },
  });

  return {
    x: Matrix4Math.transformVector(M, { x: 1, y: 0, z: 0 }),
    y: Matrix4Math.transformVector(M, { x: 0, y: 1, z: 0 }),
    z: Matrix4Math.transformVector(M, { x: 0, y: 0, z: 1 }),
  };
}

/**
 * Calculate on-screen projected 3D Gizmo elements for rendering and interaction.
 */
export function buildRenderedGizmo3D(
  position3D: Vec3,
  nodeRotation: { rotX: number; rotY: number; rotZ: number },
  cam: Camera3D,
  orthoView: OrthoView | null,
  config: Gizmo3DConfig,
  compWidth = 1920,
  compHeight = 1080,
): RenderedGizmo3D {
  const project = (p: Vec3): Project3D.Projected => {
    return orthoView
      ? Project3D.projectOrtho(p, orthoView, compWidth, compHeight)
      : Project3D.projectPoint(p, cam);
  };

  const centerProj = project(position3D);
  const centerScreen = { x: centerProj.x, y: centerProj.y };

  const basis = getGizmoBasis(config.axisMode, nodeRotation, cam);

  // Compute fixed pixel length in 3D world space relative to perspective scale
  const targetPx = config.gizmoLengthPx;
  const unitProjX = project({
    x: position3D.x + basis.x.x,
    y: position3D.y + basis.x.y,
    z: position3D.z + basis.x.z,
  });
  const pxPerWorldUnit = Math.hypot(unitProjX.x - centerScreen.x, unitProjX.y - centerScreen.y) || 1;
  const axisLen3D = targetPx / pxPerWorldUnit;

  const axes: RenderedGizmoAxis[] = [];
  const arcs: RenderedGizmoArc[] = [];
  const planes: RenderedGizmoPlane[] = [];

  const isUniversal = config.gizmoState === 'universal';
  const isPos = config.gizmoState === 'position' || isUniversal;
  const isScale = config.gizmoState === 'scale' || isUniversal;
  const isRot = config.gizmoState === 'rotation' || isUniversal;

  // Colors (After Effects standard: Red=X, Green=Y, Blue=Z)
  const colors = {
    x: '#ff3b30',
    hoverX: '#ff6961',
    y: '#34c759',
    hoverY: '#30d158',
    z: '#007aff',
    hoverZ: '#409cff',
  };

  // ── Position / Scale Axes ──
  if (isPos || isScale) {
    const list: Array<{ type: GizmoHandleType; dir: Vec3; c: string; hc: string }> = [
      { type: isPos ? 'pos_x' : 'scale_x', dir: basis.x, c: colors.x, hc: colors.hoverX },
      { type: isPos ? 'pos_y' : 'scale_y', dir: basis.y, c: colors.y, hc: colors.hoverY },
      { type: isPos ? 'pos_z' : 'scale_z', dir: basis.z, c: colors.z, hc: colors.hoverZ },
    ];

    for (const item of list) {
      const tip3D = {
        x: position3D.x + item.dir.x * axisLen3D,
        y: position3D.y + item.dir.y * axisLen3D,
        z: position3D.z + item.dir.z * axisLen3D,
      };
      const tipProj = project(tip3D);

      axes.push({
        type: item.type,
        color: item.c,
        hoverColor: item.hc,
        startScreen: centerScreen,
        endScreen: { x: tipProj.x, y: tipProj.y },
        headScreen: { x: tipProj.x, y: tipProj.y },
        axis3DDir: item.dir,
      });
    }

    // Planar handles (small quadrilaterals near gizmo origin)
    if (isPos) {
      const planeSize = axisLen3D * 0.35;
      const mkPlane = (t: GizmoHandleType, v1: Vec3, v2: Vec3, col: string, hcol: string): RenderedGizmoPlane => {
        const p0 = project(position3D);
        const p1 = project({ x: position3D.x + v1.x * planeSize, y: position3D.y + v1.y * planeSize, z: position3D.z + v1.z * planeSize });
        const p2 = project({
          x: position3D.x + (v1.x + v2.x) * planeSize,
          y: position3D.y + (v1.y + v2.y) * planeSize,
          z: position3D.z + (v1.z + v2.z) * planeSize,
        });
        const p3 = project({ x: position3D.x + v2.x * planeSize, y: position3D.y + v2.y * planeSize, z: position3D.z + v2.z * planeSize });
        return {
          type: t,
          color: col,
          hoverColor: hcol,
          pointsScreen: [
            { x: p0.x, y: p0.y },
            { x: p1.x, y: p1.y },
            { x: p2.x, y: p2.y },
            { x: p3.x, y: p3.y },
          ],
        };
      };

      planes.push(mkPlane('plane_xy', basis.x, basis.y, 'rgba(255, 255, 0, 0.35)', 'rgba(255, 255, 0, 0.65)'));
      planes.push(mkPlane('plane_xz', basis.x, basis.z, 'rgba(255, 0, 255, 0.35)', 'rgba(255, 0, 255, 0.65)'));
      planes.push(mkPlane('plane_yz', basis.y, basis.z, 'rgba(0, 255, 255, 0.35)', 'rgba(0, 255, 255, 0.65)'));
    }
  }

  // ── Rotation Arcs ──
  if (isRot) {
    const arcRadius3D = axisLen3D * 0.85;
    const segments = 32;

    const mkArc = (t: GizmoHandleType, normal: Vec3, u: Vec3, v: Vec3, col: string, hcol: string): RenderedGizmoArc => {
      const pointsScreen: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const p3D = {
          x: position3D.x + (u.x * cosT + v.x * sinT) * arcRadius3D,
          y: position3D.y + (u.y * cosT + v.y * sinT) * arcRadius3D,
          z: position3D.z + (u.z * cosT + v.z * sinT) * arcRadius3D,
        };
        const proj = project(p3D);
        pointsScreen.push({ x: proj.x, y: proj.y });
      }

      return {
        type: t,
        color: col,
        hoverColor: hcol,
        centerScreen,
        radiusPx: targetPx * 0.85,
        axis3DNormal: normal,
        pointsScreen,
      };
    };

    // X-rotation arc (normal = basis.x, circle in YZ plane)
    arcs.push(mkArc('rot_x', basis.x, basis.y, basis.z, colors.x, colors.hoverX));
    // Y-rotation arc (normal = basis.y, circle in XZ plane)
    arcs.push(mkArc('rot_y', basis.y, basis.x, basis.z, colors.y, colors.hoverY));
    // Z-rotation arc (normal = basis.z, circle in XY plane)
    arcs.push(mkArc('rot_z', basis.z, basis.x, basis.y, colors.z, colors.hoverZ));
  }

  return {
    centerScreen: { x: centerProj.x, y: centerProj.y, scale: centerProj.scale, depth: centerProj.depth },
    axes,
    arcs,
    planes,
    basisX: basis.x,
    basisY: basis.y,
    basisZ: basis.z,
  };
}

/**
 * Hit test a mouse click/hover against the rendered 3D Gizmo components.
 * Returns the hit handle type, or null if outside hit threshold.
 */
export function hitTestGizmo3D(
  mouseScreen: { x: number; y: number },
  gizmo: RenderedGizmo3D,
  hitThresholdPx = 10,
): GizmoHandleType | null {
  const distToLine = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
  };

  // 1. Check axis handles & heads
  for (const axis of gizmo.axes) {
    const dLine = distToLine(mouseScreen, axis.startScreen, axis.endScreen);
    if (dLine <= hitThresholdPx) return axis.type;
  }

  // 2. Check planar handles
  for (const plane of gizmo.planes) {
    if (plane.pointsScreen.length === 4) {
      // Point-in-polygon test for quadrilateral
      let inside = false;
      const pts = plane.pointsScreen;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const pi = pts[i];
        const pj = pts[j];
        if (!pi || !pj) continue;
        const xi = pi.x, yi = pi.y;
        const xj = pj.x, yj = pj.y;
        const intersect = yi > mouseScreen.y !== yj > mouseScreen.y &&
          mouseScreen.x < ((xj - xi) * (mouseScreen.y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
      }
      if (inside) return plane.type;
    }
  }

  // 3. Check rotation arc rings
  for (const arc of gizmo.arcs) {
    const pts = arc.pointsScreen;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      if (distToLine(mouseScreen, a, b) <= hitThresholdPx) {
        return arc.type;
      }
    }
  }

  // 4. Center scale handle
  if (Math.hypot(mouseScreen.x - gizmo.centerScreen.x, mouseScreen.y - gizmo.centerScreen.y) <= hitThresholdPx + 2) {
    return 'scale_center';
  }

  return null;
}
