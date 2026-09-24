/**
 * The material library: what ships, what the user owns, and what a click on a
 * thumbnail is allowed to change.
 *
 * The three claims worth pinning are the three that were bugs in the surface
 * this replaces:
 *   • built-ins come from the ONE style-preset registry, so there is no second
 *     hard-coded copy of "Gold" to drift;
 *   • applying a material writes Material Options and nothing else — the old
 *     in-Transform grid wrote the fill too, from a panel that does not own it;
 *   • the document carries only the user's materials, so a project cannot
 *     freeze a snapshot of a registry that has since changed.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { DEFAULT_MATERIAL_PARAMS, readNodeMaterialParams } from '@core/scene/material';
import { STYLE_PRESETS } from '@core/style/stylePresets';
import {
  useMaterialStore,
  builtinMaterials,
  normalizeMaterials,
  applyMaterialToNodes,
} from './materialStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { values } from '@core/engine/propRefs';
import { catalogFor, readStatic } from '@core/engine/props';
import { getCommandSystem } from '@core/commands/CommandSystem';

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  useMaterialStore.setState({ materials: [] });
});

describe('built-in library', () => {
  it('is exactly the style registry’s material presets', () => {
    const fromRegistry = STYLE_PRESETS.filter((p) => p.category === 'material').map((p) => p.label);
    expect(builtinMaterials().map((m) => m.name)).toEqual(fromRegistry);
    expect(builtinMaterials().every((m) => m.builtin)).toBe(true);
  });

  it('carries each preset’s specular and shininess, and answers lights', () => {
    const gold = builtinMaterials().find((m) => m.id === 'builtin:gold')!;
    const preset = STYLE_PRESETS.find((p) => p.id === 'gold')!;
    expect(gold.params.specular).toBe(preset.specular);
    expect(gold.params.shininess).toBe(preset.shininess);
    // A surface description that cannot answer a light is inert.
    expect(gold.params.acceptsLights).toBe(true);
    // The preset's colour survives only as the thumbnail tint.
    expect(gold.swatch).toBe('#ffd700');
  });

  it('cannot be deleted', () => {
    useMaterialStore.getState().removeMaterial('builtin:gold');
    expect(useMaterialStore.getState().find('builtin:gold')).toBeDefined();
  });

  it('is not written to the document', () => {
    useMaterialStore.getState().addMaterial('Mine', DEFAULT_MATERIAL_PARAMS);
    const listed = useMaterialStore.getState().list();
    expect(listed.map((m) => m.name)).toEqual(['Mine']);
    expect(useMaterialStore.getState().all().length).toBe(builtinMaterials().length + 1);
  });
});

describe('project materials', () => {
  it('adds, renames and removes', () => {
    const added = useMaterialStore.getState().addMaterial('Hero glass', {
      ...DEFAULT_MATERIAL_PARAMS, shading: 'pbr', roughness: 3,
    });
    expect(useMaterialStore.getState().find(added.id)?.params.roughness).toBe(3);

    useMaterialStore.getState().renameMaterial(added.id, '  Frosted  ');
    expect(useMaterialStore.getState().find(added.id)?.name).toBe('Frosted');

    useMaterialStore.getState().removeMaterial(added.id);
    expect(useMaterialStore.getState().find(added.id)).toBeUndefined();
  });

  /** A library entry that kept moving with the layer it was saved from would
   *  not be a library entry. */
  it('copies the params it is handed', () => {
    const source = { ...DEFAULT_MATERIAL_PARAMS, metal: 10 };
    const added = useMaterialStore.getState().addMaterial('Snapshot', source);
    source.metal = 99;
    expect(useMaterialStore.getState().find(added.id)?.params.metal).toBe(10);
  });

  it('an empty name falls back rather than producing a nameless swatch', () => {
    const added = useMaterialStore.getState().addMaterial('   ', DEFAULT_MATERIAL_PARAMS);
    expect(added.name).toBe('Material');
    useMaterialStore.getState().renameMaterial(added.id, '  ');
    expect(useMaterialStore.getState().find(added.id)?.name).toBe('Material');
  });
});

