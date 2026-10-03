/**
 * B3 effects migration: every Effects-area edit goes through the engine API
 * (docs/B3_PATTERNS.md). Pinned through the real EffectStack / LayerStyles /
 * TimeControls components where the gesture matters, and through the edit
 * functions (effectEdits.ts) for the rest:
 *
 *   • one undo entry per click / typed value / scrub / reorder, named as the
 *     user reads it in Edit ▸ Undo;
 *   • undo restores the document exactly, redo reapplies;
 *   • effects are addressed by their stable id (undoing a remove brings the
 *     SAME id back, a reorder moves the id not an index).
 */

import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { clearHistory, setupAppEngine, historyLabels, trackRef, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { edit } from '@core/engine/uiEdits';
import { effectDefFor, readNodeFxEnabled, paramsOf, effectOpacityPath } from '@core/effects/effects';
import { clearEffectClipboard } from '@core/effects/effectClipboard';
import { BUILTIN_EFFECT_PRESETS } from '@core/effects/builtinEffectPresets';
import { readNodeLayerStyles } from '@core/effects/layerStyles';

/** The layer's styles as the engine stores them. */
const stylesOf = async (id: string) => readNodeLayerStyles((await docView()).getNode(id)!) ?? {};
import { getNodeMask, rectangleMask } from '@core/effects/mask';
import { useCompositionStore } from '@stores/compositionStore';
import { EffectStack } from './EffectStack';
import { LayerStylesControls } from './LayerStylesControls';
import {
  addEffectEdit,
  addMaskEdit,
  applyEffectPresetEdit,
  duplicateEffectEdit,
  dropEffectEdit,
  effectOpacityCommands,
  effectOpacityStopwatchEdit,
  enableSimulationEdit,
  globalLightCommands,
  layerStretchCommands,
  maskValueCommands,
  paramCommands,
  patchLayerStyleEdit,
  copyEffectsEdit,
  pasteEffectsEdit,
  removeMaskEdit,
  renameMaskEdit,
  resetEffectEdit,
  setEffectLabelColorEdit,
  setEffectMaskEdit,
  setEffectOpacityEdit,
  setFrameBlendEdit,
  setFreezeFrameEdit,
  setFreezeTimeEdit,
  setLayerEffectsEnabledEdit,
  setLayerStyleOnEdit,
  setMaskVertexFeatherEdit,
  setMaskInvertedEdit,
  setMaskModeEdit,
  setMaskShapeAnimatedEdit,
} from './effectEdits';

jest.useFakeTimers();

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine({ panels: true });
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  s = await buildScene(h);
  clearEffectClipboard();
  await clearHistory();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await settleEdits(); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };
const redo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'redo' }); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const fxOf = async (layer: string, type: string) => (await docView()).getNodeEffects(layer).find((e) => e.type === type);

function pointer(type: string, x: number, target: EventTarget = window): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  });
}
async function scrub(field: HTMLElement, xs: number[]): Promise<void> {
  pointer('pointerdown', 0, field);
  for (const x of xs) pointer('pointermove', x);
  pointer('pointerup', xs[xs.length - 1]!);
  await idle();
}
async function typeInto(name: string, value: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole('spinbutton', { name }), { key: 'Enter' });
  const input = screen.getByRole('textbox', { name });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await idle();
}

// ── Add ────────────────────────────────────────────────────────────────

test('adding an effect to several layers is ONE entry named after the effect', async () => {
  const groups = await addEffectEdit([s.A, s.B], 'gaussian-blur');
  expect(groups).toHaveLength(2);
  expect((await fxOf(s.A, 'gaussian-blur'))).toBeDefined();
  expect((await fxOf(s.B, 'gaussian-blur'))).toBeDefined();
  settle();
  expect((await historyLabels())).toEqual(['Add Gaussian Blur']);
  await undo();
  expect((await fxOf(s.A, 'gaussian-blur'))).toBeUndefined();
  expect((await fxOf(s.B, 'gaussian-blur'))).toBeUndefined();
});

