/**
 * WS-L1 (B3z-b): pasteLayers `parent` (paste into a layer — Premation groups
 * nest) and the references BETWEEN pasted layers following the copies (AE:
 * parenting, track mattes; here every stored layer reference, remapLayerRefs).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertShape } from '@core/scene/sceneInsert';
import { setupAppEngine } from '../__testHelpers__/appEngine';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import type { Harness } from '../__testHelpers__/harness';
import type { LocalEngine } from '../LocalEngine';
import { buildLayerFragment, insertBuiltLayers } from '../offDocument';
import { layerIdsOfComp } from '../doc';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

const fxProps = (id: string): Record<string, unknown> =>
  (defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'fx')?.props ?? {}) as Record<string, unknown>;

describe('pasteLayers parent', () => {
  it('pastes the fragment into a group; undo is exact, redo reapplies', async () => {
    // G is the top row (A was the top layer), A right under it.
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A], name: 'G' });
    const frag = await h.query({ type: 'copyLayers', layers: [s.B, s.T] });
    const doc = h.doc();
    const { layers } = await h.run({ type: 'pasteLayers', comp: s.comp, fragment: frag, parent: G, index: 1 });
    expect(layers).toHaveLength(2);
    for (const id of layers) expect(defaultSceneGraph.getNode(id)!.parent).toBe(G);
    // Index 1 of the comp's stack: inside G, above A.
    const stack = layerIdsOfComp(s.comp);
    expect(stack.indexOf(layers[0]!)).toBe(1);
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(doc);
    await h.run({ type: 'redo' });
    expect(defaultSceneGraph.getNode(layers[1]!)!.parent).toBe(G);
  });

  it('refuses a parent in another composition', async () => {
    const frag = await h.query({ type: 'copyLayers', layers: [s.A] });
    const res = await h.engine.execute({ type: 'pasteLayers', comp: s.comp, fragment: frag, parent: s.c2layer });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalidArgument');
  });

  it('places a nested fragment at a deep index among the OTHER layers', async () => {
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' });
    const frag = await h.query({ type: 'copyLayers', layers: [G] });
    const { layers } = await h.run({ type: 'pasteLayers', comp: s.comp, fragment: frag, index: 4 });
    const stack = layerIdsOfComp(s.comp);
    // Four existing layers above the pasted group, its two children right under it.
    expect(stack.indexOf(layers[0]!)).toBe(4);
    expect(stack.slice(5, 7).sort()).toEqual([layers[1], layers[2]].sort());
  });

  it('keeps the copied stacking: tops and each group’s children (AE)', async () => {
    const name = (id: string): string => defaultSceneGraph.getNode(id)!.name ?? '';
    const f1 = await h.query({ type: 'copyLayers', layers: [s.A, s.B] });
    await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: f1 });
    expect(layerIdsOfComp(s.comp2).map(name)).toEqual(['A', 'B', 'C2 solid']);
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' });
    const f2 = await h.query({ type: 'copyLayers', layers: [G] });
    const { layers: [g2] } = await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: f2 });
    expect(defaultSceneGraph.getChildOrder(g2!).map(name)).toEqual(defaultSceneGraph.getChildOrder(G).map(name));
  });

  it('buildLayerFragment inserts into the group the builder built into', async () => {
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.P], name: 'G' });
    const doc = h.doc();
    const build = (): void => {
      insertShape('rect', 'Inside');
      const id = defaultSceneGraph.getChildOrder('comp_root').at(-1)!;
      defaultSceneGraph.setParent(id, G, { preserveWorld: false });
    };
    const frag = buildLayerFragment(s.comp, build);
    expect(frag?.parent).toBe(G);
    const ids = await insertBuiltLayers('Insert', s.comp, build);
    expect(defaultSceneGraph.getNode(ids![0]!)!.parent).toBe(G);
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(doc);
  });
});

describe('pasteLayers reference remap', () => {
  it('points every stored reference to a pasted layer at its copy, keeps the others', async () => {
    // B is matted by A; B's effects take A (Set Matte) and the outside layer T (Displacement Map).
    await h.run({ type: 'setTrackMatte', layer: s.B, matte: { layer: s.A, mode: 'alpha' } });
    const { groups: [sm] } = await h.run({ type: 'addEffect', layers: [s.B], effect: 'set-matte', params: [] });
    await h.run({ type: 'setProperty', prop: { layer: s.B, path: `${sm}/matteLayerId` }, value: { kind: 'layer', value: s.A } });
    const { groups: [dm] } = await h.run({ type: 'addEffect', layers: [s.B], effect: 'displacement-map', params: [] });
    await h.run({ type: 'setProperty', prop: { layer: s.B, path: `${dm}/mapLayerId` }, value: { kind: 'layer', value: s.T } });
    // Stores no command writes yet: cloner, audio driver, clone-stamp strokes.
    const n = defaultSceneGraph.getNode(s.B)!;
    const fx = n.components.find((c) => c.type === 'fx')!;
    const t = n.components.find((c) => c.type === 'Transform')!;
    defaultSceneGraph.writeProp(s.B, fx.id, '__cloner', { enabled: true, mode: 'path', pathLayerId: s.A, falloff: { source: 'layer', layerId: s.T } });
    defaultSceneGraph.writeProp(s.B, t.id, '__audioDriver', { scale: { prop: 'scale', sourceLayerId: s.A }, opacity: { prop: 'opacity', sourceLayerId: 'mix' } });
    defaultSceneGraph.setPaint(s.B, { strokes: [{ id: 'st1', cloneSourceId: s.A }, { id: 'st2', cloneSourceId: s.T }] });
    await h.run({ type: 'renameLayer', layer: s.B, name: 'B' }); // resync after the direct writes

    const frag = await h.query({ type: 'copyLayers', layers: [s.A, s.B] });
    const doc = h.doc();
    const { layers: [a2, b2] } = await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: frag });
    const p = fxProps(b2!);
    expect((p.matte as { sourceId: string }).sourceId).toBe(a2);
    const effects = p.effects as Array<{ type: string; params: Record<string, unknown> }>;
    expect(effects.find((e) => e.type === 'set-matte')!.params.matteLayerId).toBe(a2);
    expect(effects.find((e) => e.type === 'displacement-map')!.params.mapLayerId).toBe(s.T);
    const cloner = p.__cloner as { pathLayerId: string; falloff: { layerId: string } };
    expect(cloner.pathLayerId).toBe(a2);
    expect(cloner.falloff.layerId).toBe(s.T);
    const tProps = defaultSceneGraph.getNode(b2!)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
    const drivers = tProps.__audioDriver as Record<string, { sourceLayerId: string }>;
    expect(drivers.scale!.sourceLayerId).toBe(a2);
    expect(drivers.opacity!.sourceLayerId).toBe('mix');
    const strokes = (p.paint as { strokes: Array<{ cloneSourceId: string }> }).strokes;
    expect(strokes.map((x) => x.cloneSourceId)).toEqual([a2, s.T]);
    // The originals are untouched.
    expect((fxProps(s.B).matte as { sourceId: string }).sourceId).toBe(s.A);
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(doc);
  });

  it('remaps a plugin layer\'s layer-valued props', async () => {
    expect(defaultSceneGraph.addComponent(s.B, { id: `${s.B}_pl`, type: 'pluginLayer:acme.depth', props: { __kind: 'acme.depth', depthMap: s.A, other: s.T, __pluginId: s.A } })).toBe(true);
    await h.run({ type: 'renameLayer', layer: s.B, name: 'B' });
    const frag = await h.query({ type: 'copyLayers', layers: [s.A, s.B] });
    const { layers: [a2, b2] } = await h.run({ type: 'pasteLayers', comp: s.comp, fragment: frag });
    const pl = defaultSceneGraph.getNode(b2!)!.components.find((c) => c.type === 'pluginLayer:acme.depth')!.props as Record<string, unknown>;
    expect(pl.depthMap).toBe(a2);
    expect(pl.other).toBe(s.T);
    expect(pl.__pluginId).toBe(s.A); // reserved keys are never references
  });
});
