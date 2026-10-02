/**
 * B4 round 5 — the VIEW half of the overlay geometry push (ENGINE_API.md
 * §15.14), the TypeScript engine's side: a subscribed view mode's resolved
 * view camera (`OverlayView`) and one camera's / light's / 3D layer's
 * reference-geometry inputs (`OverlayScene3D`, kind `scene3d`), at a comp time.
 *
 * Every number here is what the viewport's 3D chrome used to compute in the
 * page from the scene graph (useSceneRefGeometry, sceneGizmoData.ts,
 * deviceHandles.ts, FocusPlaneOverlay, useGizmo3d's sampleTransform3DAtPlayhead,
 * cameraNav's findCameraNav) — the same resolvers, so the chrome still lands on
 * the pixels. The C++ twin is native/engine/src/core/overlay_geometry.cpp
 * (`scene3d_of`, `view_of`).
 */

import type { OverlayScene3D, OverlayView } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { Project3D, type Camera3D } from '@motion/scene';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { canBe3D, is3DEnabled, readNode3D } from '@core/scene/threeD';
import { readNodeLight } from '@core/scene/light';
import { cameraFromNode, readCameraFocusDistance, readCameraPoi, readNodeDof, viewCameraNode } from '@core/scene/camera3d';
import { deviceWorldPosition, deviceWorldRotationDeg, parentWorldMatrixAt, toWorldPointAt } from '@core/scene/liveWorld3d';
import { readGeometry } from '@core/workspace/geometry';
import { compSizeOf, compSourceOf } from '@core/composition/compSizes';
import { getRemappedTime, governingClipsFor } from '@core/timeline/TimelineController';
import { compOfLayer } from '@core/mirror/docFacts';
import { compFps } from './time';

/** A resolved Camera3D as the push carries it: position, focalLength, principal, yaw, pitch, roll. */
export function lensOf(cam: Camera3D): number[] {
  return [
    cam.position.x, cam.position.y, cam.position.z, cam.focalLength, cam.principal.x, cam.principal.y,
    cam.orientation?.yaw ?? 0, cam.orientation?.pitch ?? 0, cam.orientation?.roll ?? 0,
  ];
}

function compSize(comp: string | undefined): { width: number; height: number } {
  return (comp ? compSizeOf(comp) : undefined) ?? { width: 1920, height: 1080 };
}

/** A node's animated values at comp `seconds` (remapped like the renderer), as the camera readers' sampler. */
function samplerOf(id: string, seconds: number): { values: Map<string, number>; sample: (nid: string, p: string) => number | undefined } {
  const values = defaultAnimation.evaluateNode(id, getRemappedTime(id, seconds));
  return { values, sample: (nid, p) => (nid === id ? values.get(p) : undefined) };
}

/** The Transform component's static scaleZ (1 when absent) — ports.ts `staticScaleZOf`. */
function staticScaleZOf(id: string): number {
  const t = defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Transform');
  const v = t ? (t.props as Record<string, unknown>).scaleZ : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}

/**
 * One layer's scene3d record at comp `seconds`, or undefined when it is not a
 * camera, a light or a 3D-enabled layer that can be 3D.
 */
