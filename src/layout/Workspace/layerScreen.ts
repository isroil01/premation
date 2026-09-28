/**
 * Layer-local ↔ screen, for every viewport overlay that draws on a layer
 * (Puppet / Bone pins, effect and gradient handles, roto strokes, track points).
 *
 * One projection, and it is the ENGINE's: the layer → comp matrix the overlay
 * geometry push carries (`OverlayLayerGeometry.matrix`, kind `transform`,
 * evaluated at the frame's own time — the parent chain and ANIMATED values
 * included, exactly what the renderer drew), composed with the viewport
 * camera's comp → screen. A 3D layer's matrix is its world 4×4; it is seen
 * through the view camera the push resolves (`OverlayView`, the `active` view),
 * so layer → comp is a plane-to-plane PROJECTION — a homography, exact for a
 * pinhole camera — and comp → layer its inverse (the ray met on the layer's own
 * plane, as After Effects resolves `fromComp`).
 *
 * `useLayerScreenMapping` (src/hooks) subscribes the layer to the push and
 * rebuilds the mapping when a frame lands.
 */

import { secondsToFlicks, type OverlayView } from '@motion/engine-api';
import { Project3D } from '@motion/scene';
import { MAIN_VIEWPORT, overlayLayer, overlayView, type OverlayLayer } from '@stores/overlayGeometry';
import { documentMirror } from '@stores/documentMirror';
import { viewCameraOf } from '@core/mirror/viewGeometry';
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

/** Layer-local → comp as a 3×3 (row-major) from a pushed record, or null without a matrix. */
export function layerToComp(
  record: OverlayLayer | undefined,
  threeD: boolean,
  view: OverlayView | undefined,
  comp: { width: number; height: number },
): H | null {
  const m = record?.matrix;
  if (!m || m.length < 16) return null;
  if (!threeD) {
    // The 2D chain as a column-major 4×4: x' = m0·x + m4·y + m12, y' = m1·x + m5·y + m13.
    return [m[0]!, m[4]!, m[12]!, m[1]!, m[5]!, m[13]!, 0, 0, 1];
  }
  const camera = viewCameraOf('active', view, {}, comp.width, comp.height);
  const local = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const projected = local.map((p) => {
    const w = {
      x: m[0]! * p.x + m[4]! * p.y + m[12]!,
      y: m[1]! * p.x + m[5]! * p.y + m[13]!,
      z: m[2]! * p.x + m[6]! * p.y + m[14]!,
    };
    const o = Project3D.projectPoint(w, camera);
    return { x: o.x, y: o.y };
  });
  return homography(local, projected);
}

/** The mapping for one pushed record, or null when there is none (not subscribed yet, gone). */
export function layerScreenMappingFrom(
  record: OverlayLayer | undefined,
  threeD: boolean,
  view: OverlayView | undefined,
  comp: { width: number; height: number },
  camera: Camera2DLike,
): LayerScreenMapping | null {
  const h = layerToComp(record, threeD, view, comp);
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

/**
 * The mapping for `nodeId` at comp `time` (seconds) from the main viewport's
 * push — the caller has subscribed the layer with kind `transform` and the
 * `active` view (`useLayerScreenMapping`, or its own request). Null before the
 * first record.
 */
export function layerScreenMapping(
  nodeId: string,
  time: number,
  comp: { width: number; height: number },
  camera: Camera2DLike,
): LayerScreenMapping | null {
  const at = secondsToFlicks(time);
  return layerScreenMappingFrom(overlayLayer(MAIN_VIEWPORT, nodeId, at), isThreeD(nodeId), overlayView(MAIN_VIEWPORT, 'active', at), comp, camera);
}
