/**
 * Phase 1 cache gate: a transform-only animation must reuse one rasterized
 * texture across frames (contentHash excludes transform), so the vector-raster
 * cache hit rate stays high. The doc's bar is ≥95% over a 300-frame play.
 *
 * Headless: rasterizePath early-returns without a 2D ctx under jsdom, but the
 * signature-cache dedup (the thing under test) runs regardless.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider } from './AppTextureProvider';
import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

describe('vector raster cache — transform-only reuse (Phase 1 gate)', () => {
  it('≥95% cache hit rate over 300 frames of a transform-only animation', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('s'));
    // A stroke forces the shape onto the rasterized `path:` texture path.
    graph.setStroke('s', { enabled: true, color: '#ffcf33', width: 8, opacity: 1, align: 'center', dash: [], cap: 'round', join: 'round' });
    const anim = new AnimationEngine();
    // Animate the TRANSFORM only (x sweeps) — the content never changes.
    anim.setKeyframe('s', 'x', 0, 0);
    anim.setKeyframe('s', 'x', 10, 1000);

    const backend = new NullBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    const provider = new AppTextureProvider(resources);

    const comp = { width: 800, height: 600, background: '#101014' };
    const FRAMES = 300;
    let contentHash: string | undefined;
    for (let i = 0; i < FRAMES; i++) {
      const t = (i / (FRAMES - 1)) * 10;
      const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
      const layer = snap.layers[0]!;
      // Sanity: the transform moved but the content hash is stable frame-to-frame.
      if (i === 0) contentHash = layer.contentHash;
      else expect(layer.contentHash).toBe(contentHash);
      expect(layer.x).toBeCloseTo((t / 10) * 1000); // it really is moving
      provider.setPath(`path:${layer.id}`, layer);
    }

    const stats = provider.rasterStats();
    expect(stats.hits + stats.misses).toBe(FRAMES);
    expect(stats.misses).toBeGreaterThanOrEqual(1); // first frame rasterizes
    expect(stats.hitRate).toBeGreaterThanOrEqual(0.95);
  });

  it('a content change (new stroke width) forces a re-rasterize', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('s'));
    const anim = new AnimationEngine();
    const comp = { width: 800, height: 600, background: '#101014' };
    const backend = new NullBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    const provider = new AppTextureProvider(resources);

    graph.setStroke('s', { enabled: true, color: '#ffcf33', width: 8, opacity: 1, align: 'center', dash: [], cap: 'round', join: 'round' });
    let snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp);
    provider.setPath('path:s', snap.layers[0]!);
    provider.setPath('path:s', snap.layers[0]!); // identical → hit

    graph.setStroke('s', { enabled: true, color: '#ffcf33', width: 20, opacity: 1, align: 'center', dash: [], cap: 'round', join: 'round' });
    snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp);
    provider.setPath('path:s', snap.layers[0]!); // changed content → miss

    const stats = provider.rasterStats();
    expect(stats.misses).toBe(2); // first raster + the width change
    expect(stats.hits).toBe(1);
  });
});