export function scene3dOf(id: string, seconds: number): OverlayScene3D | undefined {
  const node = defaultSceneGraph.getNode(id);
  if (!node) return undefined;
  const kind = readNodeKind(node);
  const { width, height } = compSize(compOfLayer(id) ?? undefined);
  const parentM = parentWorldMatrixAt(id, seconds);
  const rec: OverlayScene3D = {
    role: 'layer', lens: [], poi: [], focusDistance: 0, dof: [], lightType: '', position: [], light: [], local: [], extrusion: 0,
    parent: parentM ? Array.from(parentM) : [],
  };
  const lift = (nid: string, p: { x: number; y: number; z: number }) => toWorldPointAt(nid, seconds, p);
  if (kind === 'camera') {
    const { sample } = samplerOf(id, seconds);
    rec.role = 'camera';
    rec.lens = lensOf(cameraFromNode(node, width, height, sample, lift));
    const localPoi = readCameraPoi(node, width, height, sample);
    if (localPoi) {
      const p = toWorldPointAt(id, seconds, localPoi);
      rec.poi = [p.x, p.y, p.z];
    }
    rec.focusDistance = readCameraFocusDistance(node, width, sample);
    const dof = readNodeDof(node, width, height, sample);
    if (dof) rec.dof = [dof.strength, dof.focus, dof.aperture, dof.focalLength ?? NaN, dof.fStop ?? NaN];
    return rec;
  }
  if (kind === 'light') {
    const { values } = samplerOf(id, seconds);
    const lt = readNodeLight(node);
    rec.role = 'light';
    rec.lightType = lt.type;
    const pos = deviceWorldPosition(node, seconds);
    rec.position = [pos.x, pos.y, pos.z];
    if (lt.poi) {
      const p = toWorldPointAt(id, seconds, {
        x: values.get('poiX') ?? lt.poi.x,
        y: values.get('poiY') ?? lt.poi.y,
        z: values.get('poiZ') ?? lt.poi.z,
      });
      rec.poi = [p.x, p.y, p.z];
    }
    rec.light = [
      values.get('radius') ?? lt.radius,
      values.get('lightCone') ?? lt.cone,
      values.get('lightConeFeather') ?? lt.coneFeather,
      (values.get('lightAngle') ?? lt.angle) + deviceWorldRotationDeg(node, seconds),
    ];
    return rec;
  }
  if (!canBe3D(node) || !is3DEnabled(node)) return undefined;
  // ports.ts `sampleTransform3DAtPlayhead` at the frame's time.
  const { values: av } = samplerOf(id, seconds);
  const g = readGeometry(node);
  const n3d = readNode3D(node);
  rec.local = [
    av.get('x') ?? g?.x ?? 0,
    av.get('y') ?? g?.y ?? 0,
    av.get('z') ?? n3d.z,
    av.get('rotationX') ?? n3d.rotationX,
    av.get('rotationY') ?? n3d.rotationY,
    av.get('rotation') ?? g?.rotationDeg ?? 0,
    av.get('scaleX') ?? av.get('scale') ?? g?.scaleX ?? 1,
    av.get('scaleY') ?? av.get('scale') ?? g?.scaleY ?? 1,
    av.get('scaleZ') ?? staticScaleZOf(id),
  ];
  rec.extrusion = Math.max(0, av.get('extrusionDepth') ?? n3d.extrusionDepth);
  return rec;
}

/**
 * Is the layer inside its in/out bar at comp `seconds` — the renderer's
 * `isLiveAt` (end-exclusive spans, clamped to the last comp frame) —
 * cameraNav.ts `isLiveAtPlayhead` asked at the frame's time.
 */
function isLiveAt(id: string, comp: string, seconds: number): boolean {
  const clips = governingClipsFor(id);
  if (clips.length === 0) return true;
  const fps = compFps(comp);
  const duration = compSourceOf(comp)?.durationSeconds;
  const raw = Math.round(seconds * fps);
  const frame = typeof duration === 'number' ? Math.min(raw, Math.max(0, Math.round(duration * fps) - 1)) : raw;
  return clips.some((l) => l.isActiveAt(frame));
}

/** A subscribed view mode's view camera in composition `comp` at comp `seconds` (useSceneRefGeometry's resolution). */
export function viewOf(mode: string, comp: string, seconds: number): OverlayView {
  const { width, height } = compSize(comp);
  const chrome = viewCameraNode(defaultSceneGraph, mode, comp);
  const live = viewCameraNode(defaultSceneGraph, mode, comp, { isLiveAt: (id) => isLiveAt(id, comp, seconds) });
  let cam: Camera3D;
  if (chrome) {
    const { sample } = samplerOf(chrome.id, seconds);
    cam = cameraFromNode(chrome, width, height, sample, (nid, p) => toWorldPointAt(nid, seconds, p));
  } else {
    cam = Project3D.defaultCamera(width, height);
  }
  return { mode, camera: chrome?.id ?? '', liveCamera: live?.id ?? '', lens: lensOf(cam), compWidth: width, compHeight: height };
}
