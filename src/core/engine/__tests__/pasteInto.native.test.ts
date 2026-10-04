/**
 * WS-L1 (B3z-b): pasteLayers `parent` (paste into a layer — Premation groups
 * nest) and the references BETWEEN pasted layers following the copies (AE:
 * parenting, track mattes; here every stored layer reference, remapLayerRefs).
 */

import type { SceneNode } from '@core/types';
import { insertFragment } from '@/engine-client/insertFragment';
import { setupAppEngine, settleEdits } from '../__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import type { Harness } from '../__testHelpers__/appEngine';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

/** A shape layer pasted with stored layer references (fx / Transform props, extra components). */
async function refLayer(o: { fx?: Record<string, unknown>; transform?: Record<string, unknown>; extra?: Array<{ id: string; type: string; props: Record<string, unknown> }> }): Promise<string> {
  const ids = await insertFragment('Fixture', (b) => b.addChild(s.comp, {
    id: 'ref', name: 'B', parent: s.comp, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'ref_t', type: 'Transform', props: { __kind: 'shape', x: 0, y: 0, rotation: 0, width: 100, height: 100, ...o.transform } },
      ...(o.fx ? [{ id: 'ref_fx', type: 'fx', props: o.fx }] : []),
      ...(o.extra ?? []),
    ],
  } as unknown as SceneNode), { comp: s.comp, noSelect: true });
  await settleEdits();
  return ids![0]!;
}

const fxProps = async (id: string): Promise<Record<string, unknown>> =>
  ((await docView()).getNode(id)!.components.find((c) => c.type === 'fx')?.props ?? {}) as Record<string, unknown>;

describe('pasteLayers parent', () => {
  it('pastes the fragment into a group; undo is exact, redo reapplies', async () => {
    // G is the top row (A was the top layer), A right under it.
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A], name: 'G' });
    const frag = await h.query({ type: 'copyLayers', layers: [s.B, s.T] });
    const doc = (await h.doc());
    const { layers } = await h.run({ type: 'pasteLayers', comp: s.comp, fragment: frag, parent: G, index: 1 });
    expect(layers).toHaveLength(2);
    for (const id of layers) expect((await docView()).getNode(id)!.parent).toBe(G);
    // Index 1 of the comp's stack: inside G, above A.
    const stack = (await docView()).layerIdsOfComp(s.comp);
    expect(stack.indexOf(layers[0]!)).toBe(1);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toEqual(doc);
    await h.run({ type: 'redo' });
    expect((await docView()).getNode(layers[1]!)!.parent).toBe(G);
  });

  it('refuses a parent in another composition', async () => {
    const frag = await h.query({ type: 'copyLayers', layers: [s.A] });
    const res = await h.client.execute({ type: 'pasteLayers', comp: s.comp, fragment: frag, parent: s.c2layer });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalidArgument');
  });

  it('places a nested fragment at a deep index among the OTHER layers', async () => {
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' });
    const frag = await h.query({ type: 'copyLayers', layers: [G] });
    const { layers } = await h.run({ type: 'pasteLayers', comp: s.comp, fragment: frag, index: 4 });
    const stack = (await docView()).layerIdsOfComp(s.comp);
    // Four existing layers above the pasted group, its two children right under it.
    expect(stack.indexOf(layers[0]!)).toBe(4);
    expect(stack.slice(5, 7).sort()).toEqual([layers[1], layers[2]].sort());
  });

  it('keeps the copied stacking: tops and each group’s children (AE)', async () => {
    const names = async (ids: string[]): Promise<string[]> => {
      const v = await docView();
      return ids.map((id) => v.getNode(id)!.name ?? '');
    };
    const f1 = await h.query({ type: 'copyLayers', layers: [s.A, s.B] });
    await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: f1 });
    expect(await names((await docView()).layerIdsOfComp(s.comp2))).toEqual(['A', 'B', 'C2 solid']);
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' });
    const f2 = await h.query({ type: 'copyLayers', layers: [G] });
    const { layers: [g2] } = await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: f2 });
    expect(await names((await docView()).getChildOrder(g2!))).toEqual(await names((await docView()).getChildOrder(G)));
  });
});

