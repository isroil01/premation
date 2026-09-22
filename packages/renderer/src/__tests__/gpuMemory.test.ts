/**
 * VRAM accounting: the ResourceManager charges an estimate on every real
 * allocation, refunds it on every destroy path (GC, free, dispose), and never
 * charges a dedup hit twice.
 */

import { NullBackend } from '../gpu/backends/NullBackend';
import { ResourceManager } from '../gpu/ResourceManager';
import {
  GpuMemoryMeter,
  bytesPerPixel,
  estimateBufferBytes,
  estimateRenderTargetBytes,
  estimateTextureBytes,
} from '../gpu/gpuMemory';

describe('gpuMemory estimates', () => {
  it('bytes per pixel follows the format', () => {
    expect(bytesPerPixel('r8unorm')).toBe(1);
    expect(bytesPerPixel('rgba8unorm')).toBe(4);
    expect(bytesPerPixel('bgra8unorm')).toBe(4);
    expect(bytesPerPixel('rgba16float')).toBe(8);
    expect(bytesPerPixel('rgba32float')).toBe(16);
    expect(bytesPerPixel('depth24plus')).toBe(4);
  });

  it('texture = w × h × bpp, mip chain adds the levels, clamp follows the backend', () => {
    expect(estimateTextureBytes({ width: 100, height: 50, format: 'rgba8unorm' })).toBe(100 * 50 * 4);
    // 4×4 mipped: 16 + 4 + 1 texels.
    expect(estimateTextureBytes({ width: 4, height: 4, format: 'r8unorm', mipmapped: true })).toBe(21);
    expect(estimateTextureBytes({ width: 20000, height: 10, format: 'rgba8unorm' }, 8192)).toBe(8192 * 10 * 4);
  });

  it('render target = colour + MSAA attachment + depth', () => {
    expect(estimateRenderTargetBytes({ width: 10, height: 10, format: 'rgba16float' })).toBe(800);
    expect(estimateRenderTargetBytes({ width: 10, height: 10, format: 'rgba16float', depth: true })).toBe(800 + 400);
    // 4× MSAA: colour resolve + 4× colour samples + 4× depth samples.
    expect(estimateRenderTargetBytes({ width: 10, height: 10, format: 'rgba8unorm', depth: true, samples: 4 }))
      .toBe(400 + 1600 + 1600);
  });

  it('buffer rounds to 4 like the backends allocate', () => {
    expect(estimateBufferBytes({ sizeBytes: 6, usage: ['vertex'] })).toBe(8);
    expect(estimateBufferBytes({ sizeBytes: 64, usage: ['uniform'] })).toBe(64);
  });

  it('meter tracks current and peak and never goes negative', () => {
    const m = new GpuMemoryMeter();
    m.add(100);
    m.add(50);
    m.sub(120);
    expect(m.bytes).toBe(30);
    expect(m.peak).toBe(150);
    m.sub(1000);
    expect(m.bytes).toBe(0);
    m.resetPeak();
    expect(m.peak).toBe(0);
    m.add(NaN);
    m.add(-5);
    expect(m.bytes).toBe(0);
  });
});

describe('ResourceManager VRAM accounting', () => {
  it('charges on create, not on a dedup hit, and reports through stats()', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend);
    rm.beginFrame(1);
    rm.texture('t', { width: 64, height: 64, format: 'rgba8unorm' });
    rm.texture('t', { width: 64, height: 64, format: 'rgba8unorm' });
    rm.buffer('b', { sizeBytes: 256, usage: ['uniform'] });
    rm.pipeline('p', { label: 'p' } as never); // no bytes for pipelines
    const s = rm.stats();
    expect(s.gpuBytes).toBe(64 * 64 * 4 + 256);
    expect(s.gpuBytesPeak).toBe(s.gpuBytes);
    expect(backend.stats().liveTextures).toBe(1);
  });

  it('refunds on GC, free and dispose; peak stays', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend, { maxIdleFrames: 1 });
    rm.beginFrame(1);
    rm.texture('gc', { width: 10, height: 10, format: 'rgba8unorm' }); // 400
    rm.renderTarget('rt', { width: 10, height: 10, format: 'rgba16float', depth: true }); // 1200
    rm.texture('freed', { width: 5, height: 5, format: 'r8unorm' }, true); // 25, pinned
    expect(rm.stats().gpuBytes).toBe(400 + 1200 + 25);

    rm.freeTexture('freed');
    expect(rm.stats().gpuBytes).toBe(400 + 1200);

    rm.beginFrame(10);
    rm.renderTarget('rt', { width: 10, height: 10, format: 'rgba16float', depth: true }); // touched: survives
    expect(rm.collectGarbage()).toBe(1);
    expect(rm.stats().gpuBytes).toBe(1200);
    expect(backend.stats().liveRenderTargets).toBe(1);

    rm.dispose();
    const s = rm.stats();
    expect(s.gpuBytes).toBe(0);
    expect(s.gpuBytesPeak).toBe(400 + 1200 + 25);
  });

  it('follows the backend texture-size clamp', () => {
    const backend = new NullBackend();
    backend.capabilities.maxTextureSize = 1024;
    const rm = new ResourceManager(backend);
    rm.beginFrame(1);
    rm.texture('big', { width: 4096, height: 2, format: 'rgba8unorm' });
    expect(rm.stats().gpuBytes).toBe(1024 * 2 * 4);
  });
});