// ── Parameter controls (EffectStack) ──────────────────────────────────

describe('EffectStack parameter rows', () => {
  beforeEach(async () => {
    await addEffectEdit([s.A], 'gaussian-blur'); // the last effect: its card is open
    await clearHistory();
  });

  test('a scrub of a numeric param is ONE entry; undo/redo walk it exactly', async () => {
    render(<EffectStack nodeId={s.A} />);
    const before = (await h.doc());
    const start = paramsOf((await fxOf(s.A, 'gaussian-blur'))!).blurriness as number;
    await scrub(screen.getByRole('spinbutton', { name: 'Gaussian Blur Blurriness' }), [10, 20, 30, 40]);
    const after = paramsOf((await fxOf(s.A, 'gaussian-blur'))!).blurriness as number;
    expect(after).toBeGreaterThan(start);
    settle();
    expect((await historyLabels())).toEqual(['Set Gaussian Blur Blurriness']);
    await undo();
    expect((await h.doc())).toEqual(before);
    await redo();
    expect(paramsOf((await fxOf(s.A, 'gaussian-blur'))!).blurriness).toBeCloseTo(after);
  });

  test('a typed value is one entry', async () => {
    render(<EffectStack nodeId={s.A} />);
    await typeInto('Gaussian Blur Blurriness', '42');
    expect(paramsOf((await fxOf(s.A, 'gaussian-blur'))!).blurriness).toBe(42);
    settle();
    expect((await historyLabels())).toEqual(['Set Gaussian Blur Blurriness']);
  });

  test('the stopwatch animates (one entry); a typed value then keys at the playhead', async () => {
    render(<EffectStack nodeId={s.A} />);
    const fx = (await fxOf(s.A, 'gaussian-blur'))!;
    const track = `effect.${fx.id}.blurriness`;
    const watch = screen.getByRole('button', { name: 'Enable Blurriness animation' });
    await act(async () => { fireEvent.click(watch); await settleEdits(); });
    expect((await docView()).isAnimated(s.A, track)).toBe(true);
    await typeInto('Gaussian Blur Blurriness', '77');
    const keys = (await docView()).getTrackKeyframes(s.A, track)!;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.value).toBe(77);
    settle();
    expect((await historyLabels())).toEqual(['Animate Gaussian Blur Blurriness', 'Set Gaussian Blur Blurriness']);
  });

  test('a checkbox param is a bool write, one entry', async () => {
    render(<EffectStack nodeId={s.A} />);
    const box = screen.getByLabelText('Gaussian Blur Repeat Edge Pixels') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => { fireEvent.click(box); await settleEdits(); });
    expect(paramsOf((await fxOf(s.A, 'gaussian-blur'))!).repeatEdge).toBe(false);
    settle();
    expect((await historyLabels())).toEqual(['Set Gaussian Blur Repeat Edge Pixels']);
  });

  test('the header: disable, reorder, reset and remove are one entry each; ids are stable', async () => {
    render(<EffectStack nodeId={s.A} />);
    const blur = (await fxOf(s.A, 'gaussian-blur'))!.id;
    const disable = screen.getAllByTitle('Disable effect');
    await act(async () => { fireEvent.click(disable[disable.length - 1]!); await settleEdits(); });
    expect((await docView()).getNodeEffects(s.A).find((e) => e.id === blur)!.enabled).toBe(false);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move Gaussian Blur up' })); await settleEdits(); });
    expect((await docView()).getNodeEffects(s.A).map((e) => e.id)).toEqual([blur, s.fx]);

    await act(async () => { await edit('x', paramCommands(s.A, blur, effectDefFor('gaussian-blur')!.params[0]!, 99, 0)); });
    await clearHistory();
    await act(async () => { await resetEffectEdit(s.A, blur, 'Gaussian Blur'); });
    expect(paramsOf((await docView()).getNodeEffects(s.A).find((e) => e.id === blur)!).blurriness).toBe(10);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Gaussian Blur' })); await settleEdits(); });
    expect((await docView()).getNodeEffects(s.A).some((e) => e.id === blur)).toBe(false);
    settle();
    expect((await historyLabels())).toEqual(['Reset Gaussian Blur', 'Remove Gaussian Blur']);
    await undo();
    // Undo brings back the SAME effect id, where it was.
    expect((await docView()).getNodeEffects(s.A).map((e) => e.id)).toEqual([blur, s.fx]);
  });
});

