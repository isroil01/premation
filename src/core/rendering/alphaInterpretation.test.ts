/**
 * Alpha interpretation, end to end: asset setting → snapshot → FrameScene.
 *
 * The shader half is covered in packages/renderer (premultipliedAlpha.test.ts).
 * This is the half that decides WHICH draws get it, and the properties that
 * matter there are about scope rather than colour:
 *
 *   • it is a per-FILE statement, so one correction fixes every layer using that
 *     footage — including layers in other compositions;
 *   • straight (the default, and every existing project) must be bit-identical
 *     to before the feature existed;
 *   • it must survive the paths where a layer stops being a plain 2D quad — 3D,
 *     extrusion, effects — because that is where flat-quad assumptions have
 *     repeatedly leaked in this renderer.
 */

import { setExtrusionMeshPath } from '@core/scene/extrusionMesh';
import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { useAssetStore } from '@stores/assetStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const W = 800;
const H = 600;
const ASSET = 'alpha-asset';

function node(id: string, parent: string | null, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'image', x: 400, y: 300, width: 200, height: 200, ...props } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
    ],
  } as unknown as SceneNode;
}

const comp = (id: string): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
} as unknown as SceneNode);

function setAlpha(mode: 'straight' | 'premultiplied'): void {
  useAssetStore.setState({
    assets: [{
      id: ASSET, type: 'image', src: 'alpha://clip.png',
      metadata: { width: 100, height: 100, hasAlpha: true },
      interpret: { alpha: mode },
    } as never],
  });
}

/** Layer ids in `rootId` whose snapshot entry is flagged premultiplied. */
function premulLayers(g: SceneGraph, rootId: string): string[] {
  const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    width: W, height: H, background: '#000', rootId,
  } as never);
  return s.layers.filter((l) => l.premultipliedSource).map((l) => l.id);
}

afterEach(() => useAssetStore.setState({ assets: [] }));

describe('the interpretation is a statement about the FILE', () => {
  /** Two comps, each with a layer pointing at the SAME asset. */
  function twoComps(): SceneGraph {
    const g = new SceneGraph();
    g.addNode(comp('rootA'));
    g.addNode(comp('rootB'));
    g.addChild('rootA', node('a', 'rootA', { assetId: ASSET, src: 'alpha://clip.png' }));
    g.addChild('rootB', node('b', 'rootB', { assetId: ASSET, src: 'alpha://clip.png' }));
    return g;
  }

  it('reaches layers in EVERY composition using that footage', () => {
    const g = twoComps();
    setAlpha('premultiplied');
    expect(premulLayers(g, 'rootA')).toEqual(['a']);
    expect(premulLayers(g, 'rootB')).toEqual(['b']);
  });

  it('changing it back clears every layer, in both comps', () => {
    const g = twoComps();
    setAlpha('premultiplied');
    expect(premulLayers(g, 'rootA')).toHaveLength(1);
    setAlpha('straight');
    expect(premulLayers(g, 'rootA')).toHaveLength(0);
    expect(premulLayers(g, 'rootB')).toHaveLength(0);
  });

  it('a layer pointing at a DIFFERENT asset is unaffected', () => {
    const g = twoComps();
    g.addChild('rootA', node('other', 'rootA', { assetId: 'someone-else', src: 'x://other.png' }));
    setAlpha('premultiplied');
    expect(premulLayers(g, 'rootA')).toEqual(['a']);
  });
});

describe('straight is the default and changes nothing', () => {
  const withAlpha = (mode?: 'straight' | 'premultiplied') => {
    const g = new SceneGraph();
    g.addNode(comp('root'));
    g.addChild('root', node('l', 'root', { assetId: ASSET, src: 'alpha://clip.png' }));
    if (mode) setAlpha(mode);
    else useAssetStore.setState({ assets: [{ id: ASSET, type: 'image', src: 'alpha://clip.png', metadata: { width: 100, height: 100 } } as never] });
    return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
      width: W, height: H, background: '#000', rootId: 'root',
    } as never);
  };

  it('an asset with NO interpretation set is not premultiplied', () => {
    // The regression guard for every existing project: absent must mean straight.
    expect(withAlpha().layers.find((l) => l.id === 'l')!.premultipliedSource).toBeUndefined();
  });

  it('explicitly straight is identical to absent', () => {
    expect(withAlpha('straight').layers.find((l) => l.id === 'l')!.premultipliedSource).toBeUndefined();
  });

  it('the flag is ABSENT rather than false, so nothing else in the layer moves', () => {
    // Emitting `premultipliedSource: false` would change every layer's shape and
    // every snapshot comparison in the suite, for no gain.
    const l = withAlpha('straight').layers.find((x) => x.id === 'l')!;
    expect(Object.prototype.hasOwnProperty.call(l, 'premultipliedSource')).toBe(false);
  });

  it('a layer with no asset at all is untouched', () => {
    const g = new SceneGraph();
    g.addNode(comp('root'));
    g.addChild('root', node('bare', 'root', {}));
    setAlpha('premultiplied');
    expect(premulLayers(g, 'root')).toHaveLength(0);
  });
});

