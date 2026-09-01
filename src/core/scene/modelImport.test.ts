/**
 * Model import layout: glTF nodes → 3D nulls, primitives → mesh leaf layers,
 * root fitted to the comp (scale to ~60% of the short side, anchored on the
 * model's bounding-box centre so the pivot is the model's own middle).
 */

import { parseGltf } from '@core/media/gltf';
import { buildModelLayout, bytesToDataUrl } from './modelImport';
import { registerModel, clearModelRegistry, modelKeyForBytes } from './modelMesh';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildQuadGlb } from '@/__testHelpers__/buildTestGlb';

describe('buildModelLayout', () => {
  afterEach(() => clearModelRegistry());

  it('maps nodes to 3D nulls and primitives to model leafs, fitted to the comp', () => {
    const glb = buildQuadGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    const layout = buildModelLayout(parseGltf(glb), key, { width: 800, height: 600 });

    // glTF: root null → leaf null → quad primitive leaf.
    expect(layout.specs).toHaveLength(3);
    expect(layout.specs[0]).toMatchObject({ parent: -1, name: 'root', kind: 'null' });
    expect(layout.specs[1]).toMatchObject({ parent: 0, name: 'leaf', kind: 'null' });
    const prim = layout.specs[2]!;
    expect(prim).toMatchObject({ parent: 1, name: 'quad', kind: 'shape', model: { mesh: 0, prim: 0 } });
    expect(prim.style).toMatchObject({ fill: '#ff0000ff' });
    // Every layer in the tree is 3D (z prop present) so the mesh path engages.
    expect(prim.props.z).toBe(0);
    expect(layout.specs[0]!.props.z).toBe(0);
    expect(prim.props[SCENE_KIND_PROP]).toBe('shape');

    // Quad spans 2 units; short side 600 → fit 0.6·600/2 = 180, centred with
    // the anchor on the (origin-centred) bbox middle.
    expect(layout.fitScale).toBeCloseTo(180);
    expect(layout.rootProps).toMatchObject({
      x: 400, y: 300, scaleX: layout.fitScale, scaleY: layout.fitScale, scaleZ: layout.fitScale,
    });
    expect(layout.rootProps.anchorX as number).toBeCloseTo(0);
    expect(layout.rootProps.anchorY as number).toBeCloseTo(0);
  });

  it('bytesToDataUrl round-trips through fetch-style base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const url = bytesToDataUrl(bytes);
    expect(url).toMatch(/^data:model\/gltf-binary;base64,/);
    const decoded = Uint8Array.from(atob(url.split(',')[1]!), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([0, 1, 2, 250, 251, 252]);
  });
});