test('the enum menu writes the option (stored as its number), one entry', async () => {
  await addEffectEdit([s.A], 'echo');
  await clearHistory();
  render(<EffectStack nodeId={s.A} />);
  const menu = screen.getByLabelText('Echo Echo Operator') as HTMLSelectElement;
  await act(async () => { fireEvent.change(menu, { target: { value: '3' } }); await settleEdits(); });
  const stored = paramsOf((await fxOf(s.A, 'echo'))!).echoOperator;
  expect(stored).toBe(3);
  settle();
  expect((await historyLabels())).toEqual(['Set Echo Echo Operator']);
});

test('colour, layer-picker and curve params go through setProperty', async () => {
  const glow = effectDefFor('glow')!;
  await act(async () => { await edit('Set Glow Color', paramCommands(s.A, s.fx, glow.params.find((p) => p.key === 'color')!, '#ff0000', 0)); });
  expect(String(paramsOf((await fxOf(s.A, 'glow'))!).color).toLowerCase()).toMatch(/^#ff0000/);

  await addEffectEdit([s.A], 'displacement-map');
  const dm = (await fxOf(s.A, 'displacement-map'))!;
  const mapLayer = effectDefFor('displacement-map')!.params.find((p) => p.type === 'layer')!;
  await act(async () => { await edit('Set Map Layer', paramCommands(s.A, dm.id, mapLayer, s.B, 0)); });
  expect(paramsOf((await fxOf(s.A, 'displacement-map'))!)[mapLayer.key]).toBe(s.B);

  await addEffectEdit([s.A], 'curves');
  const cv = (await fxOf(s.A, 'curves'))!;
  const pts = effectDefFor('curves')!.params.find((p) => p.type === 'curve')!;
  await act(async () => { await edit('Set Curve', paramCommands(s.A, cv.id, pts, [[0, 0], [128, 200], [255, 255]], 0)); });
  expect(paramsOf((await fxOf(s.A, 'curves'))!)[pts.key]).toEqual([[0, 0], [128, 200], [255, 255]]);
});

test('an animated colour param keys all four channels at the playhead, one entry', async () => {
  const color = effectDefFor('glow')!.params.find((p) => p.key === 'color')!;
  await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `effects/${s.fx}/color` }, animated: true, time: 0 });
  await clearHistory();
  await act(async () => { await edit('Set Glow Color', paramCommands(s.A, s.fx, color, '#00ff00', 1)); });
  const g = (await docView()).getTrackKeyframes(s.A, `effect.${s.fx}.color_g`)!;
  expect(g).toHaveLength(2);
  expect(g.some((k) => Math.abs(k.value - 1) < 1e-6)).toBe(true);
  expect((await historyLabels())).toEqual(['Set Glow Color']);
});

// ── Stack operations ──────────────────────────────────────────────────

test('a drag-and-drop reorder is one entry and moves the effect by id', async () => {
  await addEffectEdit([s.A], 'gaussian-blur');
  await addEffectEdit([s.A], 'echo');
  const ids = (await docView()).getNodeEffects(s.A).map((e) => e.id);
  await clearHistory();
  await act(async () => { await dropEffectEdit(s.A, ids[2]!, 0); });
  expect((await docView()).getNodeEffects(s.A).map((e) => e.id)).toEqual([ids[2], ids[0], ids[1]]);
  // A drop into its own gap does nothing.
  await act(async () => { await dropEffectEdit(s.A, ids[0]!, 2); });
  expect((await historyLabels())).toEqual(['Reorder Effects']);
  await undo();
  expect((await docView()).getNodeEffects(s.A).map((e) => e.id)).toEqual(ids);
});

