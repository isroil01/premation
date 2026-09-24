/**
 * B3: the Inspector's Time rows (CompositingSection), the Audio Waveform
 * generator (ShapeEffects + AudioWaveformSection) and the modifier chips write
 * through the engine API. Pinned through the real components over the app's
 * engine: each click / typed value / scrub / drop is ONE undo entry named as
 * the user reads it, the document holds the new value, and undo restores the
 * document exactly.
 */

import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { stretchValueOf } from '@core/animation/layerTimeCommands';
import { readNodeAudioWaveform, defaultAudioWaveform } from '@core/audio/audioWaveformGen';
import { defaultModifier, readModifierStack, type Modifier } from '@core/animation/modifierStack';
import { CompositingSection } from './CompositingSection';
import { ShapeEffects } from './ShapeEffects';
import { AudioWaveformSection } from './AudioWaveformSection';
import { ModifierChips } from './ModifierChips';
import { audioWaveformCommands } from './audioEdits';
import { modifierStackCommands } from './modifierEdits';

jest.useFakeTimers();

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
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

const renderCompositing = (id: string) => render(<TooltipProvider><CompositingSection nodeId={id} /></TooltipProvider>);

// ── CompositingSection ▸ Time ──────────────────────────────────────────

describe('CompositingSection time rows', () => {
  test('Time Stretch on a non-footage layer is timeStretchLayers about the in-point — one entry', async () => {
    renderCompositing(s.B);
    const before = h.doc();
    await typeInto('Time stretch', '200');
    expect(stretchValueOf(s.B)).toBe(200);
    settle();
    expect(historyLabels()).toEqual(['Time Stretch']);
    const viaPanel = h.doc();

    await undo();
    expect(h.doc()).toBe(before);
    expect(stretchValueOf(s.B)).toBe(100);

    // Exactly the API's Time Stretch (bar + position keys + markers baked about the in-point).
    await act(async () => { await h.run({ type: 'timeStretchLayers', layers: [s.B], stretch: 2, hold: 'inPoint' }); });
    expect(h.doc()).toBe(viaPanel);
  });

  test('Time Stretch on footage sets its playback rate (setLayerTiming) — one entry', async () => {
    renderCompositing(s.V);
    const before = h.doc();
    await typeInto('Time stretch', '200');
    expect(getNodeLayerTime(s.V).stretch).toBe(200);
    settle();
    expect(historyLabels()).toEqual(['Time Stretch']);
    await undo();
    expect(h.doc()).toBe(before);
  });

  test('the Freeze Frame switch freezes at the playhead and unfreezes — one entry each, undo restores', async () => {
    renderCompositing(s.V);
    const before = h.doc();
    expect(getNodeLayerTime(s.V).freeze).toBe(false);

    fireEvent.click(screen.getByLabelText('Freeze frame'));
    await idle();
    expect(getNodeLayerTime(s.V)).toMatchObject({ freeze: true, freezeTime: 0 });
    const frozen = h.doc();

    fireEvent.click(screen.getByLabelText('Freeze frame'));
    await idle();
    expect(getNodeLayerTime(s.V).freeze).toBe(false);
    settle();
    expect(historyLabels()).toEqual(['Freeze Frame', 'Unfreeze Frame']);

    await undo();
    expect(h.doc()).toBe(frozen);
    await undo();
    expect(h.doc()).toBe(before);
  });

  test('a typed Freeze Time re-holds that source time — one entry', async () => {
    await act(async () => { await h.run({ type: 'freezeFrame', layer: s.V, lastFrame: false, time: 0 }); });
    getCommandSystem().getHistory().clear();
    renderCompositing(s.V);
    const before = h.doc();

    await typeInto('Freeze time', '1.5');
    expect(getNodeLayerTime(s.V)).toMatchObject({ freeze: true, freezeTime: 1.5 });
    settle();
    expect(historyLabels()).toEqual(['Freeze Frame']);

    await undo();
    expect(h.doc()).toBe(before);
    await redo();
    expect(getNodeLayerTime(s.V)).toMatchObject({ freeze: true, freezeTime: 1.5 });
  });
});

// ── Audio Waveform generator ───────────────────────────────────────────

const waveOf = (id: string) => readNodeAudioWaveform(defaultSceneGraph.getNode(id)!);

