/**
 * A menu panel must land inside the window.
 *
 * WHY THIS EXISTS. `AppMenuButton` anchored its panel right-aligned to the
 * trigger — fine for a kebab at the right edge of a bar, and fatal at the left
 * edge, which is where TopNav mounts it. Measured in the running app:
 * `left: -186px` for a trigger at x≈6. The whole application menu was off the
 * left of the window, so in the web build File ▸ New Project / Save / Save As
 * had no reachable route at all, while every unit test passed — nothing
 * asserted on where the thing rendered.
 */

import { anchorMenuTo } from './menuAnchor';

/** Just the fields anchorMenuTo reads. */
function rect(left: number, width: number, bottom = 33): DOMRect {
  return { left, right: left + width, bottom } as DOMRect;
}

describe('anchorMenuTo', () => {
  it('opens a left-edge trigger to the RIGHT of it, on screen', () => {
    // The regression, with the real numbers: the TopNav menu button, which
    // used to produce left: -186. Aligned to the trigger, held off the very
    // edge by the 8px gap.
    const a = anchorMenuTo(rect(6, 28), 902);
    expect(a.left).toBeGreaterThanOrEqual(0);
    expect(a.left).toBeLessThan(30);
  });

  it('flips a right-edge trigger so the panel stays inside the window', () => {
    const a = anchorMenuTo(rect(860, 28), 902);
    expect(a.left + 220).toBeLessThanOrEqual(902);
  });

  it('never places the panel off either edge, wherever the trigger is', () => {
    for (const vw of [320, 640, 902, 1920]) {
      for (let x = 0; x <= vw - 20; x += 17) {
        const a = anchorMenuTo(rect(x, 20), vw);
        expect(a.left).toBeGreaterThanOrEqual(0);
        // On a viewport narrower than the panel the left edge wins — showing
        // the start of the menu beats centring it off both sides.
        if (vw >= 236) expect(a.left + 220).toBeLessThanOrEqual(vw);
      }
    }
  });

  it('drops below the trigger', () => {
    expect(anchorMenuTo(rect(100, 28, 40), 902).top).toBeGreaterThan(40);
  });
});
