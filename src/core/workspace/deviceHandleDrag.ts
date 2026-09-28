/**
 * The write half of dragging a camera / light handle (deviceHandles.ts
 * `dragDeviceHandleTo`) over the overlay geometry push (B4 round 5): the
 * handle carries its device's parent-chain world matrix from the frame on
 * screen, so turning the pointer's WORLD point into the PARENT-space values the
 * layer stores needs no document read. Writes go through the engine
 * (`sendNodeValues`: one engine gesture per drag, keys where the property is
 * animated or Auto-Keyframe is on).
 */

import type { Vec3 } from '@motion/scene';
import { toParentSpace, type DeviceHandle } from '@core/mirror/viewGeometry';
import { sendNodeValues } from '@core/workspace/ports';

/** The prop triple a handle writes. */
const PROPS: Record<DeviceHandle['kind'], readonly [string, string, string]> = {
  position: ['x', 'y', 'z'],
  poi: ['poiX', 'poiY', 'poiZ'],
};

/**
 * Move a handle to `worldTarget` (ABSOLUTE: each message of the drag is the
 * whole answer), writing parent-space values — only the handle's own three
 * props (dragging the eye never drags the target).
 */
export function dragDeviceHandle(handle: DeviceHandle, worldTarget: Vec3): void {
  const local = toParentSpace(handle.parent, worldTarget);
  const [px, py, pz] = PROPS[handle.kind];
  const what = handle.kind === 'poi' ? 'Point of Interest' : handle.device === 'camera' ? 'Camera' : 'Light';
  sendNodeValues(
    handle.nodeId,
    { [px]: local.x, [py]: local.y, [pz]: local.z },
    `Move ${what}`,
    `devicehandle:${handle.nodeId}:${handle.kind}`,
  );
}