test('duplicate copies the effect and its keyframes under a new id, one entry', async () => {
  await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `effects/${s.fx}/radius` }, animated: true, time: 0 });
  await clearHistory();
  await act(async () => { await duplicateEffectEdit(s.A, s.fx, 'Glow'); });
  const list = (await docView()).getNodeEffects(s.A);
  expect(list).toHaveLength(2);
  const copy = list[1]!;
  expect(copy.id).not.toBe(s.fx);
  expect((await docView()).isAnimated(s.A, `effect.${copy.id}.radius`)).toBe(true);
  expect((await historyLabels())).toEqual(['Duplicate Glow']);
});

test('copy / paste onto another layer is ONE engine entry with the keyframes; a stale clipboard falls back', async () => {
  await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `effects/${s.fx}/radius` }, animated: true, time: 0 });
  expect(await copyEffectsEdit(s.A, [s.fx])).toBe(1);
  await clearHistory();
  await act(async () => { await pasteEffectsEdit([s.B]); });
  const pasted = (await fxOf(s.B, 'glow'))!;
  expect(pasted).toBeDefined();
  expect((await docView()).isAnimated(s.B, `effect.${pasted.id}.radius`)).toBe(true);
  settle();
  expect((await historyLabels())).toEqual(['Paste Effect']);
  await undo();
  expect((await fxOf(s.B, 'glow'))).toBeUndefined();

  // The source changed since the copy: the clipboard is a snapshot the API
  // cannot paste yet — the legacy snapshot paste still lands the COPIED state.
  expect(await copyEffectsEdit(s.A)).toBeGreaterThan(0);
  const radius = paramsOf((await fxOf(s.A, 'glow'))!).radius;
  await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.A, path: `effects/${s.fx}` }] });
  await act(async () => { await pasteEffectsEdit([s.B]); });
  expect(paramsOf((await fxOf(s.B, 'glow'))!).radius).toBe(radius);
});

/** A preset's effects as data: each one's type and the params it sets. */
const presetEffects = (name: string) =>
  BUILTIN_EFFECT_PRESETS.find((p) => p.name === name)!.items.map((i) => ({ type: i.effect.type, params: i.effect.params }));

test('a built-in effect preset is ONE engine entry carrying the preset\'s effects', async () => {
  await act(async () => { expect(await applyEffectPresetEdit('Neon Edge', [s.B])).toBe(true); });
  settle();
  expect((await historyLabels())).toEqual(['Apply Neon Edge']);
  const applied = (await docView()).getNodeEffects(s.B).map((e) => ({ type: e.type, params: paramsOf(e) }));
  expect(applied).toMatchObject(presetEffects('Neon Edge'));
  await undo();
  expect((await docView()).getNodeEffects(s.B)).toHaveLength(0);
});

test('EVERY built-in preset applies through the engine as one entry, its effects and params intact', async () => {
  const fellBack: string[] = [];
  const differ: string[] = [];
  for (const preset of BUILTIN_EFFECT_PRESETS) {
    await clearHistory();
    await act(async () => { await applyEffectPresetEdit(preset.name, [s.B]); });
    if ((await historyLabels()).join() !== `Apply ${preset.name}`) fellBack.push(preset.name);
    const applied = (await docView()).getNodeEffects(s.B);
    const want = presetEffects(preset.name);
    const same = applied.length === want.length && want.every((w, i) => applied[i]!.type === w.type
      && Object.entries(w.params ?? {}).every(([k, v]) => k === 'vibrance' || JSON.stringify(paramsOf(applied[i]!)[k]) === JSON.stringify(v)));
    if (!same) differ.push(`${preset.name}: ${JSON.stringify(applied.map((e) => ({ type: e.type, params: paramsOf(e) })))}`);
    if (applied.length > 0) await h.run({ type: 'removePropertyGroups', groups: applied.map((e) => ({ layer: s.B, path: `effects/${e.id}` })) });
  }
  expect(differ).toEqual([]);
  // Cinematic Grade sets `vibrance` on Lumetri, a key Lumetri does not declare
  // (a dead value in the preset data, skipped above): `addEffect` cannot carry
  // an undeclared param, so that preset is a `pasteEffects` of its snapshot —
  // still ONE "Apply" entry, so nothing falls back.
  expect(fellBack).toEqual([]);
});