describe('Audio Waveform', () => {
  test('Add (ShapeEffects menu) stores the default config — one entry, undo removes it', async () => {
    render(<ShapeEffects nodeId={s.B} />);
    const before = h.doc();
    expect(waveOf(s.B)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add audio waveform' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Audio Waveform' }));
    await idle();

    expect(waveOf(s.B)).toEqual(defaultAudioWaveform());
    // The section appears under the menu, from the mirror.
    expect(screen.getByRole('spinbutton', { name: 'Height scale' })).toBeInTheDocument();
    settle();
    expect(historyLabels()).toEqual(['Add Audio Waveform']);

    await undo();
    expect(waveOf(s.B)).toBeNull();
    expect(h.doc()).toBe(before);
  });

  test('a picked / typed field changes that key only; a scrub is one entry; Remove clears it', async () => {
    await act(async () => { await h.batch('seed', audioWaveformCommands(s.B, defaultAudioWaveform())); });
    getCommandSystem().getHistory().clear();
    render(<AudioWaveformSection nodeId={s.B} />);
    const base = defaultAudioWaveform();

    fireEvent.change(screen.getByLabelText('Waveform display mode'), { target: { value: 'playhead-window' } });
    await idle();
    expect(waveOf(s.B)).toEqual({ ...base, mode: 'playhead-window' });

    await typeInto('Thickness', '7');
    expect(waveOf(s.B)).toEqual({ ...base, mode: 'playhead-window', thickness: 7 });

    const beforeScrub = waveOf(s.B)!;
    await scrub(screen.getByRole('spinbutton', { name: 'Height scale' }), [4, 8, 12, 16]);
    const afterScrub = waveOf(s.B)!;
    expect(afterScrub.heightScale).not.toBe(beforeScrub.heightScale);
    expect(afterScrub).toEqual({ ...beforeScrub, heightScale: afterScrub.heightScale });
    settle();
    expect(historyLabels()).toEqual(['Edit Audio Waveform', 'Edit Audio Waveform', 'Edit Audio Waveform']);

    const beforeRemove = h.doc();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Audio Waveform' }));
    await idle();
    expect(waveOf(s.B)).toBeNull();
    settle();
    expect(historyLabels().at(-1)).toBe('Remove Audio Waveform');

    await undo();
    expect(h.doc()).toBe(beforeRemove);
    expect(waveOf(s.B)).toEqual(afterScrub);
  });
});

// ── Modifier chips ─────────────────────────────────────────────────────

describe('ModifierChips', () => {
  const offset = (amount: number): Modifier => ({ ...defaultModifier('offset'), amount } as Modifier);
  const multiply = (factor: number): Modifier => ({ ...defaultModifier('multiply'), factor } as Modifier);
  const stackOn = (id: string, track: string) => readModifierStack(defaultSceneGraph.getNode(id)!, track);

  async function seed(track: string, list: Modifier[]): Promise<void> {
    await act(async () => { await h.batch('seed', modifierStackCommands(s.A, track, list)); });
    getCommandSystem().getHistory().clear();
  }

  test('dropping a chip on another reorders the stack and recompiles — one entry', async () => {
    await seed('opacity', [offset(10), multiply(2)]);
    render(<ModifierChips nodeId={s.A} prop="opacity" />);
    const before = h.doc();

    const chips = screen.getAllByRole('listitem');
    fireEvent.dragStart(chips[0]!);
    fireEvent.drop(screen.getAllByRole('listitem')[1]!);
    await idle();

    expect(stackOn(s.A, 'opacity')?.modifiers.map((m) => m.kind)).toEqual(['multiply', 'offset']);
    expect(defaultAnimation.getExpressionSrc(s.A, 'opacity')).toBe('((value * 2) + 10)');
    settle();
    expect(historyLabels()).toEqual(['Reorder Modifier']);

    await undo();
    expect(h.doc()).toBe(before);
  });

  test('× removes one chip; removing the last removes the stack and its expression', async () => {
    await seed('opacity', [offset(10), multiply(2)]);
    render(<ModifierChips nodeId={s.A} prop="opacity" />);
    const seeded = h.doc();

    fireEvent.click(screen.getByLabelText('Remove Offset modifier'));
    await idle();
    expect(stackOn(s.A, 'opacity')?.modifiers.map((m) => m.kind)).toEqual(['multiply']);
    expect(defaultAnimation.getExpressionSrc(s.A, 'opacity')).toBe('(value * 2)');

    fireEvent.click(screen.getByLabelText('Remove Multiply modifier'));
    await idle();
    expect(stackOn(s.A, 'opacity')).toBeNull();
    expect(defaultAnimation.getExpressionSrc(s.A, 'opacity') ?? '').toBe('');
    settle();
    expect(historyLabels()).toEqual(['Remove Modifier', 'Remove Modifier']);

    await undo();
    await undo();
    expect(h.doc()).toBe(seeded);
  });
});
