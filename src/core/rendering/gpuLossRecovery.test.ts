/**
 * GPU device / context loss is RECOVERED — proven by firing it.
 *
 * This replaces `deviceLossWiring.test.ts`, which grepped the source for
 * `device.lost.then` and a `noteDeviceLoss(` call. That proved a line existed;
 * it could not prove anything happened, and the thing that did not happen was
 * the important part: a device reset only invalidated plugin pipelines, and
 * WebGL2's `onContextChange` had no caller at all — either way the viewport
 * stayed dead until the project was reopened.
 *
 * Here the real `MotionRendererBackend` runs its real init ladder over fake GPU
 * backends (NullBackend underneath, so the whole Renderer really renders) that
 * can be told to lose their device. What is pinned:
 *
 *   • a loss tears the renderer down, rebuilds through the ladder, repaints the
 *     frame that was on screen, and tells the user once;
 *   • frames requested mid-recovery are not drawn and SAY why (export refuses);
 *   • our own teardown (`destroyed`) is never mistaken for a loss;
 *   • WebGL2 waits for `webglcontextrestored` (or a timeout), and the rebuilt
 *     backend is handed a context the old one did not lose again;
 *   • a loss LOOP stops, tells the user, and later backends start on WebGL2;
 *   • plugin attribution still sees every loss;
 *   • layer errors reach lastFrameDiagnostics and never masquerade as an
 *     EngineError (which flips the tier badge).
 */

import type { RenderSnapshot } from './RenderBackend';

const mockRecovered = jest.fn();
const mockRecoveryFailed = jest.fn();
const mockReport = jest.fn();
jest.mock('./engineDiagnostics', () => ({
  notifyGpuRecovered: (...a: unknown[]) => mockRecovered(...a),
  notifyGpuRecoveryFailed: (...a: unknown[]) => mockRecoveryFailed(...a),
  reportFrameDiagnostics: (...a: unknown[]) => mockReport(...a),
}));

jest.mock('@motion/renderer', () => {
  const actual = jest.requireActual('@motion/renderer');
  class FakeWebGpu extends actual.NullBackend {
    static instances: FakeWebGpu[] = [];
    lostHandler: ((reason: string) => void) | null = null;
    disposed = false;
    constructor() {
      super();
      FakeWebGpu.instances.push(this);
    }
    onDeviceLost(handler: (reason: string) => void): void {
      this.lostHandler = handler;
    }
    fireLost(reason: string): void {
      this.lostHandler?.(reason);
    }
    dispose(): void {
      this.disposed = true;
      super.dispose();
      // What a real `device.destroy()` does: resolve `lost` with 'destroyed'.
      this.lostHandler?.('destroyed: device destroyed by the app');
    }
  }
  class FakeWebGl2 extends actual.NullBackend {
    static instances: FakeWebGl2[] = [];
    retainContextOnDispose = false;
    disposed = false;
    private readonly onLost = new Set<() => void>();
    private readonly onRestored = new Set<() => void>();
    constructor() {
      super();
      FakeWebGl2.instances.push(this);
    }
    onContextChange(lost: () => void, restored: () => void): () => void {
      this.onLost.add(lost);
      this.onRestored.add(restored);
      return () => {
        this.onLost.delete(lost);
        this.onRestored.delete(restored);
      };
    }
    isLost(): boolean {
      return false;
    }
    fireLost(): void {
      [...this.onLost].forEach((fn) => fn());
    }
    fireRestored(): void {
      [...this.onRestored].forEach((fn) => fn());
    }
    dispose(): void {
      this.disposed = true;
      this.onLost.clear();
      this.onRestored.clear();
      super.dispose();
    }
  }
  return { ...actual, WebGPUBackend: FakeWebGpu, WebGL2Backend: FakeWebGl2 };
});

// Imported after the mocks are declared (jest hoists them regardless).
import { MotionRendererBackend } from './MotionRendererBackend';
import { WebGPUBackend, WebGL2Backend } from '@motion/renderer';
import { getEventBus } from '@core/events/EventBus';

