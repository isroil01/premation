/**
 * Model import layout: glTF nodes → 3D nulls, primitives → mesh leaf layers,
 * root fitted to the comp (scale to ~60% of the short side, anchored on the
 * model's bounding-box centre so the pivot is the model's own middle).
 */

import { parseGltf } from '@core/media/gltf';
import { buildModelLayout, bytesToDataUrl, glbFromModelFiles } from './modelImport';
import { registerModel, clearModelRegistry, modelKeyForBytes } from './modelMesh';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildQuadGlb, buildExternalGltfSet } from '@/__testHelpers__/buildTestGlb';
import { GltfSidecarError } from '@core/media/gltf';

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

describe('glbFromModelFiles — a .gltf and the files beside it', () => {
  afterEach(() => clearModelRegistry());

  it('resolves sidecars by BARE NAME, which is what a flat multi-select gives', () => {
    const set = buildExternalGltfSet();
    const glb = glbFromModelFiles([
      { name: 'scene.gltf', bytes: set.gltf },
      { name: 'scene.bin', bytes: set.bin },
      { name: 'albedo.png', bytes: set.png },
    ]);
    const parsed = parseGltf(glb);
    expect(Array.from(parsed.meshes[0]!.primitives[0]!.positions)).toEqual(set.positions);
    expect(Array.from(parsed.images[0]!.bytes)).toEqual(Array.from(new Uint8Array(set.png)));
  });

  it('resolves a folder drop against the MODEL’s own directory', () => {
    // `textures/albedo.png` means what it says relative to the .gltf, so the
    // dropped folder's own prefix has to be stripped first.
    const set = buildExternalGltfSet('data.bin', 'textures/albedo.png');
    const glb = glbFromModelFiles([
      { name: 'scene.gltf', path: 'robot/scene.gltf', bytes: set.gltf },
      { name: 'data.bin', path: 'robot/data.bin', bytes: set.bin },
      { name: 'albedo.png', path: 'robot/textures/albedo.png', bytes: set.png },
    ]);
    expect(parseGltf(glb).images).toHaveLength(1);
  });

  it('names the file that is missing rather than failing vaguely', () => {
    const set = buildExternalGltfSet();
    let err: unknown;
    try {
      glbFromModelFiles([
        { name: 'scene.gltf', bytes: set.gltf },
        { name: 'albedo.png', bytes: set.png },
      ]);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GltfSidecarError);
    expect((err as GltfSidecarError).missing).toEqual(['scene.bin']);
  });

  it('passes a .glb through untouched even when other files came with it', () => {
    const glb = buildQuadGlb();
    const out = glbFromModelFiles([
      { name: 'notes.txt', bytes: new ArrayBuffer(4) },
      { name: 'model.glb', bytes: glb },
    ]);
    expect(new Uint8Array(out)).toEqual(new Uint8Array(glb));
  });

  it('refuses a selection with no model in it', () => {
    expect(() => glbFromModelFiles([{ name: 'albedo.png', bytes: new ArrayBuffer(4) }]))
      .toThrow(/No \.glb or \.gltf/);
  });
});
