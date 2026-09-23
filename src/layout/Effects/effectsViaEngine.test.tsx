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
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { effectDefFor, getNodeEffects, getNodeFxEnabled, paramsOf, effectOpacityPath } from '@core/effects/effects';
import { copyEffects, copyAllEffects, clearEffectClipboard, applyEffectPreset } from '@core/effects/effectClipboard';
import { BUILTIN_EFFECT_PRESETS } from '@core/effects/builtinEffectPresets';
import { getNodeLayerStyles } from '@core/effects/layerStyles';
import { getNodeMask, rectangleMask } from '@core/effects/mask';
import { getNodeLayerTime } from '@core/scene/layerTime';
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
  globalLightCommands,
  layerStretchCommands,
  maskValueCommands,
  paramCommands,
  pasteEffectsEdit,
  removeMaskEdit,
  renameMaskEdit,
  resetEffectEdit,
  setFrameBlendEdit,
  setLayerEffectsEnabledEdit,
  setMaskInvertedEdit,
  setMaskModeEdit,
  setMaskShapeAnimatedEdit,
} from './effectEdits';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  s = await buildScene(h);
  clearEffectClipboard();
  getCommandSystem().getHistory().clear();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };
const redo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'redo' }); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const fxOf = (layer: string, type: string) => getNodeEffects(layer).find((e) => e.type === type);

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
  expect(fxOf(s.A, 'gaussian-blur')).toBeDefined();
  expect(fxOf(s.B, 'gaussian-blur')).toBeDefined();
  settle();
  expect(historyLabels()).toEqual(['Add Gaussian Blur']);
  await undo();
  expect(fxOf(s.A, 'gaussian-blur')).toBeUndefined();
  expect(fxOf(s.B, 'gaussian-blur')).toBeUndefined();
});

// ── Parameter controls (EffectStack) ──────────────────────────────────

describe('EffectStack parameter rows', () => {
  beforeEach(async () => {
    await addEffectEdit([s.A], 'gaussian-blur'); // the last effect: its card is open
    getCommandSystem().getHistory().clear();
  });

  test('a scrub of a numeric param is ONE entry; undo/redo walk it exactly', async () => {
    render(<EffectStack nodeId={s.A} />);
    const before = h.doc();
    const start = paramsOf(fxOf(s.A, 'gaussian-blur')!).blurriness as number;
    await scrub(screen.getByRole('spinbutton', { name: 'Gaussian Blur Blurriness' }), [10, 20, 30, 40]);
    const after = paramsOf(fxOf(s.A, 'gaussian-blur')!).blurriness as number;
    expect(after).toBeGreaterThan(start);
    settle();
    expect(historyLabels()).toEqual(['Set Gaussian Blur Blurriness']);
    await undo();
    expect(h.doc()).toEqual(before);
    await redo();
    expect(paramsOf(fxOf(s.A, 'gaussian-blur')!).blurriness).toBeCloseTo(after);
  });

  test('a typed value is one entry', async () => {
    render(<EffectStack nodeId={s.A} />);
    await typeInto('Gaussian Blur Blurriness', '42');
    expect(paramsOf(fxOf(s.A, 'gaussian-blur')!).blurriness).toBe(42);
    settle();
    expect(historyLabels()).toEqual(['Set Gaussian Blur Blurriness']);
  });

  test('the stopwatch animates (one entry); a typed value then keys at the playhead', async () => {
    render(<EffectStack nodeId={s.A} />);
    const fx = fxOf(s.A, 'gaussian-blur')!;
    const track = `effect.${fx.id}.blurriness`;
    const watch = screen.getByRole('button', { name: 'Enable Blurriness animation' });
    await act(async () => { fireEvent.click(watch); await engineIdle(); });
    expect(defaultAnimation.isAnimated(s.A, track)).toBe(true);
    await typeInto('Gaussian Blur Blurriness', '77');
    const keys = defaultAnimation.getTrackKeyframes(s.A, track)!;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.value).toBe(77);
    settle();
    expect(historyLabels()).toEqual(['Animate Gaussian Blur Blurriness', 'Set Gaussian Blur Blurriness']);
  });

  test('a checkbox param is a bool write, one entry', async () => {
    render(<EffectStack nodeId={s.A} />);
    const box = screen.getByLabelText('Gaussian Blur Repeat Edge Pixels') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => { fireEvent.click(box); await engineIdle(); });
    expect(paramsOf(fxOf(s.A, 'gaussian-blur')!).repeatEdge).toBe(false);
    settle();
    expect(historyLabels()).toEqual(['Set Gaussian Blur Repeat Edge Pixels']);
  });

  test('the header: disable, reorder, reset and remove are one entry each; ids are stable', async () => {
    render(<EffectStack nodeId={s.A} />);
    const blur = fxOf(s.A, 'gaussian-blur')!.id;
    const disable = screen.getAllByTitle('Disable effect');
    await act(async () => { fireEvent.click(disable[disable.length - 1]!); await engineIdle(); });
    expect(getNodeEffects(s.A).find((e) => e.id === blur)!.enabled).toBe(false);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move Gaussian Blur up' })); await engineIdle(); });
    expect(getNodeEffects(s.A).map((e) => e.id)).toEqual([blur, s.fx]);

    await act(async () => { await edit('x', paramCommands(s.A, blur, effectDefFor('gaussian-blur')!.params[0]!, 99, 0)); });
    getCommandSystem().getHistory().clear();
    await act(async () => { await resetEffectEdit(s.A, blur, 'Gaussian Blur'); });
    expect(paramsOf(getNodeEffects(s.A).find((e) => e.id === blur)!).blurriness).toBe(10);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Gaussian Blur' })); await engineIdle(); });
    expect(getNodeEffects(s.A).some((e) => e.id === blur)).toBe(false);
    settle();
    expect(historyLabels()).toEqual(['Reset Gaussian Blur', 'Remove Gaussian Blur']);
    await undo();
    // Undo brings back the SAME effect id, where it was.
    expect(getNodeEffects(s.A).map((e) => e.id)).toEqual([blur, s.fx]);
  });
});

