/**
 * Grid snapping, to After Effects' rules.
 *
 * Two of those rules are counter-intuitive enough that they are the whole point
 * of this file:
 *
 *  1. **Snap to Grid is independent of Show Grid.** AE snaps to the grid while
 *     it is hidden; "turn off snap when the grid is hidden" is a long-standing
 *     feature request Adobe has not granted. An earlier revision here gated
 *     snapping on visibility, which felt tidier and was the wrong product.
 *  2. **Snapping uses the spacing that is DRAWN**, not an adaptive one. The
 *     engine's adaptive stepper keeps a reference grid legible while zooming,
 *     but a host drawing fixed "Gridline every N pixels" cells needs snapping to
 *     land on those lines at every zoom.
 */

import { Workspace } from '../Workspace';
import { MemoryScene, MemorySelection } from '../adapters/memory';
import * as R from '../math/Rect';

function ws(): Workspace {
  const w = new Workspace({
    // Parked far from the tested coordinates ON PURPOSE. Object snapping is on
    // by default, so a node whose edge sits at x=100 would pull the rect to the
    // same place the grid would and every assertion here would pass for the
    // wrong reason — which it did, until this moved.
    scene: new MemoryScene([{ id: 'a', bounds: R.rect(-9000, -9000, 100, 100) }]),
    selection: new MemorySelection(),
    viewport: { width: 800, height: 600, dpr: 1 },
  });
  w.initialize();
  return w;
}

describe('Snap to Grid — AE semantics', () => {
  // 2 units from the gridline at zoom 1, inside the default threshold.
  const NEAR = R.rect(102, 0, 50, 50);

  it('snaps while the grid is HIDDEN', () => {
    const w = ws();
    w.setSnap({ enabled: true, toGrid: true });
    w.setGrid({ visible: false, snapSpacing: 100 });
    expect(w.snapRect(NEAR).value.x).toBe(100);
  });

  it('does NOT snap when Snap to Grid is off, even with the grid shown', () => {
    const w = ws();
    w.setSnap({ enabled: true, toGrid: false });
    w.setGrid({ visible: true, snapSpacing: 100 });
    expect(w.snapRect(NEAR).value.x).toBe(102);
  });

  it('visibility alone changes nothing — the two are independent', () => {
    const w = ws();
    w.setSnap({ enabled: true, toGrid: true });
    w.setGrid({ snapSpacing: 100, visible: true });
    const shown = w.snapRect(NEAR).value.x;
    w.setGrid({ visible: false });
    const hidden = w.snapRect(NEAR).value.x;
    // Both must SNAP — asserting only equality would pass vacuously if neither did.
    expect(shown).toBe(100);
    expect(hidden).toBe(shown);
  });
});

describe('Snap spacing follows the drawn grid, not the zoom', () => {
  it('uses the host-declared spacing at any zoom', () => {
    const w = ws();
    w.setSnap({ enabled: true, toGrid: true });
    w.setGrid({ snapSpacing: 100 });
    for (const zoom of [0.1, 0.25, 1, 4]) {
      w.setZoom(zoom);
      // Offset by a fixed SCREEN distance, not a world one: the snap threshold
      // is in screen pixels, so a constant world offset drifts outside it as you
      // zoom in and the rect legitimately stops snapping.
      const nudge = 1.5 / zoom;
      // Every zoom must agree on the same gridline, because the drawn lines do.
      expect(w.snapRect(R.rect(100 + nudge, 0, 20, 20)).value.x).toBe(100);
    }
  });

  it('falls back to the adaptive stepper when no spacing is declared', () => {
    const w = ws();
    w.setGrid({ snapSpacing: null });
    w.setZoom(1);
    // Not asserting a specific number — only that the fallback is the adaptive
    // path, which is what a host drawing an adaptive grid still wants.
    expect(w.grid.snapSpacing(1)).toBe(w.grid.adaptiveSpacing(1));
  });

  it('a declared spacing overrides the adaptive one', () => {
    const w = ws();
    w.setGrid({ snapSpacing: 100 });
    expect(w.grid.snapSpacing(1)).toBe(100);
    expect(w.grid.snapSpacing(0.1)).toBe(100);
  });

  it('ignores a nonsense spacing rather than snapping everything to zero', () => {
    const w = ws();
    w.setGrid({ snapSpacing: 0 });
    expect(w.grid.snapSpacing(1)).toBe(w.grid.adaptiveSpacing(1));
  });
});