describe('it survives the non-flat-quad paths', () => {
  const build = (extra: Record<string, unknown>) => {
    const g = new SceneGraph();
    g.addNode(comp('root'));
    g.addChild('root', node('l', 'root', { assetId: ASSET, src: 'alpha://clip.png', ...extra }));
    setAlpha('premultiplied');
    return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
      width: W, height: H, background: '#000', rootId: 'root',
    } as never);
  };

  it('a 3D layer keeps the flag', () => {
    const l = build({ z: 0, rotationX: 0, rotationY: 20 }).layers.find((x) => x.id === 'l')!;
    expect(l.premultipliedSource).toBe(true);
    expect(l.world3d).toBeDefined();
  });

  it('an EXTRUDED layer flags its TEXTURED faces and not its solid walls', () => {
    // An extruded layer is two kinds of surface. The front face and the back cap
    // sample the layer's own image, so they need the divide. The side walls are
    // synthesized geometry filled with a flat colour — there is no texture to
    // un-premultiply, and flagging them would select a shader variant that
    // divides a solid fill by its own alpha for nothing.
    //
    // Pinned as a pair rather than "all faces", because the interesting failure
    // is the back CAP silently losing it: it is the one synthesized surface that
    // is textured, so premultiplied footage would fringe on the back of an
    // extruded object only, which reads as a lighting artefact.
    //
    // On the MESH path the body is one carrier layer (`::ext-mesh`): its back
    // cap range samples the image, so the carrier keeps the flag and the
    // layer's source; its walls are solid ranges of the same mesh and select
    // nothing on their own.
    const layers = build({ z: 0, rotationX: 0, rotationY: 20, extrusionDepth: 40 }).layers;
    const textured = layers.filter((l) => l.src);

    expect(textured.map((l) => l.id).sort()).toEqual(['l', 'l::ext-mesh']);
    for (const t of textured) expect(t.premultipliedSource).toBe(true);
    const body = layers.find((l) => l.id === 'l::ext-mesh')!;
    expect(body.extrudedMesh).toBeDefined();
    expect(body.extrudedMesh!.ranges.some((r) => r.role === 'back' && r.textured)).toBe(true);
    expect(body.extrudedMesh!.ranges.filter((r) => r.role === 'side').every((r) => !r.textured)).toBe(true);
  });

  it('the quad-synthesis FALLBACK flags its textured faces and not its solid walls', () => {
    setExtrusionMeshPath(false);
    try {
      const layers = build({ z: 0, rotationX: 0, rotationY: 20, extrusionDepth: 40 }).layers;
      const textured = layers.filter((l) => l.src);
      const walls = layers.filter((l) => l.id.startsWith('l::ext') && !l.src);
      expect(textured.map((l) => l.id).sort()).toEqual(['l', 'l::ext-back']);
      for (const t of textured) expect(t.premultipliedSource).toBe(true);
      expect(walls.length).toBeGreaterThan(0);
      for (const w of walls) expect(w.premultipliedSource).toBeUndefined();
    } finally {
      setExtrusionMeshPath(true);
    }
  });

  it('stops at the snapshot — the FrameScene renderable does NOT carry it', () => {
    // It used to, and that was the point: the flag selected one of six `-premul`
    // shader variants. Under the alpha invariant (see `TextureSource` in
    // packages/renderer/src/gpu/types.ts) every texture is premultiplied by the
    // time it is sampled, so the shader path is uniform and there is nothing for
    // a per-draw flag to select. The flag now goes to the TEXTURE FEED instead —
    // MotionRendererBackend hands it to `setImage`, which carries it to the
    // upload where it decides whether the browser multiplies.
    //
    // Asserting its ABSENCE here is what stops it being quietly re-added to the
    // renderable and read by nothing.
    const fs = snapshotToFrameScene(build({}));
    const r = fs.renderables.find((x) => x.id === 'l');
    expect(r).toBeDefined();
    expect((r as unknown as Record<string, unknown>).premultipliedSource).toBeUndefined();
  });

  it('the snapshot layer still carries it, because the feed reads it there', () => {
    const l = build({}).layers.find((x) => x.id === 'l')!;
    expect(l.premultipliedSource).toBe(true);
    // And the texture key the feed uses must exist, or the flag has nowhere to go.
    expect(l.src).toBeTruthy();
  });
});
