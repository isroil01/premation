/**
 * WS-L1 (B3z-b): every layer-creating builder the editor migrated onto
 * `insertBuiltLayers` passes the off-document guard (it only ADDS layers to
 * the target composition) and lands as ONE undo entry; undo restores the
 * document exactly and redo reapplies it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertCamera, insertLight, insertPrimitive, insertShape, insertText } from '@core/scene/sceneInsert';
import { buildSolidLayer } from '@core/scene/layerSettings';
import { buildMographItem, MOGRAPH_ITEMS } from '@core/library/mographLibrary';
import { buildLottieItem, LOTTIE_ITEMS } from '@core/library/lottieLibrary';
import { insertCursorItem, CURSOR_ITEMS } from '@core/library/cursorLibrary';
import { insertUiComponent, UI_COMPONENTS } from '@core/library/uiKitLibrary';
import { insertAnimPreset, ANIM_PRESETS } from '@core/template/animPresets';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readMatte, setNodeMatte } from '@core/effects/matte';
import { useSelectionStore } from '@stores/selectionStore';
import { useTemplateStore } from '@stores/templateStore';
import { TEMPLATES } from '@core/template/registry';
import { setupAppEngine, historyLabels } from '../__testHelpers__/appEngine';
import { buildScene } from '../__testHelpers__/scene';
import type { Harness } from '../__testHelpers__/harness';
import type { LocalEngine } from '../LocalEngine';
import { insertBuiltLayers } from '../offDocument';
import { layerIdsOfComp } from '../doc';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => {
  h = await setupAppEngine();
  await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

async function roundTrip(label: string, build: () => unknown): Promise<string[]> {
  const doc = h.doc();
  const entries = historyLabels().length;
  const ids = await insertBuiltLayers(label, 'comp_root', build);
  expect(ids).not.toBeNull();
  expect(ids!.length).toBeGreaterThan(0);
  expect(historyLabels().length).toBe(entries + 1);
  expect(historyLabels().at(-1)).toBe(label);
  const after = h.doc();
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(doc);
  await h.run({ type: 'redo' });
  expect(h.doc()).toEqual(after);
  return ids!;
}

const kinds = (ids: string[]): string[] => ids.map((id) => readNodeKind(defaultSceneGraph.getNode(id)!));

it('shape, text and primitive presets', async () => {
  expect(kinds(await roundTrip('Insert Star', () => insertShape('star', 'Star')))).toEqual(['shape']);
  expect(kinds(await roundTrip('Insert Title', () => insertText('Title', 96, 800, { fill: '#ff0000' })))).toEqual(['text']);
  expect(kinds(await roundTrip('New Shape Layer', () => insertPrimitive('shape', 'Shape')))).toEqual(['shape']);
});

it('a camera and ONE light from the dialogs (AE: no ambient fill)', async () => {
  const [cam] = await roundTrip('New Camera', () => insertCamera({ name: 'Cam', focalLength: 1200, twoNode: true }));
  const t = defaultSceneGraph.getNode(cam!)!.components.find((c) => c.type === 'Transform')!.props;
  expect(t.focalLength).toBe(1200);
  expect(t.poiX).toBeDefined();
  const lights = await roundTrip('New Light', () => insertLight({ name: 'Key', type: 'spot', intensity: 80, color: '#ff8800', coneAngle: 30, ambientFill: false }));
  expect(lights).toHaveLength(1);
  const lt = defaultSceneGraph.getNode(lights[0]!)!.components.find((c) => c.type === 'Transform')!.props;
  expect([lt.lightType, lt.intensity, lt.lightCone]).toEqual(['spot', 80, 30]);
});

it('a solid from Solid Settings', async () => {
  const [id] = await roundTrip('New Solid', () => buildSolidLayer({ name: 'Matte', width: 400, height: 300, color: '#00ff00' }));
  expect(defaultSceneGraph.getNode(id!)!.name).toBe('Matte');
});

it('library items: motion graphic, Lottie, cursor, UI kit, animation preset', async () => {
  await roundTrip('Insert MG', () => buildMographItem(MOGRAPH_ITEMS[0]!.id));
  await roundTrip('Insert Lottie', () => buildLottieItem(LOTTIE_ITEMS[0]!.id));
  await roundTrip('Insert Cursor', () => insertCursorItem(CURSOR_ITEMS[0]!.id, 200, 200));
  await roundTrip('Insert UI', () => insertUiComponent(UI_COMPONENTS[0]!.id, 300, 300));
  await roundTrip('Insert Preset', () => insertAnimPreset(ANIM_PRESETS[0]!.id, 400, 400));
});

it('a Lottie with parenting and track mattes keeps them on the pasted copies', async () => {
  // Every bundled item whose importer produced links: the copies' links point at copies.
  let parented = 0;
  for (const item of LOTTIE_ITEMS) {
    const ids = await insertBuiltLayers(`Insert ${item.name}`, 'comp_root', () => buildLottieItem(item.id));
    const set = new Set(ids!);
    for (const id of ids!) {
      const n = defaultSceneGraph.getNode(id)!;
      if (n.parent !== 'comp_root') { expect(set.has(n.parent!)).toBe(true); parented += 1; }
      const fx = n.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
      const m = readMatte(fx?.matte);
      if (m?.sourceId) expect(set.has(m.sourceId)).toBe(true);
    }
  }
  expect(parented).toBeGreaterThan(0);
});

it('a track matte between built layers follows the copies (a library rig with a matte)', async () => {
  const ids = await insertBuiltLayers('Insert Rig', 'comp_root', () => {
    insertShape('rect', 'Matte');
    const matte = useSelectionStore.getState().ids[0]!;
    insertText('Fill');
    const fill = useSelectionStore.getState().ids[0]!;
    setNodeMatte(fill, { mode: 'alpha', inverted: false, sourceId: matte });
  });
  const [matte2, fill2] = ids!.map((id) => defaultSceneGraph.getNode(id)!).sort((a, b) => (a.name === 'Matte' ? -1 : b.name === 'Matte' ? 1 : 0));
  const fx = fill2!.components.find((c) => c.type === 'fx')!.props as Record<string, unknown>;
  expect(readMatte(fx.matte)?.sourceId).toBe(matte2!.id);
});

it('a template: comp settings + layers as ONE entry; the fields follow the new ids; undo is exact', async () => {
  const t = TEMPLATES[0]!;
  const doc = h.doc();
  const entries = historyLabels().length;
  await useTemplateStore.getState().apply(t.id);
  expect(historyLabels().length).toBe(entries + 1);
  const active = useTemplateStore.getState().active!;
  const stack = new Set(layerIdsOfComp('comp_root'));
  for (const f of active.fields) expect(stack.has(f.target.nodeId)).toBe(true);
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(doc);
  useTemplateStore.getState().exit();
});
