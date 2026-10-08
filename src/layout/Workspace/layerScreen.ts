/**
 * Layer-local ↔ screen, for every viewport overlay that draws on a layer
 * (Puppet / Bone pins, effect and gradient handles, roto strokes, track points).
 *
 * One projection, and it is the ENGINE's: the layer → comp matrix the overlay
 * geometry push carries (`OverlayLayerGeometry.matrix`, kind `transform`,
 * evaluated at the frame's own time — the parent chain and ANIMATED values
 * included, exactly what the renderer drew), composed with the viewport
 * camera's comp → screen. A 3D layer's matrix is its world 4×4; it is seen
 * through the view on screen — the current view mode's projection
 * (core/workspace/displayedView.ts `mainViewProjector`: an axis view's
 * orthographic one, a `camera:<id>` view's own camera, a custom view's orbit
 * as drawn, else the camera the push resolves) — so layer → comp is a
 * plane-to-plane PROJECTION — a homography, exact for a pinhole camera and
 * affine for an axis view — and comp → layer its inverse (the ray met on the
 * layer's own plane, as After Effects resolves `fromComp`).
 *
 * It used to project through the ACTIVE camera in every view, so in Top / Left
 * / a custom view / another camera's view the pins and handles of a 3D layer
 * sat where the active camera would have drawn it, not on the layer.
 *
 * `useLayerScreenMapping` (src/hooks) subscribes the layer to the push and
 * rebuilds the mapping when a frame lands.
 */

import { secondsToFlicks } from '@motion/engine-api';
import type { Vec3 } from '@motion/scene';
import { MAIN_VIEWPORT, overlayLayer, type OverlayLayer } from '@stores/overlayGeometry';
import { documentMirror } from '@stores/documentMirror';
import { mainViewProjector } from '@core/workspace/displayedView';
import type { Camera2DLike } from './cameraTypes';

export interface LayerScreenMapping {
  /** Layer-local px → viewport screen px. */
  localToScreen: (lx: number, ly: number) => { x: number; y: number };
  /** Viewport screen px → layer-local px. */
  screenToLocal: (sx: number, sy: number) => { x: number; y: number };
}

type H = [number, number, number, number, number, number, number, number, number];

function apply(h: H, x: number, y: number): { x: number; y: number } {
  const w = h[6] * x + h[7] * y + h[8];
  const d = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
}

function invert3(h: H): H | null {
  const [a, b, c, d, e, f, g, i, k] = h;
  const A = e * k - f * i;
  const B = -(d * k - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const s = 1 / det;
  return [
    A * s, -(b * k - c * i) * s, (b * f - c * e) * s,
    B * s, (a * k - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * i - b * g) * s, (a * e - b * d) * s,
  ];
}

/** The homography taking the four `src` points onto `dst` (DLT, h33 = 1), or null when degenerate. */
export function homography(src: ReadonlyArray<{ x: number; y: number }>, dst: ReadonlyArray<{ x: number; y: number }>): H | null {
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented system.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv]!, m[col]!];
    const row = m[col]!;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / row[col]!;
      if (f === 0) continue;
      for (let k = col; k < 9; k++) m[r]![k]! -= f * row[k]!;
    }
  }
  const h = m.map((r, i) => r[8]! / r[i]!);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** World → comp px of the view a 3D layer is seen through (viewGeometry `projectorOf`). */
export type ViewProjector = (p: Vec3) => { x: number; y: number };

/**
 * Layer-local → comp as a 3×3 (row-major) from a pushed record, or null without
 * a matrix (or for a 3D layer seen edge-on, whose plane has no inverse). A 3D
 * layer's plane goes through `project`, the view on screen.
 */
export function layerToComp(
  record: OverlayLayer | undefined,
  threeD: boolean,
  project: ViewProjector,
): H | null {
  const m = record?.matrix;
  if (!m || m.length < 16) return null;
  if (!threeD) {
    // The 2D chain as a column-major 4×4: x' = m0·x + m4·y + m12, y' = m1·x + m5·y + m13.
    return [m[0]!, m[4]!, m[12]!, m[1]!, m[5]!, m[13]!, 0, 0, 1];
  }
  const local = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const projected = local.map((p) => {
    const o = project({
      x: m[0]! * p.x + m[4]! * p.y + m[12]!,
      y: m[1]! * p.x + m[5]! * p.y + m[13]!,
      z: m[2]! * p.x + m[6]! * p.y + m[14]!,
    });
    return { x: o.x, y: o.y };
  });
  if (!projected.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  return homography(local, projected);
}

/** The mapping for one pushed record, or null when there is none (not subscribed yet, gone). */
export function layerScreenMappingFrom(
  record: OverlayLayer | undefined,
  threeD: boolean,
  project: ViewProjector,
  camera: Camera2DLike,
): LayerScreenMapping | null {
  const h = layerToComp(record, threeD, project);
  if (!h) return null;
  const inv = invert3(h);
  return {
    localToScreen: (lx, ly) => camera.worldToScreen(apply(h, lx, ly)),
    screenToLocal: (sx, sy) => {
      const w = camera.screenToWorld({ x: sx, y: sy });
      return inv ? apply(inv, w.x, w.y) : { x: 0, y: 0 };
    },
  };
}

/** Cameras and lights live in 3D space even without the switch. */
function isThreeD(nodeId: string): boolean {
  const l = documentMirror().layer(nodeId);
  return l?.switches.threeD === true || l?.kind === 'camera' || l?.kind === 'light';
}

/** A 2D layer's mapping never projects (its chain is already comp px). */
const FLAT: ViewProjector = (p) => p;

/**
 * The mapping for `nodeId` at comp `time` (seconds) from the main viewport's
 * push, through the main viewport's current view — the caller has subscribed
 * the layer with kind `transform` (`useLayerScreenMapping`, or its own request;
 * the view mode's camera rides the frames for the viewport's lifetime,
 * viewNav.ts `requestMainViewCamera`). Null before the first record.
 */
export function layerScreenMapping(
  nodeId: string,
  time: number,
  comp: { width: number; height: number },
  camera: Camera2DLike,
): LayerScreenMapping | null {
  const at = secondsToFlicks(time);
  const record = overlayLayer(MAIN_VIEWPORT, nodeId, at);
  if (!record) return null;
  const threeD = isThreeD(nodeId);
  return layerScreenMappingFrom(record, threeD, threeD ? mainViewProjector(comp.width, comp.height, at) : FLAT, camera);
}
