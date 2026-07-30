/**
 * The Continuous Rasterization switch: where it is offered, how it persists, and
 * that it reaches the snapshot.
 *
 * Plus the performance claim, MEASURED: CR's benefit at exact tiers is not more
 * pixels (ON and OFF agree there) but a cache that stops lying, so a zoom
 * re-rasters a bounded number of times instead of either never or every frame.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
  CONTINUOUS_RASTER_PROP,
  readContinuousRaster,
  supportsContinuousRaster,
} from './continuousRaster';
import { resolutionTier, continuousResolutionTier } from '@motion/renderer';
import type { SceneNode } from '@core/types';
import type { SnapshotComp } from '@core/rendering/buildSnapshot';

const COMP: SnapshotComp = { width: 1920, height: 1080, background: '#000' };

function node(id: string, kind: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: kind, x: 960, y: 540, width: 100, height: 100, scaleX: 1, scaleY: 1, opacity: 100, ...props },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as unknown as SceneNode;
}

const TRIANGLE = [
  { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
  { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
  { x: 50, y: 100, inX: 0, inY: 0, outX: 0, outY: 0 },
];

describe('where the switch is offered', () => {
  it('text and SVG always qualify', () => {
    expect(supportsContinuousRaster(node('t', 'text'))).toBe(true);
    expect(supportsContinuousRaster(node('s', 'svg'))).toBe(true);
  });

  it('a shape with real geometry qualifies', () => {
    expect(supportsContinuousRaster(node('p', 'shape', { pathPoints: TRIANGLE }))).toBe(true);
    expect(supportsContinuousRaster(node('r', 'shape', { cornerRadius: 12 }))).toBe(true);
    expect(supportsContinuousRaster(node('e', 'shape', { shapeType: 'ellipse' }))).toBe(true);
    expect(supportsContinuousRaster(node('k', 'shape', { strokeWidth: 3 }))).toBe(true);
  });

  it('a FLAT rect does not — its edges are the quad, already crisp at any scale', () => {
    expect(supportsContinuousRaster(node('flat', 'shape'))).toBe(false);
  });

  it('bitmaps do not — no scale invents detail the file never had', () => {
    expect(supportsContinuousRaster(node('i', 'image'))).toBe(false);
    expect(supportsContinuousRaster(node('v', 'video'))).toBe(false);
  });

  it('a missing node is not a crash', () => {
    expect(supportsContinuousRaster(undefined)).toBe(false);
  });
});

describe('the prop', () => {
  it('reads false when absent — every existing project', () => {
    expect(readContinuousRaster(node('t', 'text'))).toBe(false);
  });

  it('reads true only for a literal true, not any truthy value', () => {
    expect(readContinuousRaster(node('t', 'text', { [CONTINUOUS_RASTER_PROP]: true }))).toBe(true);
    expect(readContinuousRaster(node('t', 'text', { [CONTINUOUS_RASTER_PROP]: 1 }))).toBe(false);
    expect(readContinuousRaster(node('t', 'text', { [CONTINUOUS_RASTER_PROP]: 'true' }))).toBe(false);
  });
});

describe('it reaches the snapshot, gated', () => {
  const build = (n: SceneNode) => {
    const g = new SceneGraph();
    g.addNode(n);
    return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
  };
  const flagOf = (n: SceneNode) => build(n).layers.find((l) => l.id === n.id)?.continuousRaster;

  it('is ABSENT when off, so the snapshot is unchanged from before the feature', () => {
    expect(flagOf(node('p', 'shape', { pathPoints: TRIANGLE }))).toBeUndefined();
  });

  it('is set when on and supported', () => {
    expect(flagOf(node('p', 'shape', { pathPoints: TRIANGLE, [CONTINUOUS_RASTER_PROP]: true }))).toBe(true);
    expect(flagOf(node('t', 'text', { [CONTINUOUS_RASTER_PROP]: true }))).toBe(true);
  });

  it('is DROPPED on a layer that cannot benefit, even with the prop set', () => {
    // A stray flag on an image must not make the provider allocate a big raster
    // that cannot look any better.
    expect(flagOf(node('i', 'image', { [CONTINUOUS_RASTER_PROP]: true }))).toBeUndefined();
    expect(flagOf(node('flat', 'shape', { [CONTINUOUS_RASTER_PROP]: true }))).toBeUndefined();
  });
});

describe('vector inside a COLLAPSED precomp', () => {
  it('carries its own switch through the clone, with no special case', () => {
    // Collapsing clones the source comp's layers into the host under an
    // `<instanceId>::` prefix. The clone is built from the original node, so the
    // prop rides along — this pins that rather than assuming it.
    const g = new SceneGraph();
    const root = node('srcComp', 'group');
    (root as unknown as { children: string[] }).children = ['inner'];
    g.addNode(root);
    g.addNode({
      ...node('inner', 'shape', { pathPoints: TRIANGLE, [CONTINUOUS_RASTER_PROP]: true }),
      parent: 'srcComp',
    } as SceneNode);

    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    const find = (ls: typeof snap.layers): boolean => {
      for (const l of ls) {
        if (l.id === 'inner' || l.id.endsWith('::inner')) return l.continuousRaster === true;
        if (l.precompLayers && find(l.precompLayers)) return true;
      }
      return false;
    };
    expect(find(snap.layers)).toBe(true);
  });
});

describe('MEASURED: what CR does to re-rasterization across a zoom', () => {
  /** Distinct cache identities a continuous zoom produces over [1, 32]. */
  const identities = (tier: (s: number) => number): number => {
    const seen = new Set<number>();
    for (let s = 1; s <= 32; s += 0.05) seen.add(tier(s));
    return seen.size;
  };

  it('quantizing keeps the number of distinct rasters small and BOUNDED', () => {
    const crCount = identities((s) => continuousResolutionTier(s, 100, 100));
    // 1,2,4,8,16,32 — six rasters for a 32x zoom, not one per frame.
    expect(crCount).toBeLessThanOrEqual(6);
    // eslint-disable-next-line no-console
    console.log(`[measured] distinct CR rasters over a 1x→32x zoom: ${crCount}`);
  });

  it('the OFF path collapses the whole range above 4x onto ONE identity', () => {
    const offCount = identities(resolutionTier);
    expect(offCount).toBeLessThanOrEqual(4);
    // Which is the bug: past 4x every scale is the same key, so the texture
    // never updates however far you zoom.
    expect(resolutionTier(5)).toBe(resolutionTier(32));
  });

  it('CR distinguishes scales that OFF conflates', () => {
    expect(resolutionTier(6)).toBe(resolutionTier(12));
    expect(continuousResolutionTier(6, 100, 100)).not.toBe(continuousResolutionTier(12, 100, 100));
  });
});