describe('restore', () => {
  it('replaces the library wholesale, so a project cannot inherit another’s', () => {
    useMaterialStore.getState().addMaterial('Old', DEFAULT_MATERIAL_PARAMS);
    useMaterialStore.getState().restore([]);
    expect(useMaterialStore.getState().materials).toEqual([]);
  });

  it('repairs a hand-edited document instead of trusting it', () => {
    const out = normalizeMaterials([
      null,
      'nope',
      { id: 'builtin:gold', name: 'Impostor', params: {} },
      { name: '', params: { shading: 'toon', toonBands: 4, metal: 30 } },
      { id: 'dup', name: 'A', params: {} },
      { id: 'dup', name: 'B', params: {} },
    ]);
    expect(out).toHaveLength(4);
    // A document must not be able to shadow a shipped material.
    expect(out.every((m) => !m.id.startsWith('builtin:'))).toBe(true);
    expect(out.every((m) => !m.builtin)).toBe(true);
    expect(out[0]!.name).toBe('Impostor');
    expect(out[1]!.name).toBe('Material');
    expect(out[1]!.params.toonBands).toBe(4);
    // Two entries claiming one id become two ids, not one lost material.
    expect(new Set(out.map((m) => m.id)).size).toBe(4);
  });

  it('restores through the store', () => {
    useMaterialStore.getState().restore([{ id: 'm1', name: 'Rubber', params: { diffuse: 88 } }]);
    expect(useMaterialStore.getState().find('m1')?.params.diffuse).toBe(88);
  });
});

describe('applying to layers', () => {
  let h: Harness & { engine: LocalEngine };

  beforeEach(async () => {
    h = await setupAppEngine();
    useMaterialStore.setState({ materials: [] });
  });

  afterEach(async () => {
    await h.dispose();
  });

  /**
   * A 3D shape layer filled #3355ff (Material Options live on 3D layers), made
   * through the engine, with Accepts Lights off — the default material, as the
   * Material section's suite starts from.
   */
  async function addLayer(name: string): Promise<string> {
    const { layer } = await h.run({
      type: 'createLayer', comp: 'comp_root', kind: 'shape', name,
      init: [{ path: 'layer/fill', value: values.color(0x33 / 255, 0x55 / 255, 1) }],
    });
    await h.batch('setup', [
      { type: 'setLayerSwitches', layers: [layer], patch: { threeD: true } },
      { type: 'setProperty', prop: { layer, path: 'material/acceptsLights' }, value: values.scalar(0) },
    ]);
    getCommandSystem().getHistory().clear();
    return layer;
  }

  const fillOf = (id: string): unknown => readStatic(id, catalogFor(id).byPath.get('layer/fill')!);

  it('paints every given layer and leaves their other props alone — one undo entry', async () => {
    const a = await addLayer('a');
    const b = await addLayer('b');
    const fills = [fillOf(a), fillOf(b)];
    expect(fills[0]).toEqual(values.color(0x33 / 255, 0x55 / 255, 1));
    const added = useMaterialStore.getState().addMaterial('Chrome', {
      ...DEFAULT_MATERIAL_PARAMS, shading: 'pbr', metal: 100, roughness: 8, specular: 90,
    });
    const before = h.doc();

    expect(await applyMaterialToNodes([a, b], added.id)).toBe(true);
    await engineIdle();
    for (const id of [a, b]) {
      const m = readNodeMaterialParams(id)!;
      expect(m.shading).toBe('pbr');
      expect(m.metal).toBe(100);
      expect(m.specular).toBe(90);
    }
    expect([fillOf(a), fillOf(b)]).toEqual(fills);
    expect(historyLabels()).toEqual(['Apply material Chrome']);

    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(before);
  });

  it('reports an unknown material rather than silently succeeding', async () => {
    const a = await addLayer('a');
    expect(readNodeMaterialParams(a)).toEqual(DEFAULT_MATERIAL_PARAMS);
    expect(await applyMaterialToNodes([a], 'mat_nope')).toBe(false);
    await engineIdle();
    expect(readNodeMaterialParams(a)).toEqual(DEFAULT_MATERIAL_PARAMS);
    expect(historyLabels()).toEqual([]);
  });

  it('applies a built-in by id', async () => {
    const a = await addLayer('a');
    expect(await applyMaterialToNodes([a], 'builtin:steel')).toBe(true);
    await engineIdle();
    const steel = builtinMaterials().find((m) => m.id === 'builtin:steel')!;
    expect(readNodeMaterialParams(a)).toEqual(steel.params);
  });
});
