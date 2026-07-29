/**
 * Gallery cards must cost nothing until they are on screen.
 *
 * Opening the Library tab mounts every preset at once (24 mograph presets, 20
 * transitions, …) while only about six fit in the panel. `mountPreview` used to
 * build each card's isolated SceneGraph, AnimationEngine and choreography
 * eagerly — plus a duplicate `animate` replay just to measure the duration — so
 * the tab switch paid for all of them up front. Measured in the app: 17.2 ms of
 * pure construction for the mograph section, before a single pixel.
 *
 * Two invariants keep that off the navigation path:
 *   1. `mountPreview` performs NO build — `spec.build`/`animate`/`decorate` are
 *      untouched until the card renders.
 *   2. A newly mounted card starts PAUSED when an IntersectionObserver exists,
 *      so the first tick after a tab switch does not render the whole gallery
 *      before the observer's async callback has corrected visibility.
 */

import { mountPreview } from './previewController';

/** Minimal canvas stub — the controller only needs sizes and a 2D context.
 *  `rect` controls what getBoundingClientRect reports, so a card can be placed
 *  on screen, below the fold, or given no box at all (a hidden panel). */
function makeCanvas(w = 224, h = 126, rect?: Partial<DOMRect>): HTMLCanvasElement {
  const ctx = {
    canvas: null as unknown,
    setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {},
    ellipse() {}, rect() {}, fill() {}, stroke() {}, clip() {}, translate() {},
    scale() {}, rotate() {}, drawImage() {}, measureText: () => ({ width: 10 }),
    fillText() {}, createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }), setLineDash() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {},
  };
  const box = { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, ...rect };
  const canvas = {
    width: w, height: h, clientWidth: w, clientHeight: h,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
    getBoundingClientRect: () => box,
    /** Test-only: simulate the panel becoming visible after mount. */
    __show(): void {
      Object.assign(box, { top: 0, left: 0, right: w, bottom: h, width: w, height: h });
    },
  };
  ctx.canvas = canvas;
  return canvas as unknown as HTMLCanvasElement;
}

describe('mountPreview defers the expensive half', () => {
  it('does not build the scene, choreography or decoration on mount', () => {
    const calls = { build: 0, animate: 0, decorate: 0 };
    const handle = mountPreview(makeCanvas(), {
      build: () => { calls.build++; },
      animate: () => { calls.animate++; },
      decorate: () => { calls.decorate++; },
      width: 224,
      height: 126,
    });

    expect(calls).toEqual({ build: 0, animate: 0, decorate: 0 });
    handle.stop();
  });

  it('stop() before first paint never builds anything', () => {
    let built = 0;
    // Scrolling a long gallery past a card, or switching tabs quickly, mounts
    // and unmounts without ever showing it. That must be free.
    const handle = mountPreview(makeCanvas(), {
      build: () => { built++; },
      width: 224,
      height: 126,
    });
    handle.stop();
    expect(built).toBe(0);
  });

  it('builds exactly once on the first rendered frame, then never again', async () => {
    // jsdom has no IntersectionObserver, so the card mounts visible and the
    // shared loop paints it — the same path a scrolled-into-view card takes.
    const calls = { build: 0, animate: 0, decorate: 0 };
    const handle = mountPreview(makeCanvas(), {
      build: () => { calls.build++; },
      animate: () => { calls.animate++; },
      decorate: () => { calls.decorate++; },
      width: 224,
      height: 126,
    });

    // Let the shared ticker run several frames.
    await new Promise((r) => setTimeout(r, 150));

    expect(calls.build).toBe(1);
    expect(calls.decorate).toBe(1);
    // `animate` runs twice by design: once to write keyframes, once inside
    // choreographyDuration to measure the span. The point is it does not grow
    // with frame count.
    expect(calls.animate).toBeLessThanOrEqual(2);
    handle.stop();

    const afterStop = { ...calls };
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual(afterStop);
  });

  it('an on-screen card paints WITHOUT waiting for an observer callback', async () => {
    // The freeze: gating the first frame on IntersectionObserver means a card
    // whose callback is late — or never fires — shows only its static poster
    // forever. Visibility is seeded from geometry instead, so this must paint
    // even though no observer callback is ever delivered here.
    let built = 0;
    const handle = mountPreview(makeCanvas(), {
      build: () => { built++; },
      width: 224,
      height: 126,
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(built).toBe(1);
    handle.stop();
  });

  it('a card with no box at mount revives once it gets one', async () => {
    // Mounted inside a collapsed/hidden panel: zero-size rect, so it correctly
    // starts paused. When the panel opens it must start on its own — the
    // observer may never report a change it already considers settled.
    let built = 0;
    const canvas = makeCanvas(224, 126, { width: 0, height: 0, right: 0, bottom: 0 });
    const handle = mountPreview(canvas, {
      build: () => { built++; },
      width: 224,
      height: 126,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(built).toBe(0); // still hidden — correctly paused, not built

    (canvas as unknown as { __show(): void }).__show();
    // Generously > REVIVE_INTERVAL_MS: the shared rAF loop can be starved when
    // the whole suite runs in parallel, and a timing-tight wait flakes there.
    await new Promise((r) => setTimeout(r, 1200));
    expect(built).toBe(1); // revived without any observer help
    handle.stop();
  });

  it('mounting a whole gallery stays proportional to card COUNT, not content', () => {
    // 200 cards whose build/animate would be costly if they ran. If mount were
    // still eager this test would execute all 200 recipes.
    let recipeRuns = 0;
    const handles = Array.from({ length: 200 }, () =>
      mountPreview(makeCanvas(), {
        build: () => { recipeRuns++; },
        animate: () => { recipeRuns++; },
        width: 224,
        height: 126,
      }),
    );
    expect(recipeRuns).toBe(0);
    for (const h of handles) h.stop();
  });
});