test('the enum menu writes the option (stored as its number), one entry', async () => {
  await addEffectEdit([s.A], 'echo');
  getCommandSystem().getHistory().clear();
  render(<EffectStack nodeId={s.A} />);
  const menu = screen.getByLabelText('Echo Echo Operator') as HTMLSelectElement;
  await act(async () => { fireEvent.change(menu, { target: { value: '3' } }); await engineIdle(); });
  const stored = paramsOf(fxOf(s.A, 'echo')!).echoOperator;
  expect(stored).toBe(3);
  settle();
  expect(historyLabels()).toEqual(['Set Echo Echo Operator']);
});

test('colour, layer-picker and curve params go through setProperty', async () => {
  const glow = effectDefFor('glow')!;
  await act(async () => { await edit('Set Glow Color', paramCommands(s.A, s.fx, glow.params.find((p) => p.key === 'color')!, '#ff0000', 0)); });
  expect(String(paramsOf(fxOf(s.A, 'glow')!).color).toLowerCase()).toMatch(/^#ff0000/);

  await addEffectEdit([s.A], 'displacement-map');
  const dm = fxOf(s.A, 'displacement-map')!;
  const mapLayer = effectDefFor('displacement-map')!.params.find((p) => p.type === 'layer')!;
  await act(async () => { await edit('Set Map Layer', paramCommands(s.A, dm.id, mapLayer, s.B, 0)); });
  expect(paramsOf(fxOf(s.A, 'displacement-map')!)[mapLayer.key]).toBe(s.B);

  await addEffectEdit([s.A], 'curves');
  const cv = fxOf(s.A, 'curves')!;
  const pts = effectDefFor('curves')!.params.find((p) => p.type === 'curve')!;
  await act(async () => { await edit('Set Curve', paramCommands(s.A, cv.id, pts, [[0, 0], [128, 200], [255, 255]], 0)); });
  expect(paramsOf(fxOf(s.A, 'curves')!)[pts.key]).toEqual([[0, 0], [128, 200], [255, 255]]);
});

test('an animated colour param keys all four channels at the playhead, one entry', async () => {
  const color = effectDefFor('glow')!.params.find((p) => p.key === 'color')!;
  await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `effects/${s.fx}/color` }, animated: true, time: 0 });
  getCommandSystem().getHistory().clear();
  await act(async () => { await edit('Set Glow Color', paramCommands(s.A, s.fx, color, '#00ff00', 1)); });
  const g = defaultAnimation.getTrackKeyframes(s.A, `effect.${s.fx}.color_g`)!;
  expect(g).toHaveLength(2);
  expect(g.some((k) => Math.abs(k.value - 1) < 1e-6)).toBe(true);
  expect(historyLabels()).toEqual(['Set Glow Color']);
});

// ── Stack operations ──────────────────────────────────────────────────

test('a drag-and-drop reorder is one entry and moves the effect by id', async () => {
  await addEffectEdit([s.A], 'gaussian-blur');
  await addEffectEdit([s.A], 'echo');
  const ids = getNodeEffects(s.A).map((e) => e.id);
  getCommandSystem().getHistory().clear();
  await act(async () => { await dropEffectEdit(s.A, ids[2]!, 0); });
  expect(getNodeEffects(s.A).map((e) => e.id)).toEqual([ids[2], ids[0], ids[1]]);
  // A drop into its own gap does nothing.
  await act(async () => { await dropEffectEdit(s.A, ids[0]!, 2); });
  expect(historyLabels()).toEqual(['Reorder Effects']);
  await undo();
  expect(getNodeEffects(s.A).map((e) => e.id)).toEqual(ids);
});

