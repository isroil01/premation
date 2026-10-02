/**
 * The SKELETON's mesh settings must actually reach the mesher.
 *
 * `nodeRestMesh` is the assembly both the bone overlay and `buildSnapshot` go
 * through, and its skeleton-only branch forwarded `meshDensity` and
 * `meshExpansion` but NOT `meshMode`. A bone-rigged PNG therefore always got
 * the bbox grid, whatever the rig asked for — and on the grid a thin arm can be
 * a single cell wide, sharing its vertices with the empty rectangle around it,
 * which no weighting scheme can separate. These pin the forwarding.
 *
 * The overlay↔render PARITY of the same branch lives in overlayMeshParity.
 */

import { nodeRestMesh, rigMeshPad } from './rigMeshInputs';
import { primeImageCoverageCache, clearImageCoverageCache } from './imageAlphaCoverage';
import { coverageMaskFromImageData } from './puppet';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import type { SkeletonRig } from './skeletonCommands';
import type { Stroke } from '@core/paint/stroke';

const W = 120;
const H = 120;
const SRC = 'data:image/png;base64,AAAA';

/** Body block + a THIN arm — the shape the grid cannot represent. */
function characterMask() {
  const w = 64;
  const h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const body = x >= 8 && x < 28 && y >= 12 && y < 52;
      const arm = x >= 28 && x < 56 && y >= 30 && y < 34;
      data[(y * w + x) * 4 + 3] = body || arm ? 255 : 0;
    }
  }
  return coverageMaskFromImageData({ data, width: w, height: h });
}

function bonedNode(skel: Partial<SkeletonRig>): SceneNode {
  return {
    id: 'img', name: 'img', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 't', type: 'Transform', props: { [SCENE_KIND_PROP]: 'image', x: 0, y: 0, rotation: 0, width: W, height: H } },
      { id: 'm', type: 'Media', props: { src: SRC } },
      {
        id: 'fx',
        type: 'fx',
        props: {
          skeleton: {
            bones: [{ id: 'b', parentId: null, length: 30, x: -20, y: 0, rotation: 0 }],
            ikTargets: [],
            meshDensity: 12,
            meshExpansion: 0,
            ...skel,
          } satisfies SkeletonRig,
        },
      },
    ],
  } as unknown as SceneNode;
}

const build = (skel: Partial<SkeletonRig>) =>
  nodeRestMesh(bonedNode(skel), { width: W, height: H, ellipse: false }, () => undefined);

describe('a skeleton-only layer forwards its mesh settings', () => {
  beforeEach(() => {
    clearImageCoverageCache();
    primeImageCoverageCache(SRC, characterMask());
  });

  it('meshMode reaches the mesher — outline is not the grid', () => {
    const grid = build({ meshMode: 'grid' });
    const outline = build({ meshMode: 'silhouette' });
    expect(outline.vertices.length).not.toBe(grid.vertices.length);
    expect(outline.triangles.length).toBeGreaterThan(0);
  });

  it('an absent meshMode still means grid, so old rigs mesh as they did', () => {
    expect(build({}).vertices.length).toBe(build({ meshMode: 'grid' }).vertices.length);
  });

  it('meshDensity still reaches it too', () => {
    expect(build({ meshDensity: 8 }).vertices.length)
      .not.toBe(build({ meshDensity: 20 }).vertices.length);
  });
});

describe('rigMeshPad — the drawn reach the rest mesh is grown by', () => {
  const stroke = (extra: Partial<Stroke> = {}): Stroke => ({
    enabled: true, color: '#fff', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter', ...extra,
  });

  it('only an ellipse shape is padded', () => {
    expect(rigMeshPad(false, { stroke: stroke() })).toBe(0);
    expect(rigMeshPad(true, {})).toBe(0);
  });

  it('a centre stroke reaches its width, an outside stroke double, an inside stroke nothing', () => {
    expect(rigMeshPad(true, { stroke: stroke() })).toBe(9);
    expect(rigMeshPad(true, { stroke: stroke({ align: 'outside' }) })).toBe(17);
    expect(rigMeshPad(true, { stroke: stroke({ align: 'inside' }) })).toBe(0);
  });

  it('the stroke STACK wins over the single stroke, and the widest entry governs', () => {
    expect(rigMeshPad(true, { stroke: stroke({ width: 40 }), strokes: [stroke({ width: 4 }), stroke({ width: 12 })] })).toBe(13);
  });

  it('a wave adds its amount to the band', () => {
    expect(rigMeshPad(true, { stroke: stroke({ wave: { amount: -5, wavelength: 10 } as Stroke['wave'] }) })).toBe(14);
  });

  it('is capped', () => {
    expect(rigMeshPad(true, { stroke: stroke({ width: 4000 }) })).toBe(512);
  });
});
