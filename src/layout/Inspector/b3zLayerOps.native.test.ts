/**
 * B3z-a (layer operations + text): every migrated action is ONE engine batch —
 * one history entry, undo restores the document exactly, redo re-applies it.
 */

import { insertSvgLayer } from '@core/scene/sceneInsert';
import { readSvgLayer } from '@core/svg/svgLayer';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { edit } from '@core/engine/uiEdits';
import { applyPresetValues, setLayerMatte } from './inspectorEdits';
import { convertSvgToShapes, revertSvgToLayer } from './svgLayerActions';
import { LAYER_SWITCHES, applyLayerSwitch } from './SelectionHeader';
import { textPresetEdit } from '@layout/Text/textEdits';
import { replaceFootageFromPath } from './MediaSection';
import { documentMirror } from '@stores/documentMirror';

let h: Awaited<ReturnType<typeof setupAppEngine>>;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

/** Run `act`, then pin: exactly one new entry named `label`, exact undo, exact redo. */
async function oneExactEntry(label: string, act: () => Promise<unknown> | unknown): Promise<void> {
  const n = (await historyLabels()).length;
  const before = (await h.doc());
  await act();
  await settleEdits();
  expect((await historyLabels())).toHaveLength(n + 1);
  expect((await historyLabels()).at(-1)).toBe(label);
  const after = (await h.doc());
  expect(after).not.toEqual(before);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toEqual(after);
}

const textProps = async (id: string): Promise<Record<string, unknown>> =>
  (await docView()).getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;

test('Layer Above (positional) track matte is one engine command', async () => {
  await oneExactEntry('Track Matte', () => setLayerMatte(s.A, { mode: 'luma', inverted: true }));
  expect((await docView()).getNodeMatte(s.A)).toEqual({ mode: 'luma', inverted: true });
});

test('a Transform preset with Skew / Fill Opacity at default is one entry (latent bindings)', async () => {
  await oneExactEntry('Transform preset', () => applyPresetValues([s.A], { skew: 12, skewAxis: 30, fillOpacity: 50, rotation: 15 }, { seconds: 0 }, 'Transform preset'));
});

test('a text preset with font strings, keyword weight, Tracking, Leading and stroke order is one entry', async () => {
  // The fields resolve against the layer's property tree (the Inspector has it loaded).
  await documentMirror().loadTree(s.T);
  await oneExactEntry('Apply Text preset', () => textPresetEdit([s.T], {
    fontFamily: 'Georgia', fontWeight: 'bold', fontStyle: 'italic', fontSize: 40,
    letterSpacing: 3, lineHeight: 1.4, strokeWidth: 2, strokeOverFill: true, fill: '#ff0000',
  }));
  const p = (await textProps(s.T));
  expect(p).toMatchObject({ fontFamily: 'Georgia', fontWeight: 700, fontStyle: 'italic', fontSize: 40, letterSpacing: 3, lineHeight: 1.4, strokeOrder: 'stroke-over-fill', strokeOverFill: true });
});

test('the layer motion-blur switch turns the comp master on in the same entry', async () => {
  useMotionBlurStore.getState().setEnabled(false);
  await settleEdits();
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
  await settleEdits();
  expect(readSvgLayer((await docView()).getNode(id)!)).not.toBeNull();
  let groupId: string | null = null;
  await oneExactEntry('Convert SVG to Editable Shapes', async () => { groupId = await convertSvgToShapes(id); });
  expect(groupId).not.toBeNull();
  expect((await docView()).getNode(id)).toBeUndefined();
  expect((await docView()).getChildren(groupId!).length).toBeGreaterThan(1);
  // The group keeps the source: Revert puts an SVG layer back in its slot, one entry.
  await settleEdits();
  expect(documentMirror().layer(groupId!)?.svg).toBe('converted');
  let backId: string | null = null;
  await oneExactEntry('Revert to Original SVG', async () => { backId = await revertSvgToLayer(groupId!); });
  expect(backId).not.toBeNull();
  expect((await docView()).getNode(groupId!)).toBeUndefined();
  expect(readSvgLayer((await docView()).getNode(backId!)!)!.sourceMarkup).toBe(svg);
});

