/**
 * The main viewport's view AS DISPLAYED (displayedView.ts): the view the frame
 * on screen was drawn with while the C++ engine draws the viewport, the live
 * page state otherwise.
 */

import type { OverlayView } from '@motion/engine-api';
import { Project3D } from '@motion/scene';
import { cameraOfLens } from '@core/mirror/viewGeometry';
import { useGuidesStore } from '@stores/guidesStore';
import { MAIN_VIEWPORT, overlayFrameView, publishFrameGeometry, publishFrameView, setEngineDrivenViewport, subscribeOverlayGeometry, type OverlayFrameView } from '@stores/overlayGeometry';
import { customViewCamera, type CustomViewParams } from './customViews';
import { displayedRenderView, drawnCustomView, mainPictureGlue, mainViewCamera, onPicture, pictureGlue } from './displayedView';

jest.mock('./WorkspaceController', () => ({
  getWorkspaceController: () => ({ getView: () => ({ scale: 0.75, offsetX: 12, offsetY: 34 }) }),
}));

const LIVE = { scale: 0.75, offsetX: 12, offsetY: 34 };
const ORBIT: CustomViewParams = { yaw: 12, pitch: -8, distance: 3000, poi: { x: 600, y: 300, z: 50 } };
const frame = (view: string, customView: CustomViewParams | null = null): OverlayFrameView => ({
  render: { scale: 0.19, offsetX: 400, offsetY: 220 }, view, customView,
});
const lensView = (mode: string, lens: number[]): OverlayView => ({ mode, camera: mode, liveCamera: mode, lens, compWidth: 1920, compHeight: 1080 });

const initialMode = useGuidesStore.getState().camera3dMode;
const initialCustom = useGuidesStore.getState().customViews;

afterEach(() => {
  setEngineDrivenViewport(MAIN_VIEWPORT, false);
  useGuidesStore.setState({ camera3dMode: initialMode, customViews: initialCustom });
});

describe('displayedRenderView', () => {
  it('is the live page camera with no engine frame on screen', () => {
    expect(displayedRenderView()).toEqual(LIVE);
    // A frame view published for a viewport the engine does not draw is not "on screen".
    publishFrameView(MAIN_VIEWPORT, frame('active'));
    expect(displayedRenderView()).toEqual(LIVE);
  });

  it('is the frame’s own transform — the same object, frame after frame — while the engine draws the viewport', () => {
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    expect(displayedRenderView()).toEqual(LIVE);  // engine-driven, nothing drawn yet
    const f = frame('active');
    publishFrameGeometry(MAIN_VIEWPORT, 0, 1, [], [], f);
    expect(displayedRenderView()).toBe(f.render);
    // A frame with no view to report keeps the last one.
    publishFrameGeometry(MAIN_VIEWPORT, 0, 2, [], []);
    expect(displayedRenderView()).toBe(f.render);
  });

  it('tells the overlays when the engine stops drawing, and forgets the frame', () => {
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    publishFrameView(MAIN_VIEWPORT, frame('active'));
    let told = 0;
    const off = subscribeOverlayGeometry(MAIN_VIEWPORT, () => { told += 1; });
    setEngineDrivenViewport(MAIN_VIEWPORT, false);
    off();
    expect(told).toBe(1);
    expect(overlayFrameView(MAIN_VIEWPORT)).toBeUndefined();
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    expect(displayedRenderView()).toEqual(LIVE);
  });

  it('publishFrameView tells the overlays only when the view is a different one', () => {
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    let told = 0;
    const off = subscribeOverlayGeometry(MAIN_VIEWPORT, () => { told += 1; });
    const f = frame('active');
    publishFrameView(MAIN_VIEWPORT, f);
    publishFrameView(MAIN_VIEWPORT, f);
    publishFrameView(MAIN_VIEWPORT, f);
    expect(told).toBe(1);
    publishFrameView(MAIN_VIEWPORT, frame('front'));
    expect(told).toBe(2);
    off();
  });
});