test('duplicate copies the effect and its keyframes under a new id, one entry', async () => {
  await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `effects/${s.fx}/radius` }, animated: true, time: 0 });
  getCommandSystem().getHistory().clear();
  await act(async () => { await duplicateEffectEdit(s.A, s.fx, 'Glow'); });
  const list = getNodeEffects(s.A);
  expect(list).toHaveLength(2);
  const copy = list[1]!;
  expect(copy.id).not.toBe(s.fx);
  expect(defaultAnimation.isAnimated(s.A, `effect.${copy.id}.radius`)).toBe(true);
  expect(historyLabels()).toEqual(['Duplicate Glow']);
});

test('copy / paste onto another layer is ONE engine entry with the keyframes; a stale clipboard falls back', async () => {
  await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `effects/${s.fx}/radius` }, animated: true, time: 0 });
  copyEffects(s.A, [s.fx]);
  getCommandSystem().getHistory().clear();
  await act(async () => { await pasteEffectsEdit([s.B]); });
  const pasted = fxOf(s.B, 'glow')!;
  expect(pasted).toBeDefined();
  expect(defaultAnimation.isAnimated(s.B, `effect.${pasted.id}.radius`)).toBe(true);
  settle();
  expect(historyLabels()).toEqual(['Paste Effect']);
  await undo();
  expect(fxOf(s.B, 'glow')).toBeUndefined();

  // The source changed since the copy: the clipboard is a snapshot the API
  // cannot paste yet — the legacy snapshot paste still lands the COPIED state.
  copyAllEffects(s.A);
  const radius = paramsOf(fxOf(s.A, 'glow')!).radius;
  await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.A, path: `effects/${s.fx}` }] });
  await act(async () => { await pasteEffectsEdit([s.B]); });
  expect(paramsOf(fxOf(s.B, 'glow')!).radius).toBe(radius);
});

test('a built-in effect preset is ONE engine entry and renders like the legacy paste', async () => {
  await act(async () => { expect(await applyEffectPresetEdit('Neon Edge', [s.B])).toBe(true); });
  settle();
  expect(historyLabels()).toEqual(['Apply Neon Edge']);
  const viaEngine = getNodeEffects(s.B).map((e) => ({ type: e.type, params: paramsOf(e) }));
  await undo();
  expect(getNodeEffects(s.B)).toHaveLength(0);
  applyEffectPreset('Neon Edge', [s.V]);
  const viaLegacy = getNodeEffects(s.V).map((e) => ({ type: e.type, params: paramsOf(e) }));
  expect(viaEngine).toEqual(viaLegacy);
});

test('EVERY built-in preset applies through the engine, identical to the legacy paste', async () => {
  const fellBack: string[] = [];
  const differ: string[] = [];
  for (const preset of BUILTIN_EFFECT_PRESETS) {
    getCommandSystem().getHistory().clear();
    await act(async () => { await applyEffectPresetEdit(preset.name, [s.B]); });
    if (historyLabels().join() !== `Apply ${preset.name}`) fellBack.push(preset.name);
    const viaEngine = getNodeEffects(s.B).map((e) => ({ type: e.type, params: paramsOf(e) }));
    applyEffectPreset(preset.name, [s.V]);
    const viaLegacy = getNodeEffects(s.V).map((e) => ({ type: e.type, params: paramsOf(e) }));
    if (JSON.stringify(viaEngine) !== JSON.stringify(viaLegacy)) differ.push(`${preset.name}: ${JSON.stringify(viaEngine)} vs ${JSON.stringify(viaLegacy)}`);
    await h.run({ type: 'removePropertyGroups', groups: getNodeEffects(s.B).map((e) => ({ layer: s.B, path: `effects/${e.id}` })) });
    await h.run({ type: 'removePropertyGroups', groups: getNodeEffects(s.V).map((e) => ({ layer: s.V, path: `effects/${e.id}` })) });
  }
  expect(differ).toEqual([]);
  // Cinematic Grade sets `vibrance` on Lumetri, a key Lumetri does not declare
  // (a dead value in the preset data): `addEffect` cannot carry an undeclared
  // param, so that one preset keeps the legacy snapshot paste.
  expect(fellBack).toEqual(['Cinematic Grade']);
});

// ── Compositing Options ───────────────────────────────────────────────

