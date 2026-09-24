/**
 * B3 inspector migration, second slice: the Fill & Stroke preset, Group /
 * Detach Parts, the Style Presets grid and the Parent & Link JUMP go through
 * the engine API. Pinned on the app engine (`setupAppEngine`, the real
 * history): one entry per user action, the document state it lands, and undo
 * restoring the document exactly.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { readPropertyValue } from '@core/inspector/multiSelection';
import { getNodeFill, getNodeFills } from '@core/paint/fill';
import { getNodeStroke, getNodeStrokes } from '@core/paint/stroke';
import { getNodeLayerStyles } from '@core/effects/layerStyles';
import { getNodeBlend } from '@core/effects/blendMode';
import { stylePreset } from '@core/style/stylePresets';
import { useSelectionStore } from '@stores/selectionStore';
import { applyAppearancePresetEdit, groupSelection, ungroupNode } from './AppearanceSection';
import { StylePresetsSection, stylePresetCommands } from './StylePresetsSection';
import { parentLayer } from './inspectorEdits';
import { edit } from '@core/engine/uiEdits';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  s = await buildScene(h);
  useSelectionStore.getState().set([]);
  getCommandSystem().getHistory().clear();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const parentOf = (id: string): string | null | undefined => defaultSceneGraph.getNode(id)?.parent;
const stored = (id: string, prop: string): number | undefined => readPropertyValue(id, prop, 0);

test('a Fill & Stroke preset over the selection is ONE entry: solid fill, stroke patched from the default; undo exact', async () => {
  const before = h.doc();
  await applyAppearancePresetEdit([s.A, s.B], { fillColor: '#ff0000', 'stroke.enabled': true, 'stroke.width': 7, 'stroke.color': '#00ff00' });
  expect(historyLabels()).toEqual(['Apply Fill & Stroke preset']);
  for (const id of [s.A, s.B]) {
    expect(getNodeFill(id)).toEqual({ type: 'solid', color: '#ff0000' });
    expect(getNodeStroke(id)).toMatchObject({ enabled: true, width: 7, color: '#00ff00' });
  }
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('an empty preset fill colour removes the primary fill', async () => {
  await applyAppearancePresetEdit([s.B], { fillColor: '#123456' });
  await applyAppearancePresetEdit([s.B], { fillColor: '' });
  // The fill PAINT is gone (`layer/fillPaint` null); the layer falls back to its base colour.
  const { values: [v] } = await h.query({ type: 'getPropertyValues', props: [{ layer: s.B, path: 'layer/fillPaint' }], time: 0, evaluated: false });
  expect(v?.value).toEqual({ kind: 'json', value: 'null' });
  expect(historyLabels()).toEqual(['Apply Fill & Stroke preset', 'Apply Fill & Stroke preset']);
});

test('Group Parts on siblings is groupLayers: ONE entry, the group selected; undo exact', async () => {
  const before = h.doc();
  await groupSelection([s.A, s.B]);
  const group = parentOf(s.A)!;
  expect(group).not.toBe(s.comp);
  expect(parentOf(s.B)).toBe(group);
  expect(defaultSceneGraph.getNode(group)?.name).toBe('Group Assembly');
  expect(useSelectionStore.getState().ids).toEqual([group]);
  expect(historyLabels()).toEqual(['Group Layers']);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('Group Parts across parents moves the nested layers to the root keeping their world pose, then groups — ONE entry; undo exact', async () => {
  await h.run({ type: 'setParent', layers: [s.A], parent: s.P, keepWorldTransform: true });
  await h.run({ type: 'setProperty', prop: { layer: s.P, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 300, y: 200 } } });
  getCommandSystem().getHistory().clear();
  const world = async (): Promise<number[]> => (await h.query({ type: 'getLayerTransforms', layers: [s.A], time: 0 })).transforms[0]!.matrix;
  const worldBefore = await world();
  const before = h.doc();
  await groupSelection([s.A, s.T]);
  const group = parentOf(s.A)!;
  expect(group).not.toBe(s.P);
  expect(parentOf(s.T)).toBe(group);
  expect(parentOf(group)).toBe(s.comp);
  expect(historyLabels()).toEqual(['Group Layers']);
  expect(useSelectionStore.getState().ids).toEqual([group]);
  const worldAfter = await world();
  worldBefore.forEach((v, i) => expect(worldAfter[i]).toBeCloseTo(v, 3));
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('Detach Parts on a group layer is ungroupLayer: ONE entry, the parts selected; undo exact', async () => {
  const { layer: group } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' }) as { layer: string };
  getCommandSystem().getHistory().clear();
  const before = h.doc();
  await ungroupNode(group, [s.A, s.B]);
  expect(defaultSceneGraph.getNode(group)).toBeUndefined();
  expect(parentOf(s.A)).toBe(s.comp);
  expect(parentOf(s.B)).toBe(s.comp);
  expect([...useSelectionStore.getState().ids].sort()).toEqual([s.A, s.B].sort());
  expect(historyLabels()).toEqual(['Ungroup']);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('Detach Parts on a parent that is not a group moves its children to the root and deletes it — ONE entry; undo exact', async () => {
  await h.run({ type: 'setParent', layers: [s.A], parent: s.P, keepWorldTransform: true });
  getCommandSystem().getHistory().clear();
  const before = h.doc();
  await ungroupNode(s.P, [s.A]);
  expect(defaultSceneGraph.getNode(s.P)).toBeUndefined();
  expect(parentOf(s.A)).toBe(s.comp);
  expect(useSelectionStore.getState().ids).toEqual([s.A]);
  expect(historyLabels()).toEqual(['Ungroup']);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('a style preset the engine addresses whole is ONE entry: fills, strokes, styles, blend, corners; undo exact', async () => {
  // A style the preset does not state is removed (a preset is a complete look).
  await h.run({ type: 'addPropertyGroup', layer: s.A, parent: 'styles', matchName: 'style:innerGlow', init: [] });
  getCommandSystem().getHistory().clear();
  const before = h.doc();
  const preset = stylePreset('sticker')!;
  const node = defaultSceneGraph.getNode(s.A)!;
  const plan = stylePresetCommands(s.A, node.components.find((c) => c.type === 'Style'), preset, '#2b7eff', 0);
  expect(plan.unaddressed).toEqual([]);
  const res = await edit('Apply Sticker Style', plan.cmds);
  expect(res.ok).toBe(true);
  expect(historyLabels()).toEqual(['Apply Sticker Style']);
  expect(getNodeFills(s.A)).toEqual(preset.fills('#2b7eff'));
  expect(getNodeStrokes(s.A).map((x) => [x.color, x.width])).toEqual(preset.strokes!('#2b7eff').map((x) => [x.color, x.width]));
  const st = getNodeLayerStyles(s.A);
  expect(st.innerGlow).toBeUndefined();
  expect(st.dropShadow).toMatchObject({ enabled: true, color: '#000000', distance: 10, angle: 90, blur: 12 });
  expect(st.dropShadow!.opacity).toBeCloseTo(0.45);
  // Left out of the preset = off in the stored object, not the new-style default (on).
  expect(st.dropShadow!.useGlobalLight).toBeFalsy();
  expect(getNodeBlend(s.A)).toBe('normal');
  for (const t of ['cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL']) expect(stored(s.A, t)).toBe(16);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('Glass sets the backdrop blur and switching away clears it; a 3D layer takes a material preset — each ONE entry, undo exact', async () => {
  const style = () => defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Style');
  const before = h.doc();
  const glass = stylePresetCommands(s.A, style(), stylePreset('glass')!, '#2b7eff', 0);
  expect(glass.unaddressed).not.toContain('backdropBlur');
  expect((await edit('Apply Glass Style', glass.cmds)).ok).toBe(true);
  expect(stored(s.A, 'backdropBlur')).toBe(stylePreset('glass')!.backdropBlur);
  const sticker = stylePresetCommands(s.A, style(), stylePreset('sticker')!, '#2b7eff', 0);
  expect((await edit('Apply Sticker Style', sticker.cmds)).ok).toBe(true);
  expect(stored(s.A, 'backdropBlur')).toBeUndefined();
  await h.run({ type: 'undo' });
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);

  await h.run({ type: 'setLayerSwitches', layers: [s.B], patch: { threeD: true } });
  const gold = stylePreset('gold')!;
  const bStyle = defaultSceneGraph.getNode(s.B)!.components.find((c) => c.type === 'Style');
  const plan = stylePresetCommands(s.B, bStyle, gold, '#2b7eff', 0);
  expect(plan.unaddressed).not.toEqual(expect.arrayContaining(['specular']));
  expect((await edit('Apply Gold Style', plan.cmds)).ok).toBe(true);
  expect(stored(s.B, 'specular')).toBe(gold.specular);
  expect(stored(s.B, 'shininess')).toBe(gold.shininess);
});

test('clicking a style swatch applies it as ONE entry named for the preset', async () => {
  render(<StylePresetsSection nodeId={s.A} />);
  fireEvent.click(screen.getByTitle(/^Neon — Hollow shape/));
  await idle();
  expect(historyLabels()).toEqual(['Apply Neon Style']);
  expect(getNodeBlend(s.A)).toBe('screen');
  expect(getNodeLayerStyles(s.A).outerGlow).toMatchObject({ enabled: true, size: 26 });
});

test('Shift-parent (Parent & Link JUMP) is setParent{jump}: ONE entry, the child lands on the parent anchor; undo exact', async () => {
  await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 420, y: 310 } } });
  getCommandSystem().getHistory().clear();
  expect(stored(s.A, 'x')).toBeCloseTo(420);
  const before = h.doc();
  parentLayer(s.A, s.P, { shiftKey: true });
  await idle();
  expect(parentOf(s.A)).toBe(s.P);
  expect(stored(s.A, 'x')).toBeCloseTo(0);
  expect(stored(s.A, 'y')).toBeCloseTo(0);
  expect(historyLabels()).toEqual(['Parent']);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});