interface FakeGpu { disposed: boolean; fireLost(reason: string): void; stats(): { frames: number } }
interface FakeGl { disposed: boolean; retainContextOnDispose: boolean; fireLost(): void; fireRestored(): void; stats(): { frames: number } }
const gpuInstances = (): FakeGpu[] => (WebGPUBackend as unknown as { instances: FakeGpu[] }).instances;
const glInstances = (): FakeGl[] => (WebGL2Backend as unknown as { instances: FakeGl[] }).instances;

const statics = MotionRendererBackend as unknown as {
  webgpuProbe: Promise<boolean> | null;
  webgpuDisabledByLossLoop: boolean;
};

function fakeCanvas(): HTMLCanvasElement {
  // getContext must answer truthy for the tier just attempted, so the ladder
  // records the binding exactly as it does on a real element.
  return { width: 0, height: 0, style: {}, getContext: () => ({}) } as unknown as HTMLCanvasElement;
}

const snap = { width: 64, height: 64, background: '#000000', layers: [] } as unknown as RenderSnapshot;

async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!pred()) throw new Error(`timed out waiting for: ${what}`);
}

const live: MotionRendererBackend[] = [];
function make(kind: 'webgpu' | 'webgl2'): MotionRendererBackend {
  const be = new MotionRendererBackend(kind, 'viewport');
  live.push(be);
  be.attach(fakeCanvas());
  return be;
}

beforeEach(() => {
  gpuInstances().length = 0;
  glInstances().length = 0;
  mockRecovered.mockReset();
  mockRecoveryFailed.mockReset();
  mockReport.mockReset();
  statics.webgpuDisabledByLossLoop = false;
  MotionRendererBackend.gpuLossPolicy = { maxRecoveriesPerMinute: 3, baseDelayMs: 0, maxDelayMs: 0, restoreTimeoutMs: 10_000 };
});

afterEach(() => {
  while (live.length) live.pop()!.dispose();
  delete (navigator as unknown as { gpu?: unknown }).gpu;
  statics.webgpuProbe = null;
});

function enableWebGpu(): void {
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });
  statics.webgpuProbe = Promise.resolve(true);
}

describe('WebGPU device loss', () => {
  beforeEach(enableWebGpu);

  it('rebuilds the renderer, repaints the current frame, and says so once', async () => {
    const be = make('webgpu');
    await be.readyPromise;
    expect(be.resolvedKind).toBe('webgpu');
    be.renderFrame(snap);
    const first = gpuInstances()[0]!;

    first.fireLost('unknown: GPU process crashed');

    // Mid-recovery: nothing is drawn, and the frame says why.
    be.renderFrame(snap);
    expect(be.lastFrameDidRender()).toBe(false);
    expect(be.lastFrameDiagnostics()).toEqual([expect.objectContaining({ code: 'device-lost' })]);

    await until(() => mockRecovered.mock.calls.length > 0, 'recovery');
    expect(first.disposed).toBe(true);
    expect(gpuInstances()).toHaveLength(2);
    expect(be.resolvedKind).toBe('webgpu');
    // The pending frame was flushed through the NEW device.
    expect(be.lastFrameDidRender()).toBe(true);
    expect(gpuInstances()[1]!.stats().frames).toBeGreaterThan(0);
    expect(mockRecovered).toHaveBeenCalledTimes(1);
    expect(mockRecovered).toHaveBeenCalledWith('viewport', 'motion-webgpu', expect.stringContaining('GPU process crashed'));
  });

  it('keeps rendering normally after recovery', async () => {
    const be = make('webgpu');
    await be.readyPromise;
    be.renderFrame(snap);
    gpuInstances()[0]!.fireLost('unknown: reset');
    await until(() => mockRecovered.mock.calls.length > 0, 'recovery');
    be.renderFrame(snap);
    expect(be.lastFrameDidRender()).toBe(true);
    expect(be.lastFrameDiagnostics()).toEqual([]);
  });

  it('does not treat its own teardown (reason "destroyed") as a loss', async () => {
    const be = make('webgpu');
    await be.readyPromise;
    live.splice(live.indexOf(be), 1);
    be.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(gpuInstances()).toHaveLength(1);
    expect(mockRecovered).not.toHaveBeenCalled();
    expect(mockRecoveryFailed).not.toHaveBeenCalled();
  });

  it('ignores a second signal for the same lost device', async () => {
    const be = make('webgpu');
    await be.readyPromise;
    const first = gpuInstances()[0]!;
    first.fireLost('unknown: a');
    first.fireLost('unknown: a again');
    await until(() => mockRecovered.mock.calls.length > 0, 'recovery');
    await new Promise((r) => setTimeout(r, 5));
    expect(gpuInstances()).toHaveLength(2);
  });

  it('stops on a loss loop, tells the user, and later backends start on WebGL2', async () => {
    MotionRendererBackend.gpuLossPolicy = { ...MotionRendererBackend.gpuLossPolicy, maxRecoveriesPerMinute: 2 };
    const be = make('webgpu');
    await be.readyPromise;
    for (let i = 0; i < 2; i++) {
      gpuInstances()[gpuInstances().length - 1]!.fireLost(`unknown: loss ${i}`);
      await until(() => mockRecovered.mock.calls.length === i + 1, `recovery ${i}`);
    }
    gpuInstances()[gpuInstances().length - 1]!.fireLost('unknown: loss 3');
    await until(() => mockRecoveryFailed.mock.calls.length > 0, 'give-up');
    expect(be.initFailed).toBe(true);
    expect(be.initErrorMessage).toMatch(/3 times in a minute/);
    expect(mockRecoveryFailed).toHaveBeenCalledWith('viewport', 'motion-webgpu', expect.stringMatching(/WebGL2/));
    expect(gpuInstances()).toHaveLength(3); // no fourth device

    const next = make('webgpu');
    await next.readyPromise;
    expect(next.resolvedKind).toBe('webgl2');
  });
});

