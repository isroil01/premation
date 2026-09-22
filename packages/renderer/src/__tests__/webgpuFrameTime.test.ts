/**
 * WebGPUBackend GPU frame time — the timestamp-query ring against a fake device.
 *
 * What is pinned: the feature is requested only when the adapter offers it;
 * the FIRST pass of a frame writes query 0 at its beginning and every pass
 * writes query 1 at its end; endFrame resolves + copies into a free staging
 * slot inside the frame's own command buffer and maps it AFTER submit; the
 * handler receives (end − begin) in ms once the map resolves; with every slot
 * still in flight the frame is skipped rather than awaited; and without the
 * feature no descriptor carries a `timestampWrites` key at all (the golden
 * gate's "output-neutral" guarantee).
 */

import { WebGPUBackend } from '../gpu/backends/WebGPUBackend';

interface FakeBuffer {
  desc: Record<string, unknown>;
  mapAsync: jest.Mock;
  getMappedRange: jest.Mock;
  unmap: jest.Mock;
  destroy: jest.Mock;
  /** Resolve the pending mapAsync with these two u64 ns stamps. */
  resolveMap(begin: bigint, end: bigint): void;
}

interface FakeDevice {
  device: Record<string, unknown>;
  buffers: FakeBuffer[];
  passDescs: Record<string, unknown>[];
  encoderCalls: string[];
  submits: number;
  querySets: number;
}

function makeFakeGpu(features: string[]): FakeDevice {
  const state: FakeDevice = { device: {}, buffers: [], passDescs: [], encoderCalls: [], submits: 0, querySets: 0 };
  const featureSet = { has: (f: string) => features.includes(f) };
  const makeBuffer = (desc: Record<string, unknown>): FakeBuffer => {
    let resolve: (() => void) | null = null;
    let stamps = new BigUint64Array(2);
    const buf: FakeBuffer = {
      desc,
      mapAsync: jest.fn(() => new Promise<void>((r) => { resolve = r; })),
      getMappedRange: jest.fn(() => stamps.buffer),
      unmap: jest.fn(),
      destroy: jest.fn(),
      resolveMap(begin, end) {
        stamps = new BigUint64Array([begin, end]);
        resolve?.();
        resolve = null;
      },
    };
    state.buffers.push(buf);
    return buf;
  };
  const texture = { format: 'rgba8unorm', createView: () => ({}), destroy: () => {} };
  state.device = {
    features: featureSet,
    limits: { maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    queue: { submit: () => { state.submits += 1; }, writeBuffer: () => {}, writeTexture: () => {} },
    createQuerySet: jest.fn(() => { state.querySets += 1; return { count: 2, destroy: () => {} }; }),
    createBuffer: jest.fn((desc: Record<string, unknown>) => makeBuffer(desc)),
    createTexture: () => texture,
    createCommandEncoder: () => ({
      beginRenderPass: (desc: Record<string, unknown>) => {
        state.passDescs.push(desc);
        state.encoderCalls.push('pass');
        return { end: () => {}, setScissorRect: () => {} };
      },
      resolveQuerySet: () => { state.encoderCalls.push('resolve'); },
      copyBufferToBuffer: () => { state.encoderCalls.push('copy'); },
      finish: () => { state.encoderCalls.push('finish'); return {}; },
    }),
    destroy: () => {},
  };
  const adapter = { features: featureSet, limits: {}, requestDevice: jest.fn(async () => state.device) };
  Object.defineProperty(globalThis.navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' },
  });
  (globalThis as unknown as { GPUMapMode: unknown }).GPUMapMode = { READ: 1, WRITE: 2 };
  return state;
}

afterEach(() => {
  delete (globalThis.navigator as unknown as { gpu?: unknown }).gpu;
});

function drawTwoPasses(backend: WebGPUBackend): void {
  const rt = backend.createRenderTarget({ width: 4, height: 4, format: 'rgba8unorm' });
  backend.beginFrame();
  backend.beginRenderPass({ label: 'a', color: { target: rt, clear: { r: 0, g: 0, b: 0, a: 0 } } }).end();
  backend.beginRenderPass({ label: 'b', color: { target: rt } }).end();
  backend.endFrame();
}

