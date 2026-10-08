/**
 * The main viewport's VIEW facts at call time, from the overlay geometry push
 * (B4 round 5, ENGINE_API.md §15.14) and the mirror — what useWorkspace's
 * camera navigation, motion path projection and "is this camera looked
 * through" asked the TypeScript engine's scene graph for:
 *
 *   navTargetNow / navUnavailableNow   cameraNav.ts findNavTarget / describeNavUnavailable
 *   orbitPivotNow                       cameraNav.ts resolveOrbitPivot
 *   viewProjectorNow                    viewProjection.ts currentViewProjector
 *   isLookedThroughNow                  ports.ts isLookedThrough
 *
 * The view camera and the scene's records come from the frame on screen; the
 * main view mode is subscribed by `requestMainViewCamera` (and by the 3D
 * reference geometry's own request, which also carries the 3D layers the
 * cursor pivot hits).
 */

import { secondsToFlicks } from '@motion/engine-api';
import type { Vec3 } from '@motion/scene';
import type { NavTarget } from '@core/workspace/cameraNav';
import { useGuidesStore } from '@stores/guidesStore';
import { getTime } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { MAIN_VIEWPORT, overlayLayer, overlayView, requestOverlayLayers } from '@stores/overlayGeometry';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { compHas3DContent, flattenCompLayers } from '@core/mirror/compLayers';
import { settingsWorld } from '@core/mirror/compFacts';
import { uiKindOf } from '@core/mirror/layerKinds';
import { isSceneCameraView } from '@core/scene/cameraViewMode';
import { mainViewCamera, mainViewProjector } from '@core/workspace/displayedView';
import {
  cameraOfLens,
  navTargetOf,
  navUnavailableMessage,
  orbitPivotFrom,
  sceneLayersOf,
  type PivotPlane,
} from '@core/mirror/viewGeometry';

/** The active tab's composition id (the mirror's comp key), or undefined. */
function activeCompId(): string | undefined {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
}

/** Keep the main view mode's camera in the push (useWorkspace mounts it for the viewport's lifetime). */
export function requestMainViewCamera(): () => void {
  const sync = (mode: string): void => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'viewNav', [], [], [mode]);
  };
  let last = useGuidesStore.getState().camera3dMode;
  sync(last);
  const off = useGuidesStore.subscribe((s) => {
    if (s.camera3dMode === last) return;
    last = s.camera3dMode;
    sync(last);
  });
  return () => {
    off();
    void requestOverlayLayers(MAIN_VIEWPORT, 'viewNav', [], [], []);
  };
}

const now = (): number => secondsToFlicks(getTime());

/** The navigation target of the main view (null: navigation means nothing here). */
export function navTargetNow(): NavTarget | null {
  const mode = useGuidesStore.getState().camera3dMode;
  const has3D = compHas3DContent(documentMirror(), activeCompId(), false);
  return navTargetOf(mode, overlayView(MAIN_VIEWPORT, mode, now()), has3D);
}

/** Why camera navigation is unavailable right now (null when it is available). */
export function navUnavailableNow(): string | null {
  if (navTargetNow()) return null;
  const m = documentMirror();
  const comp = activeCompId();
  const hasCamera = flattenCompLayers(m, comp).some((id) => uiKindOf(m.layer(id)) === 'camera');
  return navUnavailableMessage(useGuidesStore.getState().camera3dMode, compHas3DContent(m, comp, false), hasCamera);
}

/**
 * The orbit pivot for a drag starting at `cursor` (comp px) on a scene camera:
 * through the camera the tools drive, onto the composition's 3D layers as the
 * frame on screen places them.
 */
export function orbitPivotNow(cursor: { x: number; y: number } | null, compWidth: number, compHeight: number): Vec3 | null {
  const g = useGuidesStore.getState();
  const mode = g.camera3dMode;
  const at = now();
  const view = overlayView(MAIN_VIEWPORT, mode, at);
  const live = view?.liveCamera ? overlayLayer(MAIN_VIEWPORT, view.liveCamera, at)?.scene : undefined;
  const cam = (live?.role === 'camera' ? cameraOfLens(live.lens) : null) ?? mainViewCamera(compWidth, compHeight, at, mode);
  const m = documentMirror();
  const planes: PivotPlane[] = [];
  for (const id of sceneLayersOf(m, activeCompId())) {
    if (m.layer(id)?.switches.visible === false) continue;
    const rec = overlayLayer(MAIN_VIEWPORT, id, at);
    if (rec?.scene?.role !== 'layer' || rec.box.length !== 4) continue;
    planes.push({ world: rec.matrix, width: rec.box[2]!, height: rec.box[3]! });
  }
  const groundLevel = Number(settingsWorld(activeCompSettingsNow()).groundLevel);
  const poi = live?.role === 'camera' && live.poi.length === 3 ? { x: live.poi[0]!, y: live.poi[1]!, z: live.poi[2]! } : null;
  return orbitPivotFrom(cursor, g.cameraOrbitPivot, cam, planes, compWidth, compHeight, Number.isFinite(groundLevel) ? groundLevel : 0, poi);
}

/** The main view's world → comp projector at comp seconds `time` (the frame on screen's camera). */
export function viewProjectorNow(compWidth: number, compHeight: number, time: number): (p: Vec3) => { x: number; y: number } {
  return mainViewProjector(compWidth, compHeight, secondsToFlicks(time));
}

/** Is `nodeId` the camera the main view looks through? */
export function isLookedThroughNow(nodeId: string): boolean {
  const mode = useGuidesStore.getState().camera3dMode;
  if (!isSceneCameraView(mode)) return false;
  return overlayView(MAIN_VIEWPORT, mode, now())?.camera === nodeId;
}
