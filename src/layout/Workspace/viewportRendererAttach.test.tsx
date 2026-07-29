/**
 * useViewportRenderer must attach to a canvas that appears LATER than its first render.
 *
 * The bug this pins: Presentation Mode runs its hooks and only then does
 * `if (!active) return null`, so on mount the canvas ref is null. The attach
 * effect took its early return and — depending on `[]` — never ran again once the
 * portal finally rendered a canvas. The canvas stayed at the default 300×150 with
 * no backend behind it, which on screen is a small dark rectangle in the middle of
 * the stage that never paints while the transport happily advances the timecode.
 *
 * The failure is invisible to every other test: nothing throws, the component
 * tree is correct, and the only symptom is a canvas nobody resized.
 */

import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useViewportRenderer } from './useViewportRenderer';

/** Records what the hook does to whatever backend it is handed. */
const attached: HTMLCanvasElement[] = [];
const resizes: Array<{ width: number; height: number }> = [];
const framesRendered: unknown[] = [];

jest.mock('@core/rendering/createRenderBackend', () => ({
  createRenderBackend: () => ({
    kind: 'mock',
    readyPromise: Promise.resolve(),
    initFailed: false,
    initErrorMessage: null,
    attach: (canvas: HTMLCanvasElement) => attached.push(canvas),
    resize: (width: number, height: number) => resizes.push({ width, height }),
    renderFrame: (snapshot: unknown) => framesRendered.push(snapshot),
    dispose: () => undefined,
    setPreviewChrome: () => undefined,
    setExactMediaTiming: () => undefined,
    takeMediaWaits: () => [],
  }),
}));

/**
 * A host shaped like Presentation Mode: hooks run unconditionally, the canvas is
 * rendered only once `open` is true.
 */
function DeferredCanvasHost({ open }: { open: boolean }): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useViewportRenderer(canvasRef, containerRef, 0, 0);
  if (!open) return null;
  return (
    <div ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/** A host that mounts its canvas immediately (the docked-pane case). */
function ImmediateCanvasHost(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useViewportRenderer(canvasRef, containerRef, 0, 0);
  return (
    <div ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/** jsdom has no ResizeObserver, and the hook constructs one on attach. */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Controllable rAF: the hook schedules renders through it, so the tests need to
 * decide WHEN those callbacks run. Running them synchronously would be wrong —
 * the hook assigns the handle after the call returns, and the callback clears it.
 */
const rafQueue: FrameRequestCallback[] = [];
const flushFrames = (): void => {
  const pending = rafQueue.splice(0, rafQueue.length);
  for (const cb of pending) cb(0);
};

beforeEach(() => {
  attached.length = 0;
  resizes.length = 0;
  framesRendered.length = 0;
  rafQueue.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => rafQueue.push(cb));
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  // jsdom reports every element as 0×0, and the hook skips degenerate rects —
  // so give the container a real size or nothing would ever resize.
  jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useViewportRenderer canvas attachment', () => {
  it('attaches when the canvas mounts on a later render', () => {
    const { rerender } = render(<DeferredCanvasHost open={false} />);
    // Nothing to attach to yet — this is the state Presentation Mode sits in
    // until the user opens it.
    expect(attached).toHaveLength(0);

    rerender(<DeferredCanvasHost open />);

    // The canvas exists now, so the backend must have found it.
    expect(attached).toHaveLength(1);
    expect(attached[0]).toBeInstanceOf(HTMLCanvasElement);
  });

  it('sizes the canvas it attaches to, rather than leaving it at 300×150', () => {
    const { rerender } = render(<DeferredCanvasHost open={false} />);
    rerender(<DeferredCanvasHost open />);

    // The concrete symptom: no resize meant a default-sized canvas showing a
    // 1920×1080 composition inside 300×150.
    expect(resizes.length).toBeGreaterThan(0);
    expect(resizes[0]).toMatchObject({ width: 1280, height: 720 });
  });

  it('still attaches for a host whose canvas is present from the first render', () => {
    render(<ImmediateCanvasHost />);
    expect(attached).toHaveLength(1);
    expect(resizes.length).toBeGreaterThan(0);
  });

  it('attaches exactly once while the canvas stays the same', () => {
    // Re-attaching per render would leak a GPU context every frame.
    const { rerender } = render(<DeferredCanvasHost open />);
    rerender(<DeferredCanvasHost open />);
    rerender(<DeferredCanvasHost open />);
    expect(attached).toHaveLength(1);
  });

  it('still paints after a render was attempted with no backend', () => {
    // THE WEDGE. `render()` refuses to schedule while its rAF handle is set, and
    // the handle is only cleared by the callback. A render attempted before the
    // backend exists — which is every closed Presentation Mode — used to return
    // early WITHOUT clearing it, arming the guard forever. The canvas then
    // attached and sized correctly and never painted a single frame, which reads
    // on screen as a permanently blank stage.
    const { rerender } = render(<DeferredCanvasHost open={false} />);

    // A frame requested while there is no canvas and no backend.
    flushFrames();
    expect(framesRendered).toHaveLength(0);

    // Now open it: the backend attaches, and frames must flow again.
    rerender(<DeferredCanvasHost open />);
    flushFrames();

    expect(framesRendered.length).toBeGreaterThan(0);
  });
});