describe('WebGPUBackend GPU frame time', () => {
  it('requests timestamp-query when the adapter offers it and reports it in capabilities', async () => {
    const fake = makeFakeGpu(['timestamp-query']);
    const backend = new WebGPUBackend();
    await backend.initialize();
    const adapter = await (globalThis.navigator as unknown as { gpu: { requestAdapter(): Promise<{ requestDevice: jest.Mock }> } }).gpu.requestAdapter();
    expect(adapter.requestDevice.mock.calls[0]![0].requiredFeatures).toContain('timestamp-query');
    expect(backend.capabilities.timestampQueries).toBe(true);
    expect(fake.querySets).toBe(1);
    // One resolve buffer + the staging ring.
    const staging = fake.buffers.filter((b) => String(b.desc.label).includes('staging'));
    expect(staging.length).toBeGreaterThanOrEqual(2);
  });

  it('first pass writes query 0 at its beginning, every pass writes query 1 at its end', async () => {
    const fake = makeFakeGpu(['timestamp-query']);
    const backend = new WebGPUBackend();
    await backend.initialize();
    backend.onGpuFrameTime(() => {});
    drawTwoPasses(backend);
    const [a, b] = fake.passDescs as Array<{ timestampWrites?: Record<string, unknown> }>;
    expect(a!.timestampWrites).toMatchObject({ beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    expect(b!.timestampWrites).toMatchObject({ endOfPassWriteIndex: 1 });
    expect(b!.timestampWrites).not.toHaveProperty('beginningOfPassWriteIndex');
    // Resolve + copy are in the frame's command buffer, before finish; map after submit.
    expect(fake.encoderCalls).toEqual(['pass', 'pass', 'resolve', 'copy', 'finish']);
    expect(fake.submits).toBe(1);
    const mapped = fake.buffers.filter((b) => b.mapAsync.mock.calls.length > 0);
    expect(mapped).toHaveLength(1);
  });

  it('delivers (end − begin) in ms to the handler once the map resolves, then frees the slot', async () => {
    const fake = makeFakeGpu(['timestamp-query']);
    const backend = new WebGPUBackend();
    await backend.initialize();
    const got: number[] = [];
    backend.onGpuFrameTime((ms) => got.push(ms));
    drawTwoPasses(backend);
    const slot = fake.buffers.find((b) => b.mapAsync.mock.calls.length > 0)!;
    expect(got).toEqual([]); // nothing synchronous
    slot.resolveMap(1_000_000n, 3_500_000n); // 2.5 ms
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual([2.5]);
    expect(slot.unmap).toHaveBeenCalledTimes(1);
    // The slot is reusable: the next frame may land in it again.
    drawTwoPasses(backend);
    const used = fake.buffers.filter((b) => b.mapAsync.mock.calls.length > 0);
    expect(used.some((b) => b.mapAsync.mock.calls.length === 2) || used.length === 2).toBe(true);
  });

  it('skips the readback (never awaits) when every staging slot is still in flight', async () => {
    const fake = makeFakeGpu(['timestamp-query']);
    const backend = new WebGPUBackend();
    await backend.initialize();
    backend.onGpuFrameTime(() => {});
    const ring = fake.buffers.filter((b) => String(b.desc.label).includes('staging')).length;
    for (let i = 0; i < ring + 2; i++) drawTwoPasses(backend);
    const resolves = fake.encoderCalls.filter((c) => c === 'resolve').length;
    expect(resolves).toBe(ring);
    // Passes still got their timestamps; the frames were merely not read back.
    expect(fake.passDescs.every((d) => 'timestampWrites' in d)).toBe(true);
  });

  it('is inert without a handler: timestamps are written but nothing is resolved or mapped', async () => {
    const fake = makeFakeGpu(['timestamp-query']);
    const backend = new WebGPUBackend();
    await backend.initialize();
    drawTwoPasses(backend);
    expect(fake.encoderCalls).toEqual(['pass', 'pass', 'finish']);
  });

  it('without the feature: not requested, no query set, no timestampWrites key on any pass', async () => {
    const fake = makeFakeGpu([]);
    const backend = new WebGPUBackend();
    await backend.initialize();
    const adapter = await (globalThis.navigator as unknown as { gpu: { requestAdapter(): Promise<{ requestDevice: jest.Mock }> } }).gpu.requestAdapter();
    expect(adapter.requestDevice.mock.calls[0]![0]?.requiredFeatures ?? []).not.toContain('timestamp-query');
    expect(backend.capabilities.timestampQueries).toBe(false);
    expect(fake.querySets).toBe(0);
    const got: number[] = [];
    backend.onGpuFrameTime((ms) => got.push(ms));
    drawTwoPasses(backend);
    expect(fake.passDescs.every((d) => !('timestampWrites' in d))).toBe(true);
    expect(fake.encoderCalls).toEqual(['pass', 'pass', 'finish']);
    expect(got).toEqual([]);
  });

  it('a device that refuses the query set degrades to "not measured"', async () => {
    const fake = makeFakeGpu(['timestamp-query']);
    (fake.device.createQuerySet as jest.Mock).mockImplementation(() => { throw new Error('unsupported'); });
    const backend = new WebGPUBackend();
    await backend.initialize();
    expect(backend.capabilities.timestampQueries).toBe(false);
    backend.onGpuFrameTime(() => {});
    drawTwoPasses(backend);
    expect(fake.passDescs.every((d) => !('timestampWrites' in d))).toBe(true);
  });
});
