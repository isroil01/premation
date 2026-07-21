import { ResourceManager, NullBackend } from '@motion/renderer';
import { Canvas2DVectorRasterizer } from './Canvas2DVectorRasterizer';

describe('Canvas2DVectorRasterizer', () => {
  let backend: NullBackend;
  let resources: ResourceManager;
  let rasterizer: Canvas2DVectorRasterizer;

  beforeEach(() => {
    backend = new NullBackend();
    resources = new ResourceManager(backend);
    resources.beginFrame(1);
    rasterizer = new Canvas2DVectorRasterizer(resources);
  });

  const dummyLayer = {
    kind: 'shape',
    contentHash: 'hash-1',
    width: 100,
    height: 100,
    fill: '#ff0000',
  };

  it('rasterizes and caches a drawable path', () => {
    const result = rasterizer.rasterize({
      drawable: dummyLayer,
      resolutionScale: 1,
      padding: 0,
    });

    expect(result.texture).toBeDefined();
    expect(result.texture.width).toBe(200); // shape supersampled by 2 -> 100 * 2 = 200
    expect(result.texture.height).toBe(200);

    const stats = rasterizer.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.textures).toBe(1);

    // Rasterize again with same request -> hit
    const result2 = rasterizer.rasterize({
      drawable: dummyLayer,
      resolutionScale: 1,
      padding: 0,
    });
    expect(result2.texture.id).toBe(result.texture.id);

    const stats2 = rasterizer.stats();
    expect(stats2.misses).toBe(1);
    expect(stats2.hits).toBe(1);
    expect(stats2.textures).toBe(1);
  });

  it('invalidates entries by contentHash', () => {
    rasterizer.rasterize({
      drawable: dummyLayer,
      resolutionScale: 1,
      padding: 0,
    });

    expect(rasterizer.stats().textures).toBe(1);
    rasterizer.invalidate('hash-1');
    expect(rasterizer.stats().textures).toBe(0);
  });

  it('evicts oldest entries when exceeding budget', () => {
    // Override maxBytes to a small budget so we can test eviction easily
    (rasterizer as any).maxBytes = 300 * 300 * 4; // enough for one 300x300 canvas (360,000 bytes)

    const layer1 = { ...dummyLayer, contentHash: 'hash-a', width: 100, height: 100 }; // 200x200 canvas -> 160,000 bytes
    const layer2 = { ...dummyLayer, contentHash: 'hash-b', width: 100, height: 100 }; // 200x200 canvas -> 160,000 bytes
    const layer3 = { ...dummyLayer, contentHash: 'hash-c', width: 100, height: 100 }; // 200x200 canvas -> 160,000 bytes

    rasterizer.rasterize({ drawable: layer1, resolutionScale: 1, padding: 0 });
    expect(rasterizer.stats().textures).toBe(1);

    rasterizer.rasterize({ drawable: layer2, resolutionScale: 1, padding: 0 });
    expect(rasterizer.stats().textures).toBe(2);

    // This should exceed the budget (160,000 * 3 = 480,000 > 360,000) and evict layer1
    rasterizer.rasterize({ drawable: layer3, resolutionScale: 1, padding: 0 });
    expect(rasterizer.stats().textures).toBe(2);

    // Verify layer1 is evicted (stats.textures is 2, and setting layer1 again should be a miss)
    rasterizer.rasterize({ drawable: layer1, resolutionScale: 1, padding: 0 });
    expect(rasterizer.stats().misses).toBe(4); // 4th miss
  });
});
