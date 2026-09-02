/**
 * Smart guides as the OVERLAY sees them — the wiring between the pure measuring
 * in `snap/smartGuides.ts` and what a host is handed to draw.
 *
 * Three things can only be tested here:
 *
 *  1. **The gate.** An idle viewport must report nothing at all. Chrome that
 *     stays up between gestures is the difference between a measuring tool and
 *     a noisy one, and nothing in the pure layer knows what a gesture is.
 *  2. **The units.** Geometry comes out in SCREEN pixels (the host draws it
 *     without projecting) while the labels stay in COMPOSITION pixels (a
 *     measurement that changed with zoom would be useless). At 2× zoom those
 *     two disagree by construction, which is what pins them apart.
 *  3. **Alt-hover.** Measuring against the hovered layer with no drag in
 *     flight — a mode the tools never enter, so no tool test can reach it.
 */

import { Workspace } from '../Workspace';
import { MemoryScene, MemorySelection } from '../adapters/memory';
import { NO_MODIFIERS } from '../input/events';
import type { PointerInput } from '../input/events';
import * as R from '../math/Rect';

function pointer(x: number, y: number, down = false): PointerInput {
  return {
    position: { x, y },
    pointerType: 'mouse',
    button: 'left',
    buttons: { left: down, middle: false, right: false },
    modifiers: NO_MODIFIERS,
    pressure: 0.5,
    time: 0,
    pointerId: 1,
  };
}

/**
 * Three 40-wide boxes in a row at y 0..40: A at 0..40, the dragged box at
 * 100..140, C at 200..240. The gaps are 60 and 60 — already equal, so the
 * measurements are exact numbers rather than snap-adjusted ones.
 */
function ws(): Workspace {
  const w = new Workspace({
    scene: new MemoryScene([
      { id: 'a', bounds: R.rect(0, 0, 40, 40) },
      { id: 'box', bounds: R.rect(100, 0, 40, 40) },
      { id: 'c', bounds: R.rect(200, 0, 40, 40) },
    ]),
    selection: new MemorySelection(),
    viewport: { width: 800, height: 600, dpr: 1 },
  });
  w.initialize();
  w.setSnap({ toGrid: false, toGuides: false });
  w.select('box');
  return w;
}

/**
 * Press ON the selected box and move far enough to cross the drag threshold.
 *
 * On the box deliberately: a press on empty canvas starts a MARQUEE, which is a
 * drag that positions nothing and is suppressed — see the marquee test below.
 */
function beginDrag(w: Workspace): void {
  const grab = w.worldToScreen({ x: 120, y: 20 });
  w.feedPointerDown(pointer(grab.x, grab.y, true));
  w.feedPointerMove(pointer(grab.x + 30, grab.y, true));
}

describe('WorkspaceOverlay.smartGuides', () => {
  it('is null while nothing is happening', () => {
    expect(ws().overlay().smartGuides).toBeNull();
  });

  it('measures the neighbours on both sides once a drag is in flight', () => {
    const w = ws();
    beginDrag(w);
    const sg = w.overlay().smartGuides;
    expect(sg).not.toBeNull();
    expect(sg?.measuring).toBe(false);
    const labels = (sg?.spans ?? []).filter((s) => s.axis === 'x').map((s) => s.label);
    // A is 60 to the left, C is 60 to the right — and because those gaps are
    // already equal, the run is reported as equal spacing too.
    expect(labels).toContain('60');
    expect(sg?.spans.some((s) => s.equal)).toBe(true);
  });

  it('reports geometry in screen px and labels in composition px', () => {
    const w = ws();
    w.setZoom(2);
    beginDrag(w);
    const span = (w.overlay().smartGuides?.spans ?? []).find((s) => s.axis === 'x');
    expect(span).toBeDefined();
    // 60 comp px of gap is 120 screen px wide at 2× — but it is still "60".
    expect(Math.abs((span?.to ?? 0) - (span?.from ?? 0))).toBeCloseTo(120);
    expect(span?.label).toBe('60');
  });

  it('names the neighbours whose size matches', () => {
    const w = ws();
    beginDrag(w);
    // Both A and C are 40 × 40, exactly like the dragged box.
    expect((w.overlay().smartGuides?.sizeMatches ?? []).length).toBeGreaterThan(0);
  });

  it('goes quiet again when the drag ends', () => {
    const w = ws();
    beginDrag(w);
    expect(w.overlay().smartGuides).not.toBeNull();
    w.feedPointerUp(pointer(430, 300));
    expect(w.overlay().smartGuides).toBeNull();
  });

  it('says nothing at all when the preference is off', () => {
    const w = ws();
    w.setSnap({ smartGuides: false });
    beginDrag(w);
    expect(w.overlay().smartGuides).toBeNull();
  });

  it('measures to the hovered layer on Alt-hover, with no drag', () => {
    const w = ws();
    // Hover C by moving the pointer over it — screen == world here (zoom 1,
    // camera centred on the viewport), so hover is resolved by position.
    w.zoomToFit(R.rect(0, 0, 240, 40), 0);
    const screen = w.worldToScreen({ x: 220, y: 20 });
    w.feedPointerMove(pointer(screen.x, screen.y));
    expect(w.overlay().smartGuides).toBeNull(); // hovering is not measuring
    w.setMeasureHover(true);
    const sg = w.overlay().smartGuides;
    expect(sg?.measuring).toBe(true);
    // box 100..140, C 200..240 → 60 apart, and nothing else is measured.
    expect(sg?.spans.map((s) => s.label)).toEqual(['60']);
    expect(sg?.sizeMatches).toEqual([]);
  });

  it('stays quiet during a marquee, which positions nothing', () => {
    const w = ws();
    // Empty canvas, far from every box.
    w.feedPointerDown(pointer(700, 500, true));
    w.feedPointerMove(pointer(730, 520, true));
    expect(w.overlay().marquee).not.toBeNull();
    expect(w.overlay().smartGuides).toBeNull();
  });

  it('measures nothing when the hovered layer IS the selection', () => {
    const w = ws();
    w.zoomToFit(R.rect(0, 0, 240, 40), 0);
    const screen = w.worldToScreen({ x: 120, y: 20 });
    w.feedPointerMove(pointer(screen.x, screen.y));
    w.setMeasureHover(true);
    expect(w.overlay().smartGuides).toBeNull();
  });
});