// ── Compositing Options ───────────────────────────────────────────────

test('Effect Opacity: an animated value keys through the engine; a static one keeps the legacy writer', async () => {
  expect(effectOpacityCommands(s.A, s.fx, 50, 0)).toBeNull();
  // Animate it (one key at 0 holding 100), then key through the engine.
  const ref = await trackRef(s.A, effectOpacityPath(s.fx));
  await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: ref.path }, time: 0, value: { kind: 'scalar', value: 100 }, spatialIn: [], spatialOut: [] }] });
  await clearHistory();
  const cmds = effectOpacityCommands(s.A, s.fx, 40, 1);
  expect(cmds).not.toBeNull();
  await act(async () => { await edit('Set Effect Opacity', cmds!); });
  expect((await docView()).getTrackKeyframes(s.A, effectOpacityPath(s.fx))!.map((k) => k.value)).toEqual([100, 40]);
});

test('compositing options: opacity, its stopwatch, effect mask and label are one engine entry each', async () => {
  const fx = async (): Promise<ReturnType<typeof fxOf>> => (await docView()).getNodeEffects(s.A).find((e) => e.id === s.fx);
  await act(async () => { await setEffectOpacityEdit(s.A, s.fx, 40); });
  expect((await fx())!.opacity).toBeCloseTo(40);
  await act(async () => { await effectOpacityStopwatchEdit(s.A, (await fx())!, 0); });
  expect((await docView()).isAnimated(s.A, effectOpacityPath(s.fx))).toBe(true);
  await act(async () => { await effectOpacityStopwatchEdit(s.A, (await fx())!, 0); });
  expect((await docView()).isAnimated(s.A, effectOpacityPath(s.fx))).toBe(false);
  await act(async () => { await setEffectOpacityEdit(s.A, s.fx, undefined); });
  expect((await fx())!.opacity ?? 100).toBeCloseTo(100);
  await act(async () => { await setEffectMaskEdit(s.A, s.fx, s.mask); });
  expect((await fx())!.maskId).toBe(s.mask);
  await act(async () => { await setEffectMaskEdit(s.A, s.fx, undefined); });
  expect((await fx())!.maskId).toBeUndefined();
  await act(async () => { await setEffectLabelColorEdit(s.A, s.fx, '#ff0000'); });
  expect((await fx())!.labelColor).toBe('#ff0000');
  settle();
  expect((await historyLabels())).toEqual([
    'Set Effect Opacity', 'Animate Effect Opacity', 'Remove Effect Opacity animation', 'Reset Effect Opacity',
    'Set effect mask', 'Set effect mask', 'Set effect label',
  ]);
});

test('Effects ▸ Simulation switches the layer\'s Cloner on, one entry', async () => {
  await act(async () => { await enableSimulationEdit(s.A, 'cloner'); });
  const { values: [v] } = await h.query({ type: 'getPropertyValues', props: [{ layer: s.A, path: 'layer/cloner' }], time: 0, evaluated: false });
  expect(v!.value).toMatchObject({ kind: 'json' });
  expect(JSON.parse((v!.value as { value: string }).value)).toMatchObject({ enabled: true });
  expect((await historyLabels())).toEqual(['Add Cloner']);
});

