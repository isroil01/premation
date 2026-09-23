/**
 * B3z-a (layer operations + text): every migrated action is ONE engine batch —
 * one history entry, undo restores the document exactly, redo re-applies it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertSvgLayer } from '@core/scene/sceneInsert';
import { readSvgLayer } from '@core/svg/svgLayer';
import { getNodeMatte } from '@core/effects/matte';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useHistoryStore } from '@stores/historyStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { applyPresetValues, setLayerMatte } from './inspectorEdits';
import { convertSvgToShapes } from './svgLayerActions';
import { LAYER_SWITCHES, applyLayerSwitch } from './SelectionHeader';
import { masksFromTextEdit, textPresetEdit } from '@layout/Text/textEdits';
import { hasCanvas } from '@core/effects/__testHelpers__/canvasFidelity';
import { getNodeMask } from '@core/effects/mask';
import { replaceFootageFromPath } from './MediaSection';

let h: Awaited<ReturnType<typeof setupAppEngine>>;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

/** Run `act`, then pin: exactly one new entry named `label`, exact undo, exact redo. */
async function oneExactEntry(label: string, act: () => Promise<unknown> | unknown): Promise<void> {
  const n = historyLabels().length;
  const before = h.doc();
  await act();
  await engineIdle();
  expect(historyLabels()).toHaveLength(n + 1);
  expect(historyLabels().at(-1)).toBe(label);
  const after = h.doc();
  expect(after).not.toEqual(before);
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toEqual(after);
}

const textProps = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;

test('Layer Above (positional) track matte is one engine command', async () => {
  await oneExactEntry('Track Matte', () => setLayerMatte(s.A, { mode: 'luma', inverted: true }));
  expect(getNodeMatte(s.A)).toEqual({ mode: 'luma', inverted: true });
});

test('a Transform preset with Skew / Fill Opacity at default is one entry (latent bindings)', async () => {
  await oneExactEntry('Transform preset', () => applyPresetValues([s.A], { skew: 12, skewAxis: 30, fillOpacity: 50, rotation: 15 }, { seconds: 0 }, 'Transform preset'));
});

test('a text preset with font strings, keyword weight, Tracking, Leading and stroke order is one entry', async () => {
  await oneExactEntry('Apply Text preset', () => textPresetEdit([s.T], {
    fontFamily: 'Georgia', fontWeight: 'bold', fontStyle: 'italic', fontSize: 40,
    letterSpacing: 3, lineHeight: 1.4, strokeWidth: 2, strokeOverFill: true, fill: '#ff0000',
  }));
  const p = textProps(s.T);
  expect(p).toMatchObject({ fontFamily: 'Georgia', fontWeight: 700, fontStyle: 'italic', fontSize: 40, letterSpacing: 3, lineHeight: 1.4, strokeOrder: 'stroke-over-fill', strokeOverFill: true });
});

test('the layer motion-blur switch turns the comp master on in the same entry', async () => {
  useMotionBlurStore.getState().setEnabled(false);
  await engineIdle();
  const spec = LAYER_SWITCHES.find((t) => t.id === 'motionBlur')!;
  await oneExactEntry('Enable Motion blur', () => applyLayerSwitch([s.A], spec));
  expect(useMotionBlurStore.getState().enabled).toBe(true);
});

test('clearing the work area is one engine command', async () => {
  expect(getTimelineController().getWorkArea()).not.toBeNull();
  await oneExactEntry('Clear Work Area', () => edit('Clear Work Area', { type: 'clearWorkArea', comp: s.comp }));
});

test('Replace Footage with a file path not in the library imports it and re-points the layer, one entry', async () => {
  await oneExactEntry('Replace Footage', () => replaceFootageFromPath(s.V, 'C:/media/other.mp4'));
});

test('Replace Footage with a library file is replaceLayerSource', async () => {
  await oneExactEntry('Replace Footage', () => replaceFootageFromPath(s.V, 'C:/media/clip2.mp4').then((ok) => expect(ok).toBe(true)));
});

test('Convert SVG to Editable Shapes = pasteLayers + deleteLayers in one entry, in the SVG layer\'s slot', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="40" height="40" fill="#0af"/><circle cx="70" cy="70" r="20" fill="#f00"/></svg>';
  const id = insertSvgLayer(svg, 'two.svg')!;
  getTimelineController().syncFromScene();
  useHistoryStore.getState().flush(); // the legacy insert's own entry
  await engineIdle();
  expect(readSvgLayer(defaultSceneGraph.getNode(id)!)).not.toBeNull();
  let groupId: string | null = null;
  await oneExactEntry('Convert SVG to Editable Shapes', async () => { groupId = await convertSvgToShapes(id); });
  expect(groupId).not.toBeNull();
  expect(defaultSceneGraph.getNode(id)).toBeUndefined();
  expect(defaultSceneGraph.getChildren(groupId!).length).toBeGreaterThan(1);
});

const maybe = hasCanvas ? test : test.skip;
maybe('Create Masks from Text = pasteLayers (solid + glyph masks) + hide the text, one entry', async () => {
  await h.run({ type: 'setProperty', prop: { layer: s.T, path: 'text/sourceText' }, value: { kind: 'string', value: 'Hi' } });
  let made: Awaited<ReturnType<typeof masksFromTextEdit>> = null;
  await oneExactEntry('Create Masks from Text', async () => { made = await masksFromTextEdit(s.T, 0); });
  const r = made as Awaited<ReturnType<typeof masksFromTextEdit>>;
  expect(r).not.toBeNull();
  expect(r!.masks).toBeGreaterThan(0);
  expect(defaultSceneGraph.getNode(s.T)!.visible).toBe(false);
  expect(getNodeMask(r!.id).paths).toHaveLength(r!.masks);
});
