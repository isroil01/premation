/**
 * Gallery cards must cost nothing until they are on screen — and then ask the
 * engine for exactly what they show.
 *
 * Opening the Library tab mounts every preset at once (30 mograph presets, 25
 * transitions, …) while only about six fit in the panel. `mountPreview` used to
 * build each card's isolated SceneGraph, AnimationEngine and choreography
 * eagerly, so the tab switch paid for all of them up front.
 *
 * The invariants that keep that off the navigation path, and off the engine:
 *   1. `mountPreview` performs NO build — `spec.build`/`animate`/`decorate` are
 *      untouched until the card is painted.
 *   2. A card that is not on screen builds nothing and asks the engine for
 *      nothing.
 *   3. A visible card asks for ONE still (its poster); flipbook frames are only
 *      asked while the card is hovered or focused.
 *
 * The pictures themselves are the engine's (`renderDocumentStill`), pinned on
 * the real binary in core/engine/__tests__/previewDocumentNative.test.ts; here
 * the still is a stub.
 */

import { mountPreview, buildPreviewScene } from './previewController';
import { addRoot, addShape } from './templates/builders';

const stills: Array<{ seconds: number; maxSize: number; priority?: string }> = [];
jest.mock('@core/engine/previewDocument', () => {
  const actual = jest.requireActual('@core/engine/previewDocument') as Record<string, unknown>;
  return {
    ...actual,
    previewStill: (_doc: unknown, seconds: number, maxSize: number, opts?: { priority?: string; wanted?: () => boolean }) => {
      if (opts?.wanted && !opts.wanted()) return Promise.resolve(null);
      stills.push({ seconds, maxSize, priority: opts?.priority });
      return Promise.resolve(new Blob(['png']));
    },
  };
});

/** Every bitmap the stubbed decoder made, so a test can see what was closed. */
const bitmaps: Array<{ width: number; height: number; closed: boolean; close(): void }> = [];
beforeAll(() => {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = () => {
    const b = { width: 320, height: 180, closed: false, close() { this.closed = true; } };
    bitmaps.push(b);
    return Promise.resolve(b);
  };
});
afterAll(() => {
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
});
beforeEach(() => {
  stills.length = 0;
  bitmaps.length = 0;
});

type Listener = () => void;

/** Minimal canvas stub — the controller needs sizes, a 2D context and (for
 *  hover) listeners. `rect` controls what getBoundingClientRect reports, so a
 *  card can be placed on screen, below the fold, or given no box at all. */
function makeCanvas(w = 224, h = 126, rect?: Partial<DOMRect>) {
  const draws: unknown[] = [];
  const ctx = {
    canvas: null as unknown,
    fillStyle: '',
    clearRect() {}, fillRect() {},
    drawImage(image: unknown) { draws.push(image); },
  };
  const box = { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, ...rect };
  const listeners = new Map<string, Set<Listener>>();
  const canvas = {
    width: w, height: h, clientWidth: w, clientHeight: h,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
    getBoundingClientRect: () => box,
    closest: () => null,
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) { listeners.get(type)?.delete(fn); },
    /** Test-only: fire a pointer / focus event on the card. */
    __fire(type: string): void { for (const fn of [...(listeners.get(type) ?? [])]) fn(); },
    __listeners: (): number => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    /** Test-only: simulate the panel becoming visible after mount. */
    __show(): void {
      Object.assign(box, { top: 0, left: 0, right: w, bottom: h, width: w, height: h });
    },
    __draws: draws,
  };
  ctx.canvas = canvas;
  return canvas;
}
type StubCanvas = ReturnType<typeof makeCanvas>;
const asCanvas = (c: StubCanvas): HTMLCanvasElement => c as unknown as HTMLCanvasElement;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A one-second move: a square sliding across a 320 × 180 comp. */
const sliding = {
  build: (g: Parameters<typeof addRoot>[0]) => {
    addRoot(g, 'tpl_root', 'Slide');
    addShape(g, 'box', 'tpl_root', 40, 90, 40, 40, '#ff0000');
  },
  animate: (set: (id: string, prop: string, t: number, v: number) => void) => {
    set('box', 'x', 0, 40);
    set('box', 'x', 1, 280);
  },
  width: 320,
  height: 180,
};