test('per-vertex mask feather is one path write; clearing every vertex removes them', async () => {
  const pts = async (): Promise<ReturnType<typeof getNodeMask>['paths'][number]['points']> => (await docView()).getNodeMask(s.A).paths[0]!.points;
  await act(async () => { await setMaskVertexFeatherEdit(s.A, s.mask, [{ index: 1, feather: 12 }], 0); });
  expect((await pts()).map((p) => p.feather)).toEqual([undefined, 12, undefined, undefined]);
  await act(async () => { await setMaskVertexFeatherEdit(s.A, s.mask, [{ index: 2, feather: 4 }], 0); });
  expect((await pts()).map((p) => p.feather)).toEqual([undefined, 12, 4, undefined]);
  await act(async () => { await setMaskVertexFeatherEdit(s.A, s.mask, [0, 1, 2, 3].map((index) => ({ index, feather: undefined })), 0); });
  expect((await pts()).every((p) => p.feather === undefined)).toBe(true);
  expect((await historyLabels())).toEqual(['Mask Vertex Feather', 'Mask Vertex Feather', 'Mask Vertex Feather']);
});

// ── Masks ─────────────────────────────────────────────────────────────

test('mask card edits: add, mode, inverted, rename, feather, shape stopwatch, remove — one entry each', async () => {
  await act(async () => { await addMaskEdit(s.B, rectangleMask(200, 100), 'Add Rectangle Mask'); });
  const m = (await docView()).getNodeMask(s.B).paths[0]!;
  expect(m.points).toHaveLength(4);
  await act(async () => { await setMaskModeEdit(s.B, m.id, 'subtract'); });
  await act(async () => { await setMaskInvertedEdit(s.B, m.id, true); });
  await act(async () => { await renameMaskEdit(s.B, m.id, 'Hole'); });
  await act(async () => { await edit('Set Mask Feather', maskValueCommands(s.B, m.id, 'feather', 12, 0)!); });
  await act(async () => { await edit('Set Mask Opacity', maskValueCommands(s.B, m.id, 'opacity', 40, 0)!); });
  let cur = (await docView()).getNodeMask(s.B).paths[0]!;
  expect(cur).toMatchObject({ id: m.id, mode: 'subtract', inverted: true, name: 'Hole', feather: 12, opacity: 0.4 });
  await act(async () => { await setMaskShapeAnimatedEdit(s.B, m.id, true, 0); });
  // A keyed mask shape: feather is still the mask's own property (it holds across shape keys).
  expect(maskValueCommands(s.B, m.id, 'feather', 3, 0)).not.toBeNull();
  await act(async () => { await setMaskShapeAnimatedEdit(s.B, m.id, false, 0); });
  await act(async () => { await removeMaskEdit(s.B, m.id, 'Remove Mask 1'); });
  expect((await docView()).getNodeMask(s.B).paths).toHaveLength(0);
  settle();
  expect((await historyLabels())).toEqual([
    'Add Rectangle Mask', 'Mask Mode', 'Invert Mask', 'Rename Mask', 'Set Mask Feather', 'Set Mask Opacity',
    'Animate Mask Path', 'Stop Animating Mask Path', 'Remove Mask 1',
  ]);
  await undo();
  cur = (await docView()).getNodeMask(s.B).paths[0]!;
  expect(cur.id).toBe(m.id);
});

// ── Layer styles ──────────────────────────────────────────────────────

test('layer styles: the checkbox adds / removes the style, a field scrub is one entry', async () => {
  render(<LayerStylesControls nodeId={s.A} />);
  await act(async () => { fireEvent.click(screen.getByLabelText('Drop shadow')); await settleEdits(); });
  expect((await stylesOf(s.A)).dropShadow).toBeDefined();
  cleanup();
  render(<LayerStylesControls nodeId={s.A} />);
  const before = (await h.doc());
  await typeInto('Opacity', '40');
  expect((await stylesOf(s.A)).dropShadow!.opacity).toBeCloseTo(0.4);
  await scrub(screen.getByRole('spinbutton', { name: 'Distance' }), [5, 10, 15]);
  settle();
  expect((await historyLabels())).toEqual(['Add Drop Shadow', 'Set Opacity', 'Set Distance']);
  await undo();
  await undo();
  expect((await h.doc())).toEqual(before);
});

