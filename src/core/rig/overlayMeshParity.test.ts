/**
 * Overlay-vs-snapshot mesh parity (regression for doc §12.3 / §12.4).
 *
 * The puppet overlay draws a wireframe + weight heatmap of the mesh it believes
 * the renderer is deforming. It used to derive that mesh WITHOUT the image-alpha
 * coverage mask that buildSnapshot passes, so on an image layer the two sides
 * meshed differently — the overlay drew an untrimmed bbox grid over an
 * alpha-culled render. Wrong vertex count, wrong weights, and a heatmap
 * describing a mesh nobody was drawing.
 *
 * Both sides now resolve their mesh inputs through `rigMeshInputs`. These tests
 * pin that down: the overlay's derivation must reproduce the snapshot's mesh
 * exactly, and the pre-fix derivation must visibly differ (otherwise the test
 * would pass for the wrong reason).
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
  clearImageCoverageCache,
  primeImageCoverageCache,
} from '@core/rendering/imageAlphaCoverage';
import {
  coverageMaskFromImageData,
  getCachedRestMesh,
  silhouetteFromPathPoints,
  type PuppetRig,
} from './puppet';
import {
  rigCoverageMask,
  rigLayerKind,
  nodeRestMesh,
} from './rigMeshInputs';

const comp = { width: 800, height: 600, background: '#101014' };

const W = 120;
const H = 90;
/** `data:` sources pass through assetUrl untouched, so the cache key is stable. */
const SRC = 'data:image/png;base64,AAAA';

const RIG: PuppetRig = {
  meshDensity: 12,
  meshExpansion: 6,
  pins: [
    { id: 'pinA', name: 'A', x: -30, y: 0 },
    { id: 'pinB', name: 'B', x: 30, y: 0 },
  ],
};

function imageNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'image', x: 100, y: 100, rotation: 0, width: W, height: H },
      },
      { id: `${id}_m`, type: 'Media', props: { src: SRC } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
    ],
  } as unknown as SceneNode;
}

/**
 * A mask with fully-transparent corners and an opaque middle band — the exact
 * shape that makes coverage culling change the mesh.
 */
function bandMask(): ReturnType<typeof coverageMaskFromImageData> {
  const w = 32;
  const h = 32;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBand = y >= 10 && y < 22;
      data[(y * w + x) * 4 + 3] = inBand ? 255 : 0;
    }
  }
  return coverageMaskFromImageData({ data, width: w, height: h });
}

function riggedScene(): { graph: SceneGraph; anim: AnimationEngine; node: SceneNode } {
  const graph = new SceneGraph();
  const node = imageNode('img');
  graph.addNode(node);
  graph.setPuppet('img', RIG);
  return { graph, anim: new AnimationEngine(), node: graph.getNode('img')! };
}

/**
 * Exactly what PuppetOverlay does to build its wireframe mesh: `nodeRestMesh`.
 * `pad` is 0 for an unstroked image on both sides.
 */
function overlayMesh(node: SceneNode): ReturnType<typeof nodeRestMesh> {
  return nodeRestMesh(node, { width: W, height: H, ellipse: false }, () => undefined);
}

/** The PRE-FIX overlay derivation: identical, minus the coverage argument. */
function overlayMeshWithoutCoverage(node: SceneNode, pad = 0): ReturnType<typeof getCachedRestMesh> {
  return getCachedRestMesh(node.id, W, H, pad, RIG, undefined);
}

function snapshotMesh(graph: SceneGraph, anim: AnimationEngine) {
  const snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 'img');
  expect(layer).toBeDefined();
  expect(layer!.deformedMesh).toBeDefined();
  return layer!.deformedMesh!;
}

describe('§12.3 — overlay mesh matches the rendered mesh (image layers)', () => {
  beforeEach(() => {
    clearImageCoverageCache();
  });

  it('overlay and snapshot agree once the bitmap alpha has decoded', () => {
    primeImageCoverageCache(SRC, bandMask());
    const { graph, anim, node } = riggedScene();

    const rendered = snapshotMesh(graph, anim);
    const overlay = overlayMesh(node);

    expect(overlay.vertices.length).toBe(rendered.vertices.length);
    expect(overlay.triangles.length).toBe(rendered.triangles.length);
    for (let i = 0; i < overlay.triangles.length; i++) {
      expect(overlay.triangles[i]).toBe(rendered.triangles[i]);
    }
  });

  it('the pre-fix derivation (no coverage) genuinely differed — the bug was real', () => {
    primeImageCoverageCache(SRC, bandMask());
    const { graph, anim, node } = riggedScene();

    const rendered = snapshotMesh(graph, anim);
    const stale = overlayMeshWithoutCoverage(node);

    // A transparent-cornered bitmap culls cells, so the uncovered grid is
    // strictly larger. If this ever stops differing the parity test above is
    // no longer proving anything.
    expect(stale.vertices.length).toBeGreaterThan(rendered.vertices.length);
  });

  it('per-pin weight columns match, so the heatmap describes the rendered mesh', () => {
    primeImageCoverageCache(SRC, bandMask());
    const { graph, anim, node } = riggedScene();

    snapshotMesh(graph, anim);
    const overlay = overlayMesh(node);

    for (const pin of RIG.pins) {
      const col = overlay.weights[pin.id];
      expect(col).toBeDefined();
      expect(col!.length).toBe(overlay.vertices.length / 4);
    }
    // Weights still partition unity per vertex after culling.
    const n = overlay.vertices.length / 4;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const pin of RIG.pins) sum += overlay.weights[pin.id]![i]!;
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('an undecoded bitmap falls back to the bbox grid on BOTH sides', () => {
    // No primed mask — getImageCoverageMask returns undefined for this frame.
    const { graph, anim, node } = riggedScene();

    const rendered = snapshotMesh(graph, anim);
    const overlay = overlayMesh(node);

    expect(overlay.vertices.length).toBe(rendered.vertices.length);
    // And that fallback IS the plain grid: (density+1)^2 vertices, 4 floats each.
    expect(rendered.vertices.length).toBe((12 + 1) * (12 + 1) * 4);
  });
});

describe('rigMeshInputs resolution rules', () => {
  beforeEach(() => {
    clearImageCoverageCache();
  });

  it('a path silhouette always wins over an alpha mask', () => {
    primeImageCoverageCache(SRC, bandMask());
    const sil = silhouetteFromPathPoints(
      [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }],
      false,
    );
    expect(rigCoverageMask('image', SRC, undefined, sil)).toBeUndefined();
  });

  it('non-image kinds never get an alpha mask', () => {
    primeImageCoverageCache(SRC, bandMask());
    expect(rigCoverageMask('shape', SRC, undefined, undefined)).toBeUndefined();
    expect(rigCoverageMask('text', SRC, undefined, undefined)).toBeUndefined();
  });

  it('assetId takes precedence over src as the cache key', () => {
    const mask = bandMask();
    primeImageCoverageCache('asset-7', mask);
    expect(rigCoverageMask('image', SRC, 'asset-7', undefined)).toBe(mask);
    // …and the bare src key is a miss, proving the key really was the assetId.
    expect(rigCoverageMask('image', SRC, undefined, undefined)).toBeUndefined();
  });

  it('an SVG layer meshes as an image', () => {
    expect(rigLayerKind('svg' as never)).toBe('image');
  });
});
