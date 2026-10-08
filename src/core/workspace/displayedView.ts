/**
 * The MAIN viewport's view AS DISPLAYED — the view the frame on screen was
 * drawn with — for everything drawn over that frame.
 *
 * The page's view state is LIVE: the workspace camera's pan / zoom and
 * guidesStore's custom-view orbits move the moment a gesture, a key or an eased
 * dolly moves them, while the engine's picture follows once it has drawn the
 * new view. An overlay that projected through the live state drew its
 * wireframes, gizmo and handles over a picture of a different view whenever the
 * two parted — and stayed there when nothing told it to re-read (a framing
 * restored by a view-switch key, the eased Alt+wheel dolly still gliding after
 * the last wheel tick).
 *
 * EngineSurface publishes the viewport the engine had applied with every frame
 * it draws (overlayGeometry `OverlayFrameView`); this module is the one read of
 * it. Where no engine frame is on screen (a test without one, a browser build,
 * before the first frame) the live state IS what is displayed.
 *
 * The view MODE stays the live one: a view switch takes the overlays to the new
 * view at once, while its first frame (and that view's pushed camera) arrives a
 * frame or two later.
 *
 * FOLLOW-UP (engine protocol, not done here): a frame is matched to its
 * viewport by WHEN it arrives — the setViewport acknowledged before it (the
 * surfaces' `applied`). A frame the engine rendered just before applying a new
 * viewport but delivered after the acknowledgement is labelled with the new
 * view for that one frame. Exact would be the engine echoing a viewport
 * generation in `EngineFrameMeta` (bumped per applied setViewport, sent back in
 * its reply), which the surfaces would key `applied` by.
 */

import type { Camera3D, Project3D, Vec3 } from '@motion/scene';
import { useGuidesStore } from '@stores/guidesStore';
import { MAIN_VIEWPORT, overlayFrameView, overlayView } from '@stores/overlayGeometry';
import { projectorOf, viewCameraOf } from '@core/mirror/viewGeometry';
import { getWorkspaceController } from './WorkspaceController';
import { isCustomViewId, type CustomViewParams } from './customViews';
import type { RenderView } from './renderView';

/**
 * The comp → stage transform (CSS px) of the frame on screen: the page camera
 * its viewport was sent from — the same object for every frame of that
 * viewport, so a per-frame read allocates nothing. The live controller view
 * when no engine frame is on screen.
 */
export function displayedRenderView(): RenderView {
  return overlayFrameView(MAIN_VIEWPORT)?.render ?? getWorkspaceController().getView();
}

/** Live-camera screen px → the picture's: `x·k + tx`, `y·k + ty`. */
export interface PictureGlue {
  k: number;
  tx: number;
  ty: number;
}

/**
 * The map from the LIVE camera's screen px to the frame on screen's — what puts
 * chrome built in the live camera's space (the workspace's selection outlines
 * and handles, guides, snap lines, the motion path, the ROI) onto the picture.
 * Null when the two agree: the steady state.
 */
export function pictureGlue(live: RenderView, shown: RenderView): PictureGlue | null {
  if (shown.scale === live.scale && shown.offsetX === live.offsetX && shown.offsetY === live.offsetY) return null;
  if (!(live.scale > 0) || !(shown.scale > 0)) return null;
  const k = shown.scale / live.scale;
  return { k, tx: shown.offsetX - live.offsetX * k, ty: shown.offsetY - live.offsetY * k };
}

/**
 * {@link pictureGlue} of the main viewport now. Without an engine frame the
 * live view IS the picture's (null, nothing read). With one it builds the live
 * RenderView — once per overlay paint, which allocates its chrome anyway.
 */
export function mainPictureGlue(): PictureGlue | null {
  const f = overlayFrameView(MAIN_VIEWPORT);
  return f ? pictureGlue(getWorkspaceController().getView(), f.render) : null;
}

/** A point in live-camera screen px on the picture. */
export function onPicture(glue: PictureGlue | null, x: number, y: number): { x: number; y: number } {
  return glue ? { x: x * glue.k + glue.tx, y: y * glue.k + glue.ty } : { x, y };
}

/**
 * The orbit the frame on screen was drawn with, for a custom-view `mode` of
 * the main viewport — null when the frame is not a custom view (or there is no
 * engine frame): the stored params are then the ones to use.
 */
export function drawnCustomView(mode: string): CustomViewParams | null {
  if (!isCustomViewId(mode)) return null;
  const f = overlayFrameView(MAIN_VIEWPORT);
  return f?.view === 'custom' ? f.customView : null;
}

/**
 * The camera the main viewport's `mode` (default: the current view) projects
 * through at comp time `at` (flicks): the pushed view camera of the frame on
 * screen (a `camera:<id>` view its own camera, not the active one), a custom
 * view's orbit as drawn. The axis views report it too; they project without it.
 */
export function mainViewCamera(
  compWidth: number,
  compHeight: number,
  at: number,
  mode: string = useGuidesStore.getState().camera3dMode,
): Camera3D {
  return viewCameraOf(mode, overlayView(MAIN_VIEWPORT, mode, at), useGuidesStore.getState().customViews, compWidth, compHeight, drawnCustomView(mode));
}

/**
 * World → comp projection of the main viewport's `mode` (default: the current
 * view) at comp time `at` (flicks): orthographic for the axis views, through
 * {@link mainViewCamera} otherwise.
 */
export function mainViewProjector(
  compWidth: number,
  compHeight: number,
  at: number,
  mode: string = useGuidesStore.getState().camera3dMode,
): (p: Vec3) => Project3D.Projected {
  return projectorOf(mode, mainViewCamera(compWidth, compHeight, at, mode), compWidth, compHeight);
}
