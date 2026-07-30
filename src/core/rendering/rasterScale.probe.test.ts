/**
 * PROBE: what scale does the vector rasterizer actually see today?
 *
 * `AppTextureProvider` sizes every vector raster at
 *   effectiveScale = rasterScale (view.scale x dpr) x max(1, |scaleX|, |scaleY|)
 * so `layer.scaleX/scaleY` is the entire input continuous rasterization has to
 * work with. This measures what lands there in each case CR is supposed to
 * cover, before changing anything — the brief warned that five briefs in this
 * sequence described work that had already landed.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import type { SnapshotComp } from './buildSnapshot';

const COMP: SnapshotComp = { width: 1920, height: 1080, background: '#000' };

function shape(id: string, props: Record<string, unknown> = {}, parent: string | null = null): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 960, y: 540, width: 100, height: 100, scaleX: 1, scaleY: 1, opacity: 100, ...props },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as unknown as SceneNode;
}

/** What the rasterizer would multiply its box by, for one layer. */
function rasterMultiplier(g: SceneGraph, id: string, comp: SnapshotComp = COMP): number | null {
  const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
  const find = (ls: typeof snap.layers): (typeof snap.layers)[number] | undefined => {
    for (const l of ls) {
      if (l.id === id || l.id.endsWith(`::${id}`)) return l;
      const nested = l.precompLayers ? find(l.precompLayers) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };
  const l = find(snap.layers);
  if (!l) return null;
  // Mirrors AppTextureProvider.setPath / setText exactly.
  return Math.max(1, Math.abs(l.scaleX || 1), Math.abs(l.scaleY || 1));
}

describe('PROBE: 2D scale already reaches the rasterizer', () => {
  it('a layer scaled 800% asks for an 8x raster', () => {
    const g = new SceneGraph();
    g.addNode(shape('s', { scaleX: 8, scaleY: 8 }));
    expect(rasterMultiplier(g, 's')).toBeCloseTo(8, 3);
  });

  it('scale below 100% never asks for LESS than 1x — a shrunk vector stays crisp', () => {
    const g = new SceneGraph();
    g.addNode(shape('s', { scaleX: 0.1, scaleY: 0.1 }));
    expect(rasterMultiplier(g, 's')).toBe(1);
  });

  it('a negative (mirrored) scale asks for its magnitude, not a negative raster', () => {
    const g = new SceneGraph();
    g.addNode(shape('s', { scaleX: -6, scaleY: 6 }));
    expect(rasterMultiplier(g, 's')).toBeCloseTo(6, 3);
  });

  it('the LARGER axis wins, so a non-uniform stretch is sharp on both', () => {
    const g = new SceneGraph();
    g.addNode(shape('s', { scaleX: 2, scaleY: 9 }));
    expect(rasterMultiplier(g, 's')).toBeCloseTo(9, 3);
  });
});

describe('PROBE: does a PARENT chain reach the rasterizer?', () => {
  it('a layer parented to an 800% null', () => {
    const g = new SceneGraph();
    const parent = shape('nul', { [SCENE_KIND_PROP]: 'null', scaleX: 8, scaleY: 8 });
    // The tree walk descends `children`, so a `parent` back-pointer alone leaves
    // the child unreachable — populate both, as the real graph does.
    (parent as unknown as { children: string[] }).children = ['kid'];
    g.addNode(parent);
    g.addNode(shape('kid', {}, 'nul'));
    const m = rasterMultiplier(g, 'kid');
    // Recorded, not asserted as correct — this is the probe that decides
    // whether parent scale is part of the CR work.
    console.log(`[probe] parented-to-800%-null multiplier = ${m}`);
    expect(m).not.toBeNull();
  });
});

describe('PROBE: does 3D camera distance reach the rasterizer?', () => {
  it('a 3D layer pushed toward the camera', () => {
    const g = new SceneGraph();
    // z negative = toward the viewer in this compositor's convention.
    g.addNode(shape('far', { threeD: true, z: 0 }));
    g.addNode(shape('near', { threeD: true, z: -800 }));
    const far = rasterMultiplier(g, 'far');
    const near = rasterMultiplier(g, 'near');
    console.log(`[probe] 3D far=${far} near=${near}`);
    expect(typeof far).toBe('number');
    expect(typeof near).toBe('number');
  });
});
