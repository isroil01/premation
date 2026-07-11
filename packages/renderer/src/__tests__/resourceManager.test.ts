import { NullBackend } from '../gpu/backends/NullBackend';
import { ResourceManager } from '../gpu/ResourceManager';

function bufferDesc() {
  return { sizeBytes: 64, usage: ['uniform'] as const };
}

describe('ResourceManager', () => {
  it('dedups: same key returns the same handle (no duplicate allocation)', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend);
    rm.beginFrame(1);
    const a = rm.buffer('k', bufferDesc());
    const b = rm.buffer('k', bufferDesc());
    expect(a).toBe(b);
    expect(backend.stats().liveBuffers).toBe(1);
    expect(rm.stats().buffers).toBe(1);
  });

  it('different keys allocate distinct resources', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend);
    rm.beginFrame(1);
    rm.buffer('a', bufferDesc());
    rm.buffer('b', bufferDesc());
    expect(backend.stats().liveBuffers).toBe(2);
  });

  it('GC disposes resources untouched past the idle window', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend, { maxIdleFrames: 2 });
    rm.beginFrame(1);
    rm.buffer('stale', bufferDesc());
    expect(rm.stats().buffers).toBe(1);

    rm.beginFrame(2);
    expect(rm.collectGarbage()).toBe(0); // within idle window

    rm.beginFrame(5); // 5 - 1 = 4 > 2
    expect(rm.collectGarbage()).toBe(1);
    expect(backend.stats().liveBuffers).toBe(0);
  });

  it('touching a resource each frame keeps it alive', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend, { maxIdleFrames: 1 });
    for (let f = 1; f <= 5; f++) {
      rm.beginFrame(f);
      rm.buffer('hot', bufferDesc());
      rm.collectGarbage();
    }
    expect(backend.stats().liveBuffers).toBe(1);
  });

  it('pinned resources are never collected', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend, { maxIdleFrames: 0 });
    rm.beginFrame(1);
    rm.buffer('pinned', bufferDesc(), /* pinned */ true);
    rm.beginFrame(100);
    expect(rm.collectGarbage()).toBe(0);
    expect(backend.stats().liveBuffers).toBe(1);
  });

  it('dispose releases everything', () => {
    const backend = new NullBackend();
    const rm = new ResourceManager(backend);
    rm.beginFrame(1);
    rm.buffer('a', bufferDesc());
    rm.texture('t', { width: 4, height: 4, format: 'rgba8unorm' });
    rm.dispose();
    expect(backend.stats().liveBuffers).toBe(0);
    expect(backend.stats().liveTextures).toBe(0);
  });
});