test('Effect Opacity: an animated value keys through the engine; a static one keeps the legacy writer', async () => {
  expect(effectOpacityCommands(s.A, s.fx, 50, 0)).toBeNull();
  // Animate it the legacy way (the stopwatch is an engine gap), then key through the engine.
  defaultAnimation.setKeyframe(s.A, effectOpacityPath(s.fx), 0, 100);
  getCommandSystem().getHistory().clear();
  const cmds = effectOpacityCommands(s.A, s.fx, 40, 1);
  expect(cmds).not.toBeNull();
  await act(async () => { await edit('Set Effect Opacity', cmds!); });
  expect(defaultAnimation.getTrackKeyframes(s.A, effectOpacityPath(s.fx))!.map((k) => k.value)).toEqual([100, 40]);
});

// ── Masks ─────────────────────────────────────────────────────────────

test('mask card edits: add, mode, inverted, rename, feather, shape stopwatch, remove — one entry each', async () => {
  await act(async () => { await addMaskEdit(s.B, rectangleMask(200, 100), 'Add Rectangle Mask'); });
  const m = getNodeMask(s.B).paths[0]!;
  expect(m.points).toHaveLength(4);
  await act(async () => { await setMaskModeEdit(s.B, m.id, 'subtract'); });
  await act(async () => { await setMaskInvertedEdit(s.B, m.id, true); });
  await act(async () => { await renameMaskEdit(s.B, m.id, 'Hole'); });
  await act(async () => { await edit('Set Mask Feather', maskValueCommands(s.B, m.id, 'feather', 12, 0)!); });
  await act(async () => { await edit('Set Mask Opacity', maskValueCommands(s.B, m.id, 'opacity', 40, 0)!); });
  let cur = getNodeMask(s.B).paths[0]!;
  expect(cur).toMatchObject({ id: m.id, mode: 'subtract', inverted: true, name: 'Hole', feather: 12, opacity: 0.4 });
  await act(async () => { await setMaskShapeAnimatedEdit(s.B, m.id, true, 0); });
  // A keyed mask shape: its values belong in the shape keyframe (legacy route).
  expect(maskValueCommands(s.B, m.id, 'feather', 3, 0)).toBeNull();
  await act(async () => { await setMaskShapeAnimatedEdit(s.B, m.id, false, 0); });
  await act(async () => { await removeMaskEdit(s.B, m.id, 'Remove Mask 1'); });
  expect(getNodeMask(s.B).paths).toHaveLength(0);
  settle();
  expect(historyLabels()).toEqual([
    'Add Rectangle Mask', 'Mask Mode', 'Invert Mask', 'Rename Mask', 'Set Mask Feather', 'Set Mask Opacity',
    'Animate Mask Path', 'Stop Animating Mask Path', 'Remove Mask 1',
  ]);
  await undo();
  cur = getNodeMask(s.B).paths[0]!;
  expect(cur.id).toBe(m.id);
});

// ── Layer styles ──────────────────────────────────────────────────────

test('layer styles: the checkbox adds / removes the style, a field scrub is one entry', async () => {
  render(<LayerStylesControls nodeId={s.A} />);
  await act(async () => { fireEvent.click(screen.getByLabelText('Drop shadow')); await engineIdle(); });
  expect(getNodeLayerStyles(s.A).dropShadow).toBeDefined();
  cleanup();
  render(<LayerStylesControls nodeId={s.A} />);
  const before = h.doc();
  await typeInto('Opacity', '40');
  expect(getNodeLayerStyles(s.A).dropShadow!.opacity).toBeCloseTo(0.4);
  await scrub(screen.getByRole('spinbutton', { name: 'Distance' }), [5, 10, 15]);
  settle();
  expect(historyLabels()).toEqual(['Add Drop Shadow', 'Set Opacity', 'Set Distance']);
  await undo();
  await undo();
  expect(h.doc()).toEqual(before);
});

test('Global Light is a composition setting (one entry per typed value)', async () => {
  await act(async () => { await edit('Global Light', globalLightCommands({ globalLightAngle: 33 })); });
  expect(useCompositionStore.getState().globalLightAngle).toBe(33);
  expect(historyLabels()).toEqual(['Global Light']);
});

// ── Layer switches / time ─────────────────────────────────────────────

test('the fx switch, stretch / reverse and frame blending go through the engine', async () => {
  await act(async () => { await setLayerEffectsEnabledEdit(s.A, false); });
  expect(getNodeFxEnabled(s.A)).toBe(false);
  await act(async () => { await edit('Time Stretch', layerStretchCommands(s.V, 200, false)); });
  expect(getNodeLayerTime(s.V).stretch).toBeCloseTo(200);
  await act(async () => { await edit('Time-Reverse Layer', layerStretchCommands(s.V, 200, true)); });
  expect(getNodeLayerTime(s.V)).toMatchObject({ stretch: 200, reverse: true });
  await act(async () => { await setFrameBlendEdit(s.V, 'mix'); });
  expect(getNodeLayerTime(s.V).frameBlend).toBe('mix');
  expect(historyLabels()).toEqual(['Disable Effects', 'Time Stretch', 'Time-Reverse Layer', 'Frame Blending']);
});