describe('drawnCustomView / mainViewCamera', () => {
  it('a custom view takes the orbit its frame was drawn with; the stored one without such a frame', () => {
    useGuidesStore.getState().setCamera3dMode('custom2');
    const stored = useGuidesStore.getState().customViews.custom2;
    expect(drawnCustomView('custom2')).toBeNull();
    expect(mainViewCamera(1920, 1080, 0)).toEqual(customViewCamera(stored, 1920, 1080));

    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    publishFrameView(MAIN_VIEWPORT, frame('custom', ORBIT));
    expect(drawnCustomView('custom2')).toBe(ORBIT);
    expect(mainViewCamera(1920, 1080, 0)).toEqual(customViewCamera(ORBIT, 1920, 1080));

    // Not a custom view, or a frame that is not one: no drawn orbit.
    expect(drawnCustomView('active')).toBeNull();
    publishFrameView(MAIN_VIEWPORT, frame('front'));
    expect(drawnCustomView('custom2')).toBeNull();
  });

  it('a `camera:<id>` view resolves through its OWN pushed camera, not the active one', () => {
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    const active = [960, 540, -2400, 2400, 960, 540, 0, 0, 0];
    const other = [100, 200, -900, 1200, 960, 540, -30, 10, 0];
    publishFrameGeometry(MAIN_VIEWPORT, 0, 1, [], [lensView('active', active), lensView('camera:c9', other)]);
    useGuidesStore.getState().setCamera3dMode('camera:c9');
    expect(mainViewCamera(1920, 1080, 0)).toEqual(cameraOfLens(other));
    useGuidesStore.getState().setCamera3dMode('active');
    expect(mainViewCamera(1920, 1080, 0)).toEqual(cameraOfLens(active));
    // Before any frame carries the view: the default camera framed to the comp.
    setEngineDrivenViewport(MAIN_VIEWPORT, false);
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    expect(mainViewCamera(1920, 1080, 0)).toEqual(Project3D.defaultCamera(1920, 1080));
  });
});

describe('pictureGlue — chrome built in the live camera’s px, put on the picture', () => {
  const at = (v: { scale: number; offsetX: number; offsetY: number }, c: { x: number; y: number }) => ({ x: c.x * v.scale + v.offsetX, y: c.y * v.scale + v.offsetY });

  it('is null when the picture is drawn with the live view (the steady state)', () => {
    expect(pictureGlue(LIVE, { ...LIVE })).toBeNull();
  });

  it('maps a comp point drawn by the live camera onto where the frame on screen draws it — pan and zoom', () => {
    const shown = { scale: 0.19, offsetX: 400, offsetY: 220 };
    const g = pictureGlue(LIVE, shown);
    expect(g).not.toBeNull();
    for (const c of [{ x: 0, y: 0 }, { x: 1920, y: 1080 }, { x: 2900, y: -340 }]) {
      const live = at(LIVE, c);
      const want = at(shown, c);
      const got = onPicture(g, live.x, live.y);
      expect(got.x).toBeCloseTo(want.x, 9);
      expect(got.y).toBeCloseTo(want.y, 9);
    }
    // A pan alone only translates (line widths and handle sizes untouched).
    expect(pictureGlue(LIVE, { ...LIVE, offsetX: LIVE.offsetX - 30 })!.k).toBe(1);
  });

  it('of the main viewport: none without an engine frame, the frame’s against the live camera with one', () => {
    expect(mainPictureGlue()).toBeNull();
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    expect(mainPictureGlue()).toBeNull();  // no frame drawn yet
    publishFrameView(MAIN_VIEWPORT, { render: { ...LIVE }, view: 'active', customView: null });
    expect(mainPictureGlue()).toBeNull();  // drawn with the live view
    const f = frame('active');
    publishFrameView(MAIN_VIEWPORT, f);
    expect(mainPictureGlue()).toEqual(pictureGlue(LIVE, f.render));
  });
});
