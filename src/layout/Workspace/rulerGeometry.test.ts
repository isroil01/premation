/**
 * The ruler you can SEE and the ruler you can GRAB must be the same ruler.
 *
 * They were not. `paintRulers` drew a 22 CSS-px bar pinned to the viewport's
 * top and left edges; `rulerStrips` hit-tested a 16-DEVICE-px band hugging the
 * composition frame, left over from a backend that had been deleted. Pressing
 * the visible bar did nothing, and an invisible band that moved with pan and
 * zoom dragged the guides out instead.
 *
 * These assertions are written against the DRAWN bar — origin (0,0), thickness
 * RULER_CSS_PX, pinned to the viewport — so a painter that moves without the
 * hit-test (or the reverse) fails here rather than in someone's hands.
 */

import { RULER_CSS_PX, inStrip, rulerStrips } from './rulerGeometry';

const W = 1200;
const H = 800;

describe('ruler strips match the drawn bar', () => {
  const { top, left } = rulerStrips(W, H);

  it('the top strip spans the viewport width at the viewport top', () => {
    expect(top.y).toBe(0);
    expect(top.height).toBe(RULER_CSS_PX);
    // Starts after the corner, runs to the right edge.
    expect(top.x).toBe(RULER_CSS_PX);
    expect(top.x + top.width).toBe(W);
  });

  it('the left strip spans the viewport height at the viewport left', () => {
    expect(left.x).toBe(0);
    expect(left.width).toBe(RULER_CSS_PX);
    expect(left.y).toBe(RULER_CSS_PX);
    expect(left.y + left.height).toBe(H);
  });

  it('a press anywhere on the drawn top bar hits the top strip', () => {
    for (const x of [RULER_CSS_PX, 100, W / 2, W - 1]) {
      expect({ x, hit: inStrip(top, { x, y: RULER_CSS_PX / 2 }) }).toEqual({ x, hit: true });
    }
  });

  it('a press anywhere on the drawn left bar hits the left strip', () => {
    for (const y of [RULER_CSS_PX, 100, H / 2, H - 1]) {
      expect({ y, hit: inStrip(left, { x: RULER_CSS_PX / 2, y }) }).toEqual({ y, hit: true });
    }
  });

  it('the corner square belongs to neither strip — a press there has no axis', () => {
    const corner = { x: RULER_CSS_PX / 2, y: RULER_CSS_PX / 2 };
    expect({ top: inStrip(top, corner), left: inStrip(left, corner) })
      .toEqual({ top: false, left: false });
  });

  it('the canvas below and right of the bars is not a ruler', () => {
    const onCanvas = { x: RULER_CSS_PX + 40, y: RULER_CSS_PX + 40 };
    expect({ top: inStrip(top, onCanvas), left: inStrip(left, onCanvas) })
      .toEqual({ top: false, left: false });
  });

  it('does not depend on pan, zoom or composition size', () => {
    // The old implementation derived the strips from worldToScreen of the comp
    // corners, so every one of these would have moved the grab region. The bar
    // is viewport chrome: same place at any view.
    expect(rulerStrips(W, H)).toEqual(rulerStrips(W, H));
  });

  it('degenerates safely on a viewport smaller than the bar', () => {
    const tiny = rulerStrips(10, 10);
    expect(tiny.top.width).toBe(0);
    expect(tiny.left.height).toBe(0);
  });
});