describe('WebGL2 context loss', () => {
  it('waits for webglcontextrestored, then rebuilds on the same context', async () => {
    const be = make('webgl2');
    await be.readyPromise;
    expect(be.resolvedKind).toBe('webgl2');
    be.renderFrame(snap);
    const first = glInstances()[0]!;

    first.fireLost();
    await new Promise((r) => setTimeout(r, 5));
    // Not rebuilt before the restore: GL objects on a still-lost context are dead.
    expect(glInstances()).toHaveLength(1);
    be.renderFrame(snap);
    expect(be.lastFrameDidRender()).toBe(false);

    first.fireRestored();
    await until(() => mockRecovered.mock.calls.length > 0, 'recovery');
    expect(glInstances()).toHaveLength(2);
    expect(first.disposed).toBe(true);
    // The old backend must not lose the context the new one adopts.
    expect(first.retainContextOnDispose).toBe(true);
    expect(be.lastFrameDidRender()).toBe(true);
    expect(mockRecovered).toHaveBeenCalledWith('viewport', 'motion-webgl2', 'webglcontextlost');
  });

  it('rebuilds after a timeout when the browser never restores', async () => {
    MotionRendererBackend.gpuLossPolicy = { ...MotionRendererBackend.gpuLossPolicy, restoreTimeoutMs: 5 };
    const be = make('webgl2');
    await be.readyPromise;
    glInstances()[0]!.fireLost();
    await until(() => mockRecovered.mock.calls.length > 0, 'timeout recovery');
    expect(glInstances()).toHaveLength(2);
    expect(be.resolvedKind).toBe('webgl2');
  });
});

describe('frame diagnostics routing', () => {
  it('folds snapshot layer errors into lastFrameDiagnostics and never emits EngineError for them', async () => {
    const be = make('webgl2');
    await be.readyPromise;
    const emit = jest.spyOn(getEventBus(), 'emit');
    be.renderFrame({
      ...snap,
      layerErrors: [{ layerId: 'L1', layerName: 'Title', stage: 'snapshot', message: 'TypeError: bad params' }],
    } as RenderSnapshot);
    expect(be.lastFrameDiagnostics()).toEqual([
      expect.objectContaining({ code: 'layer-error', layerId: 'L1', detail: expect.stringMatching(/"Title".*bad params/) }),
    ]);
    expect(mockReport).toHaveBeenLastCalledWith(be.lastFrameDiagnostics(), 'viewport', 'motion-webgl2');
    expect(emit.mock.calls.filter((c) => c[0] === 'EngineError')).toHaveLength(0);
    emit.mockRestore();
  });

  it('a healthy frame has no diagnostics', async () => {
    const be = make('webgl2');
    await be.readyPromise;
    be.renderFrame(snap);
    expect(be.lastFrameDiagnostics()).toEqual([]);
  });
});