test('layer style switches, Glass and a bound angle go through the engine', async () => {
  await act(async () => { await setLayerStyleOnEdit(s.A, 'dropShadow', true, 'Drop Shadow'); });
  await act(async () => { await setLayerStyleOnEdit(s.A, 'glass', true, 'Glass'); });
  await act(async () => { await patchLayerStyleEdit(s.A, 'dropShadow', { useGlobalLight: true }); });
  expect((await stylesOf(s.A)).dropShadow!.useGlobalLight).not.toBe(false);
  await clearHistory();
  const before = (await h.doc());
  render(<LayerStylesControls nodeId={s.A} />);
  // Editing the angle the Global Light drives unbinds it in the same entry.
  await typeInto('Angle', '45');
  expect((await stylesOf(s.A)).dropShadow).toMatchObject({ angle: 45, useGlobalLight: false });
  cleanup(); // the panel re-renders from its host on a document change
  render(<LayerStylesControls nodeId={s.A} />);
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Use global light' })); await settleEdits(); });
  expect((await stylesOf(s.A)).dropShadow!.useGlobalLight).toBe(true);
  // Glass is `styles/glass/<param>`, valued in stored units (0..1 opacities).
  await typeInto('Glass tint opacity', '50');
  expect((await stylesOf(s.A)).glass!.tintOpacity).toBeCloseTo(0.5);
  await act(async () => { await patchLayerStyleEdit(s.A, 'glass', { blur: 20, rimColor: '#00ff00' }); });
  expect((await stylesOf(s.A)).glass).toMatchObject({ blur: 20, rimColor: '#00ff00' });
  settle();
  expect((await historyLabels())).toEqual(['Set Angle', 'Edit Layer Style', 'Set Glass tint opacity', 'Edit Layer Style']);
  for (let i = 0; i < 4; i++) await undo();
  expect((await h.doc())).toEqual(before);
});

test('Global Light is a composition setting (one entry per typed value)', async () => {
  await act(async () => { await edit('Global Light', globalLightCommands({ globalLightAngle: 33 })); });
  expect(useCompositionStore.getState().globalLightAngle).toBe(33);
  expect((await historyLabels())).toEqual(['Global Light']);
});

// ── Layer switches / time ─────────────────────────────────────────────

test('the fx switch, stretch / reverse and frame blending go through the engine', async () => {
  await act(async () => { await setLayerEffectsEnabledEdit(s.A, false); });
  expect(readNodeFxEnabled((await docView()).getNode(s.A)!)).toBe(false);
  await act(async () => { await edit('Time Stretch', layerStretchCommands(s.V, 200, false)); });
  expect((await docView()).getNodeLayerTime(s.V).stretch).toBeCloseTo(200);
  await act(async () => { await edit('Time-Reverse Layer', layerStretchCommands(s.V, 200, true)); });
  expect((await docView()).getNodeLayerTime(s.V)).toMatchObject({ stretch: 200, reverse: true });
  await act(async () => { await setFrameBlendEdit(s.V, 'mix'); });
  expect((await docView()).getNodeLayerTime(s.V).frameBlend).toBe('mix');
  expect((await historyLabels())).toEqual(['Disable Effects', 'Time Stretch', 'Time-Reverse Layer', 'Frame Blending']);
});

test('freeze frame on / off and its hold time go through the engine', async () => {
  await act(async () => { await setFreezeFrameEdit(s.V, true, 1); });
  expect((await docView()).getNodeLayerTime(s.V)).toMatchObject({ freeze: true, freezeTime: 1 });
  await act(async () => { await setFreezeTimeEdit(s.V, 2.5); });
  expect((await docView()).getNodeLayerTime(s.V)).toMatchObject({ freeze: true, freezeTime: 2.5 });
  await act(async () => { await setFreezeFrameEdit(s.V, false, 0); });
  expect((await docView()).getNodeLayerTime(s.V).freeze ?? false).toBe(false);
  expect((await historyLabels())).toEqual(['Freeze Frame', 'Freeze Frame', 'Unfreeze Frame']);
  await undo();
  expect((await docView()).getNodeLayerTime(s.V)).toMatchObject({ freeze: true, freezeTime: 2.5 });
});