describe('pasteLayers reference remap', () => {
  it('points every stored reference to a pasted layer at its copy, keeps the others', async () => {
    // B carries every store that names another layer: the cloner, the audio driver
    // and clone-stamp strokes (stored references no command writes yet, pasted as
    // the document holds them), then a matte and two effects through the engine.
    const B = await refLayer({
      fx: { __cloner: { enabled: true, mode: 'path', pathLayerId: s.A, falloff: { source: 'layer', layerId: s.T } },
        paint: { strokes: [{ id: 'st1', cloneSourceId: s.A }, { id: 'st2', cloneSourceId: s.T }] } },
      transform: { __audioDriver: { scale: { prop: 'scale', sourceLayerId: s.A }, opacity: { prop: 'opacity', sourceLayerId: 'mix' } } },
    });
    // B is matted by A; B's effects take A (Set Matte) and the outside layer T (Displacement Map).
    await h.run({ type: 'setTrackMatte', layer: B, matte: { layer: s.A, mode: 'alpha' } });
    const { groups: [sm] } = await h.run({ type: 'addEffect', layers: [B], effect: 'set-matte', params: [] });
    await h.run({ type: 'setProperty', prop: { layer: B, path: `${sm}/matteLayerId` }, value: { kind: 'layer', value: s.A } });
    const { groups: [dm] } = await h.run({ type: 'addEffect', layers: [B], effect: 'displacement-map', params: [] });
    await h.run({ type: 'setProperty', prop: { layer: B, path: `${dm}/mapLayerId` }, value: { kind: 'layer', value: s.T } });

    const frag = await h.query({ type: 'copyLayers', layers: [s.A, B] });
    const doc = (await h.doc());
    const { layers: [a2, b2] } = await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: frag });
    const p = (await fxProps(b2!));
    expect((p.matte as { sourceId: string }).sourceId).toBe(a2);
    const effects = p.effects as Array<{ type: string; params: Record<string, unknown> }>;
    expect(effects.find((e) => e.type === 'set-matte')!.params.matteLayerId).toBe(a2);
    expect(effects.find((e) => e.type === 'displacement-map')!.params.mapLayerId).toBe(s.T);
    const cloner = p.__cloner as { pathLayerId: string; falloff: { layerId: string } };
    expect(cloner.pathLayerId).toBe(a2);
    expect(cloner.falloff.layerId).toBe(s.T);
    const tProps = (await docView()).getNode(b2!)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
    const drivers = tProps.__audioDriver as Record<string, { sourceLayerId: string }>;
    expect(drivers.scale!.sourceLayerId).toBe(a2);
    expect(drivers.opacity!.sourceLayerId).toBe('mix');
    const strokes = (p.paint as { strokes: Array<{ cloneSourceId: string }> }).strokes;
    expect(strokes.map((x) => x.cloneSourceId)).toEqual([a2, s.T]);
    // The originals are untouched.
    expect(((await fxProps(B)).matte as { sourceId: string }).sourceId).toBe(s.A);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toEqual(doc);
  });

  it('remaps a plugin layer\'s layer-valued props', async () => {
    const B = await refLayer({ extra: [{ id: 'ref_pl', type: 'pluginLayer:acme.depth', props: { __kind: 'acme.depth', depthMap: s.A, other: s.T, __pluginId: s.A } }] });
    const frag = await h.query({ type: 'copyLayers', layers: [s.A, B] });
    const { layers: [a2, b2] } = await h.run({ type: 'pasteLayers', comp: s.comp, fragment: frag });
    const pl = (await docView()).getNode(b2!)!.components.find((c) => c.type === 'pluginLayer:acme.depth')!.props as Record<string, unknown>;
    expect(pl.depthMap).toBe(a2);
    expect(pl.other).toBe(s.T);
    expect(pl.__pluginId).toBe(s.A); // reserved keys are never references
  });
});
