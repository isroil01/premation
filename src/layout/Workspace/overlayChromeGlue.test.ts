/**
 * The viewport's 2D chrome — the selection outline and its handles — is drawn
 * ON THE PICTURE, not at the live camera.
 *
 * The workspace builds its chrome in the live camera's screen px; the picture
 * under it is the engine's frame, drawn with the view it was asked for a frame
 * or more earlier. During a pan or zoom the outline used to run ahead of the
 * layer it outlines. `paintOverlay` now draws it through `glue`
 * (displayedView.ts `mainPictureGlue`: live px → the frame on screen's px),
 * while chrome at the POINTER (the marquee) stays where the pointer is.
 *
 * Painted on jsdom's Skia-backed canvas (jest.setup.ts) and read back.
 */

import type { WorkspaceOverlay } from '@motion/workspace';
import { pictureGlue } from '@core/workspace/displayedView';
import { paintOverlay } from './useWorkspace';

const W = 240;
const H = 180;

/** One selected layer's outline at x 20…60, y 20…60 in live-camera px. */
function overlayWith(extra: Partial<WorkspaceOverlay> = {}): WorkspaceOverlay {
  return {
    selectionBounds: null,
    selectionBoxes: [{ id: 'L1', corners: [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }] }],
    handles: [],
    marquee: null,
    snapLines: [],
    guides: [],
    hoveredBounds: null,
    hoveredCorners: null,
    ...extra,
  } as WorkspaceOverlay;
}

function paint(overlay: WorkspaceOverlay, glue: ReturnType<typeof pictureGlue>): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  paintOverlay(canvas, overlay, 1, null, undefined, null, 0, null, 'paint', null, glue);
  return canvas;
}

/** Whether anything was painted in the 3×3 px around (x, y). */
function inkAt(canvas: HTMLCanvasElement, x: number, y: number): boolean {
  const data = canvas.getContext('2d')!.getImageData(Math.round(x) - 1, Math.round(y) - 1, 3, 3).data;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) return true;
  return false;
}

describe('the selection outline is drawn on the picture', () => {
  it('without a glue (the picture is drawn with the live view): where the workspace put it', () => {
    const c = paint(overlayWith(), null);
    expect(inkAt(c, 20, 40)).toBe(true);
    expect(inkAt(c, 120, 90)).toBe(false);
  });

  it('with the frame on screen still at the previous framing: where THAT frame shows the layer', () => {
    // The live camera has panned 100 px left and 50 px up of the frame on screen.
    const live = { scale: 1, offsetX: 0, offsetY: 0 };
    const shown = { scale: 1, offsetX: 100, offsetY: 50 };
    const c = paint(overlayWith(), pictureGlue(live, shown));
    expect(inkAt(c, 120, 90)).toBe(true);   // the left edge, glued to the picture
    expect(inkAt(c, 160, 90)).toBe(true);   // the right edge
    expect(inkAt(c, 20, 40)).toBe(false);   // not where the live camera has already moved it
  });

  it('a zoom the frame has not caught up with scales it onto the picture', () => {
    const live = { scale: 2, offsetX: 0, offsetY: 0 };
    const shown = { scale: 1, offsetX: 0, offsetY: 0 };
    const c = paint(overlayWith(), pictureGlue(live, shown));
    // Live px 20…60 are comp 10…30, which the frame on screen draws at 10…30.
    expect(inkAt(c, 10, 20)).toBe(true);
    expect(inkAt(c, 30, 20)).toBe(true);
    expect(inkAt(c, 60, 40)).toBe(false);
  });

  it('chrome at the POINTER stays at the pointer: the marquee is not moved', () => {
    const glue = pictureGlue({ scale: 1, offsetX: 0, offsetY: 0 }, { scale: 1, offsetX: 100, offsetY: 50 });
    const c = paint(overlayWith({ selectionBoxes: [], marquee: { x: 20, y: 20, width: 40, height: 40 } }), glue);
    expect(inkAt(c, 20, 40)).toBe(true);
    expect(inkAt(c, 120, 90)).toBe(false);
  });
});
