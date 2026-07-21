/**
 * Reported bug: "when we change size of scene body it is not changing correctly
 * like Instagram size or other size except YouTube and bigger size".
 *
 * Root cause: fit-to-composition was a ONE-SHOT at mount. `Camera.zoomToRect`
 * sets the zoom AND the world centre, so a camera framed for 1920×1080 sits at
 * world (960, 540). Switch to a 1080×1920 Instagram comp — whose centre is
 * (540, 960) — and the view stays pointed near the new comp's right edge at a
 * zoom that fits a 1080-tall frame: off-centre and cropped.
 *
 * These lock the camera arithmetic that makes a re-fit correct. The React
 * effect that CALLS it lives in useWorkspace.
 */

import { Camera } from '@motion/workspace';

const PANE = { width: 1200, height: 700 };
const PAD = 32; // zoomToRect's default padding

function makeCamera(): Camera {
  const cam = new Camera();
  cam.setViewportSize(PANE.width, PANE.height);
  return cam;
}

/** Fit a comp the way WorkspaceController.fitComposition does. */
function fit(cam: Camera, w: number, h: number): void {
  cam.zoomToRect({ x: 0, y: 0, width: w, height: h });
}

describe('fitting a composition', () => {
  it('centres the camera on the comp, whatever its shape', () => {
    const cam = makeCamera();
    fit(cam, 1920, 1080);
    expect(cam.center.x).toBeCloseTo(960);
    expect(cam.center.y).toBeCloseTo(540);

    // Instagram portrait: the centre must MOVE. Without a re-fit the camera
    // stays at (960, 540) — near this comp's right edge, a third of the way
    // down — which is exactly what the user saw.
    fit(cam, 1080, 1920);
    expect(cam.center.x).toBeCloseTo(540);
    expect(cam.center.y).toBeCloseTo(960);
  });

  it('centres on a square comp', () => {
    const cam = makeCamera();
    fit(cam, 1920, 1080);
    fit(cam, 1080, 1080);
    expect(cam.center.x).toBeCloseTo(540);
    expect(cam.center.y).toBeCloseTo(540);
  });

  it('zooms so a portrait comp fits the pane height', () => {
    // The stale-zoom half: a camera fitted to a 1080-tall comp shows a
    // 1920-tall one at ~2x, overflowing the pane.
    const cam = makeCamera();
    fit(cam, 1920, 1080);
    const landscapeZoom = cam.zoom;

    fit(cam, 1080, 1920);
    expect(cam.zoom).toBeLessThan(landscapeZoom);
    // The whole comp must fit inside the pane on both axes.
    expect(1080 * cam.zoom).toBeLessThanOrEqual(PANE.width - PAD * 2 + 0.01);
    expect(1920 * cam.zoom).toBeLessThanOrEqual(PANE.height - PAD * 2 + 0.01);
  });

  it('fits a comp LARGER than the pane too', () => {
    // 4K only "looked fine" because it floods the pane edge-to-edge, so the
    // stale framing had no visible boundary — it was equally wrong.
    const cam = makeCamera();
    fit(cam, 3840, 2160);
    expect(cam.center.x).toBeCloseTo(1920);
    expect(cam.center.y).toBeCloseTo(1080);
    expect(3840 * cam.zoom).toBeLessThanOrEqual(PANE.width - PAD * 2 + 0.01);
  });

  it('is idempotent — re-fitting the same comp does not drift', () => {
    const cam = makeCamera();
    fit(cam, 1080, 1920);
    const { x: centerX, y: centerY } = cam.center;
    const zoomLevel = cam.zoom;
    fit(cam, 1080, 1920);
    expect(cam.center.x).toBeCloseTo(centerX);
    expect(cam.center.y).toBeCloseTo(centerY);
    expect(cam.zoom).toBeCloseTo(zoomLevel);
  });
});
