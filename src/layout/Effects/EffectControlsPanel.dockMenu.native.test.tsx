/**
 * Effect Controls' ≡ menu: the stack verbs.
 *
 * Copy Stack, Paste and Save Preset were a row of chips in the Effects &
 * Presets browser — the library you add FROM. They act on the selected
 * layer's STACK, so they moved (2026-10) to the panel that shows the stack,
 * as After Effects keeps them: rows of Effect Controls' ≡ menu, with the
 * chips' enabled logic (Copy and Save need an effect on the layer, Paste needs
 * something copied).
 *
 * Rendered through the REAL DockPanel: the hand-off is a state update in the
 * dock, and a fresh rows array per render is the v0.8.1 update loop
 * (PropertiesPanel.dockMenu.native.test.tsx). The console spy throws on that
 * warning so a loop fails the case instead of hanging it.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DockPanel } from '@components/DockPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { clearEffectClipboard, deleteEffectPreset, effectClipboardSize, listEffectPresets } from '@core/effects/effectClipboard';
import { setupAppEngine, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { customPrompt } from '@components/Modal/Dialogs';
import { copyEffectsEdit } from './effectEdits';
import { EffectControlsPanel } from './EffectControlsPanel';
import { EffectsPanel } from './EffectsPanel';

jest.mock('@components/Modal/Dialogs', () => ({
  ...jest.requireActual('@components/Modal/Dialogs'),
  customPrompt: jest.fn(),
}));

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const PRESET_NAME = 'Effect Controls menu probe';

const renderers = {
  effectControls: () => <EffectControlsPanel />,
};

function renderDock(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <DockPanel region="leftSidebar" renderers={renderers} />
      {/* The library, to see a saved preset arrive in it. */}
      <EffectsPanel />
    </TooltipProvider>,
  );
}

/** Open the ≡ menu as a pointer does: a press, then the click. */
function openMenu(): void {
  const trigger = screen.getAllByRole('button', { name: 'Panel options' })[0]!;
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
}

const row = (name: string | RegExp): HTMLElement => screen.getByRole('menuitem', { name });

let h: Harness;
let s: Scene;
let loopWarnings: string[] = [];
let errorSpy: jest.SpyInstance;
const realError = console.error;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(async () => {
  loopWarnings = [];
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    if (/Maximum update depth/.test(msg)) {
      loopWarnings.push(msg);
      throw new Error(`update loop: ${msg.slice(0, 160)}`);
    }
    realError(...args);
  });

  const layout = useLayoutStore.getState();
  layout.registerPanel({ id: 'effectControls', title: 'Effect Controls', icon: 'stopwatch', region: 'leftSidebar', closable: true } as never);
  layout.openPanel('effectControls');

  h = await setupAppEngine({ panels: true });
  s = await buildScene(h);
  await documentMirror().whenIdle();
  clearEffectClipboard();
  // `s.A` carries a Glow (`s.fx`); `s.B` has no effects.
  act(() => { useSelectionStore.getState().set([s.A]); });
});

afterEach(async () => {
  cleanup();
  errorSpy.mockRestore();
  deleteEffectPreset(PRESET_NAME);
  clearEffectClipboard();
  act(() => { useSelectionStore.getState().clear(); });
  await h.dispose();
});

it('hands Copy Stack, Paste and Save Stack as Preset to the dock ≡ menu, and settles', async () => {
  renderDock();
  // Positive control: the panel is showing the layer (its identity row).
  expect(await screen.findByRole('button', { name: 'Lock Effect Controls to this layer' })).toBeInTheDocument();

  openMenu();
  expect(row('Copy Stack')).toBeEnabled();
  // Nothing copied yet: Paste is there, and off.
  expect(row('Paste Effects')).toBeDisabled();
  expect(row('Save Stack as Preset…')).toBeEnabled();
  expect(loopWarnings).toEqual([]);
});

it('Copy Stack fills the clipboard; Paste then lands the stack on another layer', async () => {
  renderDock();
  await screen.findByRole('button', { name: 'Lock Effect Controls to this layer' });

  openMenu();
  await act(async () => {
    fireEvent.click(row('Copy Stack'));
    await settleEdits();
  });
  expect(effectClipboardSize()).toBeGreaterThan(0);

  // A layer with no effects: nothing to copy or save, something to paste.
  act(() => { useSelectionStore.getState().set([s.B]); });
  openMenu();
  expect(row('Copy Stack')).toBeDisabled();
  expect(row('Save Stack as Preset…')).toBeDisabled();
  const paste = row(/^Paste \d+ Effects?$/);
  expect(paste).toBeEnabled();
  await act(async () => {
    fireEvent.click(paste);
    await settleEdits();
  });
  expect(documentMirror().layer(s.B)?.effectCount).toBeGreaterThan(0);
  expect(loopWarnings).toEqual([]);
});

it('a copy made elsewhere (an effect\'s own Copy) reaches Paste by the next press', async () => {
  renderDock();
  await screen.findByRole('button', { name: 'Lock Effect Controls to this layer' });

  // What an effect header's right-click Copy does — no event, module state.
  await act(async () => { await copyEffectsEdit(s.A, [s.fx]); });
  openMenu();
  expect(row('Paste 1 Effect')).toBeEnabled();
});

it('Save Stack as Preset… names the stack, and the Effects & Presets browser lists it', async () => {
  (customPrompt as jest.Mock).mockResolvedValueOnce(PRESET_NAME);
  renderDock();
  await screen.findByRole('button', { name: 'Lock Effect Controls to this layer' });

  openMenu();
  await act(async () => {
    fireEvent.click(row('Save Stack as Preset…'));
    await settleEdits();
  });
  expect(listEffectPresets().some((p) => p.name === PRESET_NAME)).toBe(true);

  // The browser re-read its presets without being touched: a search finds it.
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search effects and presets' }), { target: { value: PRESET_NAME } });
  expect(await screen.findByText(PRESET_NAME)).toBeInTheDocument();
});
