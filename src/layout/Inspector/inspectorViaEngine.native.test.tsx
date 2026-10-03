/**
 * B3 inspector migration — the Inspector writes through the engine API
 * (docs/B3_PATTERNS.md). Pinned on the app engine (`setupAppEngine`, the real
 * history) through the real sections and helpers:
 *
 *   • one entry per user action (a typed value, a scrub, a button), undo
 *     restores the document exactly, redo reapplies;
 *   • Scale crosses the API in percent (AE units) and lands as the stored
 *     multiplier the field shows — Linked Scale writes W and H as ONE Scale value;
 *   • anchor presets, align, layer switches, parenting, matte, motion path.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { clearHistory, setupAppEngine, historyLabels, settleEdits, storedTrack } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { TransformSection } from './TransformSection';
import { InspectorSelectionProvider } from './inspectorSelection';
import { alignLayers, keyToggleCommands, motionPathCommands, parentLayer, setLayerMatte, setLayersSwitch, stopwatchCommands, valueCommands } from './inspectorEdits';
import { edit } from '@core/engine/uiEdits';

jest.useFakeTimers();

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine({ panels: true });
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  s = await buildScene(h);
  await clearHistory();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await settleEdits(); }); };
/** A track's value at 0 s in stored units, as the engine evaluates it. */
const stored = (id: string, prop: string): Promise<number | undefined> => storedTrack(id, prop, 0);

function renderTransform(ids: string[]): void {
  render(
    <InspectorSelectionProvider nodeIds={ids}>
      <TransformSection nodeId={ids[0]!} />
    </InspectorSelectionProvider>,
  );
}

async function typeInto(name: string, value: string): Promise<void> {
  const field = screen.getByRole('spinbutton', { name });
  fireEvent.keyDown(field, { key: 'Enter' });
  const input = field.querySelector('input')!;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await idle();
}

test('a typed Scale (shown in %, stored as a multiplier) crosses the API in percent and lands as the stored multiplier; Linked Scale is one entry; undo/redo exact', async () => {
  renderTransform([s.A]);
  // The field reads "100%", not the stored 1.
  expect(screen.getByRole('spinbutton', { name: 'Scale X' }).textContent).toContain('100');
  const before = (await h.doc());
  await typeInto('Scale X', '150');
  expect(await stored(s.A, 'scaleX')).toBeCloseTo(1.5);
  // Linked (the default): H follows W in the SAME write.
  expect(await stored(s.A, 'scaleY')).toBeCloseTo(1.5);
  expect((await historyLabels())).toEqual(['Set Scale X']);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
  await h.run({ type: 'redo' });
  expect(await stored(s.A, 'scaleX')).toBeCloseTo(1.5);
});

test('a typed Position X on an animated layer keys at the playhead (setValueAtTime), one entry', async () => {
  renderTransform([s.B]);
  const keys = (await docView()).getTrackKeyframes(s.B, 'x')!.length;
  await typeInto('Position X', '777');
  // Playhead at 0 = the first key: replaced, not added.
  expect((await docView()).getTrackKeyframes(s.B, 'x')!.length).toBe(keys);
  expect(await stored(s.B, 'x')).toBeCloseTo(777);
  expect((await historyLabels())).toHaveLength(1);
});

test('an anchor preset snaps every selected layer as ONE entry', async () => {
  renderTransform([s.A, s.B]);
  fireEvent.click(screen.getByRole('button', { name: 'Anchor presets' }));
  fireEvent.click(screen.getByRole('button', { name: 'Snap anchor to Top Left' }));
  await idle();
  expect(await stored(s.A, 'anchorX')).toBeLessThan(0);
  expect(await stored(s.B, 'anchorX')).toBeLessThan(0);
  expect((await historyLabels())).toEqual(['Set Anchor Point']);
});

test('the value / stopwatch / diamond builders round-trip through undo', async () => {
  const before = (await h.doc());
  await edit('Animate Rotation', stopwatchCommands([s.A], ['rotation'], 0));
  expect((await docView()).isAnimated(s.A, 'rotation')).toBe(true);
  await edit('Set Rotation', valueCommands([{ nodeId: s.A, values: { rotation: 45 } }], { seconds: 0 }));
  expect(await stored(s.A, 'rotation')).toBeCloseTo(45);
  // Diamond at 0 removes the key there; the property stays animated only if other keys exist.
  await edit('Remove Rotation keyframe', await keyToggleCommands([s.A], ['rotation'], 0));
  expect((await historyLabels())).toEqual(['Animate Rotation', 'Set Rotation', 'Remove Rotation keyframe']);
  for (let i = 0; i < 3; i++) await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
});

test('align left moves the selection as ONE "Align" entry', async () => {
  await edit('', valueCommands([{ nodeId: s.A, values: { x: 100 } }, { nodeId: s.P, values: { x: 900 } }], { seconds: 0 }));
  await clearHistory();
  await alignLayers([s.A, s.P], 'left', 'selection', 1920, 1080);
  await idle();
  expect((await historyLabels())).toEqual(['Align']);
  expect(await stored(s.P, 'x')).not.toBeCloseTo(900);
});

test('layer switches, parent and matte are one entry each and undo exactly', async () => {
  const before = (await h.doc());
  await setLayersSwitch([s.A, s.B], { motionBlur: true }, 'Enable Motion blur');
  parentLayer(s.A, s.P);
  await idle();
  expect((await docView()).getNode(s.A)?.parent).toBe(s.P);
  setLayerMatte(s.B, { mode: 'luma', inverted: true, sourceId: s.V });
  await idle();
  expect((await docView()).getNodeMatte(s.B)).toEqual({ mode: 'luma', inverted: true, sourceId: s.V });
  expect((await historyLabels())).toEqual(['Enable Motion blur', 'Parent', 'Track Matte']);
  for (let i = 0; i < 3; i++) await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
});

test('smooth then straighten the motion path, one entry each', async () => {
  // A third key so the smooth has a middle vertex to curve through.
  await edit('', { type: 'addKeyframes', keys: [{ prop: { layer: s.B, path: 'transform/position' }, time: 2 * 705_600_000, value: { kind: 'vec2', value: { x: 500, y: 100 } }, spatialIn: [], spatialOut: [] }] });
  await clearHistory();
  await edit('Smooth motion path', await motionPathCommands(s.B, 'smooth'));
  expect(((await docView()).getTrackKeyframes(s.B, 'x') ?? []).some((k) => (k.so ?? 0) !== 0 || (k.si ?? 0) !== 0)).toBe(true);
  await edit('Straighten motion path', await motionPathCommands(s.B, 'straighten'));
  expect(((await docView()).getTrackKeyframes(s.B, 'x') ?? []).every((k) => k.si === undefined && k.so === undefined)).toBe(true);
  expect((await historyLabels())).toEqual(['Smooth motion path', 'Straighten motion path']);
});
