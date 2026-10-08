/**
 * The 3D overlays follow the VIEW ON SCREEN — with no pointer event involved.
 *
 * Regression (2026-10-08, "the selected layer's box and gizmo are drawn
 * somewhere else after I move the view, especially in 3D"): the gizmo's comp →
 * canvas transform was React state re-read ONLY on window wheel / pointermove /
 * pointerup. Every framing change no pointer event announces left the gizmo,
 * the layer boxes and the light / camera wireframes at the old framing over a
 * picture drawn at the new one, until the mouse happened to move:
 *   • the `1` / `2` view-switch keys restore that view's own pan and zoom
 *     (`restoreFraming`);
 *   • the eased Alt+wheel dolly keeps zooming an axis view for ~20 frames after
 *     the last wheel tick (cameraNav `smoothDollyNavBy`);
 *   • the auto-fit after a panel resize.
 * And the custom view's camera was the STORED orbit, which runs ahead of the
 * picture while the view is navigated: the overlays now project through the
 * view the engine's frame on screen was drawn with (overlayGeometry
 * `OverlayFrameView`, published by EngineSurface with each frame).
 *
 * The real useGizmo3d against the real WorkspaceController — no engine: the
 * frames are published here the way EngineSurface publishes them.
 */

import { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import type { Camera3D } from '@motion/scene';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { smoothDollyNavBy } from '@core/workspace/cameraNav';
import { customViewCamera, type CustomViewParams } from '@core/workspace/customViews';
import type { RenderView } from '@core/workspace/renderView';
import { useGuidesStore } from '@stores/guidesStore';
import { MAIN_VIEWPORT, publishFrameView, setEngineDrivenViewport, type OverlayFrameView } from '@stores/overlayGeometry';
import { useGizmo3d } from './useGizmo3d';
import { useDisplayedCamera2D } from './useOverlayView';
import type { Camera2DLike } from './cameraTypes';

/** What the mounted gizmo last rendered with. */
let shown: { view: RenderView; camera: Camera3D } | null = null;

function Harness(): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  // No view options: the MAIN viewport, exactly as Workspace's Gizmo3dLayer mounts it.
  const g = useGizmo3d(stageRef);
  shown = { view: g.viewTransform, camera: g.camera };
  return <div ref={stageRef} />;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => resolve()); });

/** Mount the gizmo and let its overlay subscriptions settle (they answer asynchronously). */
async function mount(): Promise<void> {
  render(<Harness />);
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
}

const c = getWorkspaceController();
const INITIAL = c.framing();
const initialMode = useGuidesStore.getState().camera3dMode;
const initialCustom = useGuidesStore.getState().customViews;

beforeEach(() => {
  c.resize(1280, 720, 1, false);
  c.restoreFraming(INITIAL);
  shown = null;
});

afterEach(() => {
  cleanup();
  setEngineDrivenViewport(MAIN_VIEWPORT, false);
  useGuidesStore.setState({ camera3dMode: initialMode, customViews: initialCustom });
  c.restoreFraming(INITIAL);
});

describe('main viewport, no engine frame: the overlay follows the live camera without pointer input', () => {
  it('a framing restored by a view-switch key moves the gizmo with it', async () => {
    await mount();
    const before = shown!.view;
    expect(before).toEqual(c.getView());

    // Pressing `2` with Custom View 1 framed at 19 % far to the right
    // (useWorkspace restores the stashed framing) — a key, so no pointer event.
    act(() => {
      c.restoreFraming({ center: { x: 2900, y: 540 }, zoom: 0.19 });
      // The render tick the change requested, run now instead of on the next rAF.
      c.flushRender();
    });

    expect(shown!.view).toEqual(c.getView());
    expect(shown!.view).not.toEqual(before);
    expect(shown!.view.scale).toBeCloseTo(0.19, 9);
  });

  it('the eased dolly of an axis view keeps zooming after the last wheel tick — the gizmo follows to the end', async () => {
    useGuidesStore.getState().setCamera3dMode('front');
    await mount();
    const before = shown!.view;

    // One wheel tick's worth of dolly: the easer applies it over the following
    // animation frames (an axis view's dolly IS the viewport zoom). No wheel or
    // pointer event reaches the window during the glide.
    act(() => smoothDollyNavBy(-400, 1920, 1080, () => ({ kind: 'ortho', view: 'front' })));

    // Until the camera has held still for a few frames: the glide is over.
    let last = '';
    let still = 0;
    for (let i = 0; i < 240 && still < 4; i++) {
      await act(async () => { await nextFrame(); });
      const now = JSON.stringify(c.getView());
      still = now === last ? still + 1 : 0;
      last = now;
    }
    expect(still).toBeGreaterThanOrEqual(4);

    expect(c.getView().scale).toBeGreaterThan(before.scale * 1.5);
    expect(shown!.view).toEqual(c.getView());
  });
});

