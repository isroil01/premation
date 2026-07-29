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
  /**
   * This axis points (nearly) straight at or away from the viewer, so it
   * projects to a stub or a single point. It stays in the list so the overlay
   * can still draw a marker, but it is EXCLUDED from segment hit-testing —
   * a zero-length segment otherwise claims a full hit-radius disc at the origin
   * and swallows every other handle there — and its drag must use the
   * screen-delta fallback, because ray/axis intersection is singular.
   */
  degenerate: boolean;
  /** Projected length in composition px (0 when degenerate). */
  screenLen: number;
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

  // Screen-constant arm length, computed PER AXIS.
  //
  // This used to derive one shared scale from basis.x alone, which is wrong the
  // moment the axes don't foreshorten equally: in a front view basis.z points at
  // the camera, so its true px-per-world-unit is ~0 while X's is 1 — the Z arm
  // was then drawn at X's length and collapsed to a zero-length segment at the
  // origin (the "Z arrow doesn't exist / can't be dragged" bug). Scaling each
  // axis by its own rate keeps every arm that CAN be seen at `gizmoLengthPx`.
  const targetPx = config.gizmoLengthPx;
  const pxPerUnit = (dir: Vec3): number => {
    const p = project({ x: position3D.x + dir.x, y: position3D.y + dir.y, z: position3D.z + dir.z });
    return Math.hypot(p.x - centerScreen.x, p.y - centerScreen.y);
  };
  const rateX = pxPerUnit(basis.x);
  const rateY = pxPerUnit(basis.y);
  const rateZ = pxPerUnit(basis.z);
  // An axis whose projected rate is below this is edge-on: no 3D length makes it
  // visible, so cap the extension instead of letting `targetPx / ~0` explode the
  // arm off-screen.
  const MIN_RATE = 0.02;
  const lenFor = (rate: number): number => targetPx / Math.max(rate, MIN_RATE);
  const axisLenX = lenFor(rateX);
  const axisLenY = lenFor(rateY);
  const axisLenZ = lenFor(rateZ);
  // Rings, planes and the reference length for anything not per-axis follow the
  // largest visible arm, so the gizmo keeps one coherent size.
  const axisLen3D = Math.max(axisLenX, axisLenY, axisLenZ) === Infinity
    ? targetPx
    : Math.min(axisLenX, axisLenY, axisLenZ);
  /** Below this projected length an arm is a point, not a draggable segment. */
  const MIN_AXIS_SCREEN_PX = 8;

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
    const list: Array<{ type: GizmoHandleType; dir: Vec3; len: number; c: string; hc: string }> = [
      { type: isPos ? 'pos_x' : 'scale_x', dir: basis.x, len: axisLenX, c: colors.x, hc: colors.hoverX },
      { type: isPos ? 'pos_y' : 'scale_y', dir: basis.y, len: axisLenY, c: colors.y, hc: colors.hoverY },
      { type: isPos ? 'pos_z' : 'scale_z', dir: basis.z, len: axisLenZ, c: colors.z, hc: colors.hoverZ },
    ];

    for (const item of list) {
      const tip3D = {
        x: position3D.x + item.dir.x * item.len,
        y: position3D.y + item.dir.y * item.len,
        z: position3D.z + item.dir.z * item.len,
      };
      const tipProj = project(tip3D);
      const screenLen = Math.hypot(tipProj.x - centerScreen.x, tipProj.y - centerScreen.y);

      axes.push({
        type: item.type,
        color: item.c,
        hoverColor: item.hc,
        startScreen: centerScreen,
        endScreen: { x: tipProj.x, y: tipProj.y },
        headScreen: { x: tipProj.x, y: tipProj.y },
        axis3DDir: item.dir,
        degenerate: !Number.isFinite(screenLen) || screenLen < MIN_AXIS_SCREEN_PX,
        screenLen: Number.isFinite(screenLen) ? screenLen : 0,
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
    // Rings sit OUTSIDE the position arrows (AE: arrows inside, trackball rings
    // outside), not inside them at 0.85×.
    //
    // This is the root of "only one side of the rotation ring is selectable".
    // A ring seen edge-on projects to a straight line THROUGH the origin,
    // spanning ±radius along one axis. At 0.85× that line was entirely covered
    // by the position arrows on the positive side, so — with the arrows also
    // hit-tested first — only the negative half of each ring could ever be
    // grabbed. Pushing the radius past the arrow tip leaves an unambiguous
    // outer band on BOTH sides, and the negative side is free either way
    // (arrows are drawn positive-only).
    const RING_RADIUS_FACTOR = 1.4;
    const arcRadius3D = axisLen3D * RING_RADIUS_FACTOR;
    const segments = 48;

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
        radiusPx: targetPx * RING_RADIUS_FACTOR,
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
 *
 * NEAREST WINS, not first-match.
 *
 * This used to be a priority cascade — every axis, then every plane, then every
 * arc, then the centre — returning on the first handle within tolerance. Because
 * all three axes start at the gizmo origin and the cascade order was the exact
 * REVERSE of the paint order, the handle drawn on top was always the one tested
 * last:
 *   • the centre uniform-scale dot (drawn topmost) could never be clicked at all
 * — `pos_x` claimed the origin first;
 *   • the planar handles share two edges with the axes, so only their far corner
 *     was reachable;
 *   • an edge-on rotation ring collapses onto an axis, and the axis won — so half
 *     of each ring was dead.
 * Distance-ranked hit-testing removes the ordering bias; ties fall back to paint
 * order (topmost drawn wins), which is what a user expects from what they see.
 */
export function hitTestGizmo3D(
  mouseScreen: { x: number; y: number },
  gizmo: RenderedGizmo3D,
  hitThresholdPx = 10,
): GizmoHandleType | null {
  const distToSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
  };

  // Tie-break priority (higher wins at equal distance).
  //
  // Planes sit under everything (they share two edges with the axes by
  // construction). Rings come next, then arrows, then the centre dot.
  //
  // Arrows outrank rings deliberately: an edge-on ring projects to a straight
  // line THROUGH the origin, so it overlaps its neighbouring arrow's whole shaft
  // at distance ~0. The ring is not stranded by losing that band — it is 1.4×
  // longer than the arrows, so it keeps an exclusive stretch beyond each tip, and
  // the entire negative side is arrow-free. The centre dot outranks all of them
  // because it is the smallest target and is painted topmost.
  const LAYER_PLANE = 0;
  const LAYER_ARC = 1;
  const LAYER_AXIS = 2;
  const LAYER_CENTRE = 3;
  const TIE_EPS = 0.75;

  let best: { type: GizmoHandleType; dist: number; layer: number } | null = null;
  const consider = (type: GizmoHandleType, dist: number, layer: number): void => {
    if (!Number.isFinite(dist) || dist > hitThresholdPx) return;
    if (
      best === null ||
      dist < best.dist - TIE_EPS ||
      (Math.abs(dist - best.dist) <= TIE_EPS && layer > best.layer)
    ) {
      best = { type, dist, layer };
    }
  };

  // Centre uniform-scale handle — a small target drawn on top of everything.
  consider(
    'scale_center',
    Math.hypot(mouseScreen.x - gizmo.centerScreen.x, mouseScreen.y - gizmo.centerScreen.y),
    LAYER_CENTRE,
  );

  // Axis arms. A degenerate (edge-on) arm is skipped: its segment has zero
  // length, so `distToSegment` would report the distance to the ORIGIN and let it
  // claim a full-tolerance disc there, beating every handle that legitimately
  // lives at the origin.
  for (const axis of gizmo.axes) {
    if (axis.degenerate) continue;
    consider(axis.type, distToSegment(mouseScreen, axis.startScreen, axis.endScreen), LAYER_AXIS);
  }

  // Planar handles — inside the quad counts as distance 0.
  for (const plane of gizmo.planes) {
    const pts = plane.pointsScreen;
    if (pts.length !== 4) continue;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const pi = pts[i];
      const pj = pts[j];
      if (!pi || !pj) continue;
      const intersect =
        pi.y > mouseScreen.y !== pj.y > mouseScreen.y &&
        mouseScreen.x < ((pj.x - pi.x) * (mouseScreen.y - pi.y)) / (pj.y - pi.y) + pi.x;
      if (intersect) inside = !inside;
    }
    if (inside) consider(plane.type, 0, LAYER_PLANE);
  }

  // Rotation rings — nearest point on the polyline.
  for (const arc of gizmo.arcs) {
    const pts = arc.pointsScreen;
    let nearest = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      const d = distToSegment(mouseScreen, a, b);
      if (d < nearest) nearest = d;
    }
    consider(arc.type, nearest, LAYER_ARC);
  }

  return best === null ? null : (best as { type: GizmoHandleType }).type;
}