describe('mountPreview defers the expensive half', () => {
  it('does not build the scene, choreography or decoration on mount', () => {
    const calls = { build: 0, animate: 0, decorate: 0 };
    const handle = mountPreview(asCanvas(makeCanvas()), {
      build: () => { calls.build++; },
      animate: () => { calls.animate++; },
      decorate: () => { calls.decorate++; },
      width: 224,
      height: 126,
    });

    expect(calls).toEqual({ build: 0, animate: 0, decorate: 0 });
    expect(stills).toEqual([]);
    handle.stop();
  });

  it('stop() before first paint never builds anything', () => {
    let built = 0;
    // Scrolling a long gallery past a card, or switching tabs quickly, mounts
    // and unmounts without ever showing it. That must be free.
    const handle = mountPreview(asCanvas(makeCanvas()), {
      build: () => { built++; },
      width: 224,
      height: 126,
    });
    handle.stop();
    expect(built).toBe(0);
  });

  it('builds exactly once on the first painted frame, then never again', async () => {
    // jsdom has no IntersectionObserver, so the card mounts visible and the
    // shared loop paints it — the same path a scrolled-into-view card takes.
    const calls = { build: 0, animate: 0, decorate: 0 };
    const handle = mountPreview(asCanvas(makeCanvas()), {
      build: () => { calls.build++; },
      animate: () => { calls.animate++; },
      decorate: () => { calls.decorate++; },
      width: 224,
      height: 126,
    });

    await wait(150);

    expect(calls.build).toBe(1);
    expect(calls.decorate).toBe(1);
    // `animate` runs three times by design: once to write keyframes, once
    // inside choreographyDuration and once inside choreographyRestTime. The
    // point is it does not grow with frame count.
    expect(calls.animate).toBeLessThanOrEqual(3);
    handle.stop();

    const afterStop = { ...calls };
    await wait(80);
    expect(calls).toEqual(afterStop);
  });

  it('a card with no box at mount revives once it gets one', async () => {
    // Mounted inside a collapsed/hidden panel: zero-size rect, so it correctly
    // starts paused. When the panel opens it must start on its own — the
    // observer may never report a change it already considers settled.
    let built = 0;
    const canvas = makeCanvas(224, 126, { width: 0, height: 0, right: 0, bottom: 0 });
    const handle = mountPreview(asCanvas(canvas), {
      build: () => { built++; },
      width: 224,
      height: 126,
    });
    await wait(100);
    expect(built).toBe(0); // still hidden — correctly paused, not built
    expect(stills).toEqual([]); // and the engine was asked for nothing

    canvas.__show();
    // Generously > the revive interval: timers can be starved when the whole
    // suite runs in parallel, and a timing-tight wait flakes there.
    await wait(1200);
    expect(built).toBe(1); // revived without any observer help
    handle.stop();
  });

  it('mounting a whole gallery stays proportional to card COUNT, not content', () => {
    // 200 cards whose build/animate would be costly if they ran. If mount were
    // still eager this test would execute all 200 recipes.
    let recipeRuns = 0;
    const handles = Array.from({ length: 200 }, () =>
      mountPreview(asCanvas(makeCanvas()), {
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

describe('what a card asks the engine for', () => {
  it('a visible card asks for ONE poster, at the time its choreography shows the most of itself, and draws it', async () => {
    const canvas = makeCanvas();
    const handle = mountPreview(asCanvas(canvas), sliding);
    await wait(150);
    expect(stills).toHaveLength(1);
    expect(stills[0]!.priority).toBe('poster');
    // A plain move is fully visible throughout; ties rest at the LATEST time.
    expect(stills[0]!.seconds).toBeCloseTo(1, 5);
    expect(canvas.__draws).toHaveLength(1);
    expect(canvas.__draws[0]).toBe(bitmaps[0]);
    handle.stop();
  });

  it('the spec\'s own poster time wins', async () => {
    const handle = mountPreview(asCanvas(makeCanvas()), { ...sliding, posterTime: 0.25 });
    await wait(150);
    expect(stills.map((s) => s.seconds)).toEqual([0.25]);
    handle.stop();
  });

  it('asks for flipbook frames only while hovered: the whole choreography, start to end pose, in order', async () => {
    const canvas = makeCanvas();
    const handle = mountPreview(asCanvas(canvas), sliding);
    await wait(150);
    expect(stills).toHaveLength(1); // the poster; no motion was asked for

    canvas.__fire('pointerenter');
    await wait(400);
    const frames = stills.filter((s) => s.priority === 'frame');
    // One second at 20 fps, both ends included.
    expect(frames).toHaveLength(21);
    expect(frames[0]!.seconds).toBe(0);
    expect(frames.at(-1)!.seconds).toBeCloseTo(1, 9);
    expect(frames.map((f) => f.seconds)).toEqual([...frames.map((f) => f.seconds)].sort((a, b) => a - b));
    // And it plays them: more than the poster has been drawn.
    expect(canvas.__draws.length).toBeGreaterThan(1);

    // Hovering again asks for nothing new — the flipbook replays from memory.
    canvas.__fire('pointerleave');
    canvas.__fire('pointerenter');
    await wait(150);
    expect(stills.filter((s) => s.priority === 'frame')).toHaveLength(21);
    handle.stop();
  });

  it('a pointer that only crosses the card (scrolling the list) starts nothing', async () => {
    const canvas = makeCanvas();
    const handle = mountPreview(asCanvas(canvas), sliding);
    await wait(150);
    canvas.__fire('pointerenter');
    await wait(30);
    canvas.__fire('pointerleave');
    await wait(250);
    expect(stills.filter((s) => s.priority === 'frame')).toEqual([]);
    handle.stop();
  });

  it('a static scene has no flipbook — its poster is the whole preview', async () => {
    const canvas = makeCanvas();
    const handle = mountPreview(asCanvas(canvas), { build: sliding.build, width: 320, height: 180 });
    await wait(120);
    canvas.__fire('pointerenter');
    await wait(150);
    expect(stills).toHaveLength(1);
    expect(stills[0]!.seconds).toBe(0);
    handle.stop();
  });

  it('stop() removes the hover listeners and releases the pictures of a card without a cache key', async () => {
    const canvas = makeCanvas();
    const handle = mountPreview(asCanvas(canvas), sliding);
    await wait(150);
    canvas.__fire('pointerenter');
    await wait(300);
    expect(canvas.__listeners()).toBe(4);
    handle.stop();
    expect(canvas.__listeners()).toBe(0);
    expect(bitmaps.length).toBeGreaterThan(1);
    expect(bitmaps.every((b) => b.closed)).toBe(true);
  });

  it('a cache key keeps the poster across mounts: the second mount asks the engine for nothing', async () => {
    const spec = { ...sliding, cacheKey: 'test:sliding' };
    const first = mountPreview(asCanvas(makeCanvas()), spec);
    await wait(150);
    expect(stills).toHaveLength(1);
    first.stop();
    expect(bitmaps[0]!.closed).toBe(false);

    const canvas = makeCanvas();
    const second = mountPreview(asCanvas(canvas), spec);
    await wait(150);
    expect(stills).toHaveLength(1);
    expect(canvas.__draws[0]).toBe(bitmaps[0]);
    second.stop();
  });
});

describe('buildPreviewScene', () => {
  it('serialises the scene as a document the engine restores: nodes under the comp root, the keys, one comp record', () => {
    const scene = buildPreviewScene({ ...sliding, background: '#101016' });
    expect(scene.duration).toBe(1);
    // A finite choreography holds its last pose before it restarts.
    expect(scene.loop).toBeCloseTo(1.9, 9);
    const doc = JSON.parse(scene.doc.json) as {
      scene: { nodes: Array<{ id: string; parent: string | null }> };
      animation: { tracks: Record<string, Record<string, unknown>> };
      comps: Record<string, { width: number; height: number; background: string; transparent: boolean }>;
      projectItems?: unknown;
    };
    expect(scene.doc.compId).toBe('tpl_root');
    expect(doc.scene.nodes.map((n) => [n.id, n.parent])).toEqual([['tpl_root', null], ['box', 'tpl_root']]);
    expect(Object.keys(doc.animation.tracks.box ?? {})).toEqual(['x']);
    expect(doc.comps.tpl_root).toMatchObject({ width: 320, height: 180, background: '#101016', transparent: false });
    // Never stated: a stated list would drop the open project's footage from the scratch document.
    expect(doc.projectItems).toBeUndefined();
  });

  it('an explicit loop window restarts seamlessly; a transparent background is a transparent comp', () => {
    const scene = buildPreviewScene({ ...sliding, duration: 4, background: 'rgba(0,0,0,0)' });
    expect(scene.duration).toBe(4);
    expect(scene.loop).toBe(4);
    const doc = JSON.parse(scene.doc.json) as { comps: Record<string, { transparent: boolean }> };
    expect(doc.comps.tpl_root!.transparent).toBe(true);
  });

  it('a recipe that throws still yields a document (the card shows what was built)', () => {
    const scene = buildPreviewScene({
      build: (g) => { addRoot(g, 'tpl_root', 'Broken'); throw new Error('bad recipe'); },
      width: 100,
      height: 100,
    });
    const doc = JSON.parse(scene.doc.json) as { scene: { nodes: unknown[] } };
    expect(doc.scene.nodes).toHaveLength(1);
  });
});