describe('main viewport, engine frames: the overlay is drawn with the view of the frame ON SCREEN', () => {
  it('follows the frames, not the page camera running ahead of them', async () => {
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    await mount();

    // A frame drawn at 19 % lands.
    const a: OverlayFrameView = { render: { scale: 0.19, offsetX: 100, offsetY: 60 }, view: 'active', customView: null };
    act(() => publishFrameView(MAIN_VIEWPORT, a));
    expect(shown!.view).toEqual(a.render);

    // The page camera moves on — the picture has not been redrawn yet, so the
    // gizmo must stay over the picture it is drawn on.
    act(() => {
      c.restoreFraming({ center: { x: 300, y: 200 }, zoom: 0.5 });
      c.flushRender();
    });
    expect(shown!.view).toEqual(a.render);

    // The frame drawn with the new view lands: the gizmo moves with the picture.
    const b: OverlayFrameView = { render: c.getView(), view: 'active', customView: null };
    act(() => publishFrameView(MAIN_VIEWPORT, b));
    expect(shown!.view).toEqual(b.render);

    // The engine stops drawing this viewport: the live view is what is displayed.
    act(() => {
      c.restoreFraming({ center: { x: 800, y: 450 }, zoom: 0.75 });
      c.flushRender();
    });
    expect(shown!.view).toEqual(b.render);
    act(() => setEngineDrivenViewport(MAIN_VIEWPORT, false));
    expect(shown!.view).toEqual(c.getView());
  });

  it('the layer-attached overlays’ comp ↔ screen mapping follows the frames too (it used to follow nothing)', async () => {
    // Effect / gradient handles, track points, roto strokes, the liquify brush
    // (which re-rendered on no camera change at all) and the puppet pins and
    // bones (which followed the live camera ahead of the picture) map through this.
    let cam: Camera2DLike | null = null;
    function LayerOverlay(): null {
      cam = useDisplayedCamera2D();
      return null;
    }
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    render(<LayerOverlay />);
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });

    const a: OverlayFrameView = { render: { scale: 0.19, offsetX: 100, offsetY: 60 }, view: 'front', customView: null };
    act(() => publishFrameView(MAIN_VIEWPORT, a));
    expect(cam!.worldToScreen({ x: 1000, y: 500 })).toEqual({ x: 1000 * 0.19 + 100, y: 500 * 0.19 + 60 });
    // The bone overlay sizes its handles by the zoom: the frame's, too.
    expect((cam as unknown as { zoom: number }).zoom).toBe(0.19);

    // A framing restored by a key, then its frame: no pointer event anywhere.
    act(() => {
      c.restoreFraming({ center: { x: 2900, y: 540 }, zoom: 0.5 });
      c.flushRender();
    });
    const b: OverlayFrameView = { render: c.getView(), view: 'front', customView: null };
    act(() => publishFrameView(MAIN_VIEWPORT, b));
    const v = c.getView();
    expect(cam!.worldToScreen({ x: 1000, y: 500 })).toEqual({ x: 1000 * v.scale + v.offsetX, y: 500 * v.scale + v.offsetY });
    const back = cam!.screenToWorld(cam!.worldToScreen({ x: 1000, y: 500 }));
    expect(back.x).toBeCloseTo(1000, 9);
    expect(back.y).toBeCloseTo(500, 9);
  });

  it('a custom view projects through the orbit its frame was drawn with, not the stored one ahead of it', async () => {
    setEngineDrivenViewport(MAIN_VIEWPORT, true);
    useGuidesStore.getState().setCamera3dMode('custom1');
    await mount();

    const drawn: CustomViewParams = { yaw: 20, pitch: -10, distance: 2600, poi: { x: 500, y: 400, z: 0 } };
    act(() => publishFrameView(MAIN_VIEWPORT, { render: c.getView(), view: 'custom', customView: drawn }));
    expect(shown!.camera).toEqual(customViewCamera(drawn, 1920, 1080));

    // An orbit step writes the stored params; the engine has not drawn it yet.
    act(() => useGuidesStore.getState().updateCustomView('custom1', { yaw: 75 }));
    expect(shown!.camera).toEqual(customViewCamera(drawn, 1920, 1080));

    // Its frame lands.
    const next: CustomViewParams = { ...drawn, yaw: 75 };
    act(() => publishFrameView(MAIN_VIEWPORT, { render: c.getView(), view: 'custom', customView: next }));
    expect(shown!.camera).toEqual(customViewCamera(next, 1920, 1080));
  });
});
