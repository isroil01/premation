/**
 * Camera Options in After Effects' order and grammar (2026-10-08).
 *
 *   • Point of Interest: a two-node camera shows ONE X / Y / Z row (Position's
 *     component, so each axis keyframes on its own track) and a bordered
 *     "Remove Point of Interest"; a one-node camera shows "Add Point of
 *     Interest". That flip was unreachable before: the mirror lists a
 *     one-node camera's Point of Interest as a latent property reading 0, so
 *     "is poiX a number" called every camera two-node.
 *   • Depth of Field is a ROW whose value reads On / Off — not a twirl header
 *     with a checkbox in it — and its rows follow it.
 *   • The lens presets are "Lens Presets ▸" in the Properties ≡ menu.
 *
 * The fixture is the app's engine (B3): the camera is a layer created through
 * the engine API, and the assertions read the engine's own answer back.
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import type { DropdownItem } from '@components/Dropdown';
import { CameraSection, LensPresetsMenu } from './CameraSection';
import { SectionMenuRegistry, SectionMenuSlot } from './sectionMenu';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { clearHistory, setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { POI_PATH } from '@core/engine/pointOfInterest';
import { documentMirror } from '@stores/documentMirror';

jest.useFakeTimers();

let h: Harness;
let CAM = '';

beforeEach(async () => {
  h = await setupAppEngine();
  usePreferenceStore.getState().set('inspectorSections', {});
  await act(async () => {
    ({ layer: CAM } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Rows camera', init: [] }));
    await documentMirror().loadTree(CAM);
  });
  await clearHistory();
  useSelectionStore.setState({ ids: [CAM] } as never);
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const has = (label: string): boolean => screen.queryAllByLabelText(label).length > 0;

/** The engine's answer (AE's Orient Towards Point of Interest): is the camera two-node? */
async function twoNode(): Promise<boolean> {
  await act(async () => { await documentMirror().whenIdle(); });
  const v = documentMirror().property(CAM, POI_PATH)?.value;
  return v?.kind === 'bool' && v.value === true;
}

describe('Point of Interest', () => {
  it('flips one-node → two-node → one-node from the section', async () => {
    render(<CameraSection nodeId={CAM} />);
    // A new camera is one-node: the verb to add one, no X / Y / Z row.
    expect(await twoNode()).toBe(false);
    expect(has('Point of Interest X')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add Point of Interest' }));
    await idle();
    expect(await twoNode()).toBe(true);
    for (const axis of ['X', 'Y', 'Z']) {
      expect({ axis, field: screen.getAllByRole('spinbutton', { name: `Point of Interest ${axis}` }).length > 0 })
        .toEqual({ axis, field: true });
    }
    expect(screen.queryByRole('button', { name: 'Add Point of Interest' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Point of Interest' }));
    await idle();
    expect(await twoNode()).toBe(false);
    expect(has('Point of Interest X')).toBe(false);
    expect(screen.getByRole('button', { name: 'Add Point of Interest' })).toBeInTheDocument();
    settle();
    expect(await historyLabels()).toEqual(['Enable Point of Interest', 'Remove Point of Interest']);
  });
});

describe('Depth of Field', () => {
  it('is a row whose value reads On / Off, and its rows follow it', async () => {
    render(<CameraSection nodeId={CAM} />);
    const toggle = screen.getByRole('button', { name: 'Depth of Field' });
    expect(toggle.textContent).toBe('Off');
    expect(has('Focus Distance')).toBe(false);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    fireEvent.click(toggle);
    await idle();
    expect(screen.getByRole('button', { name: 'Depth of Field' }).getAttribute('aria-pressed')).toBe('true');
    for (const row of ['Focus Distance', 'Aperture', 'Blur Level', 'F-Stop', 'Iris Blades']) {
      expect({ row, drawn: has(row) }).toEqual({ row, drawn: true });
    }
  });
});

describe('the section reads as a property list', () => {
  it('carries no paragraph of help, and the lens picker is not a row', async () => {
    render(<CameraSection nodeId={CAM} />);
    expect(document.querySelectorAll('p')).toHaveLength(0);
    expect(screen.queryAllByLabelText('Lens preset')).toHaveLength(0);
  });
});

describe('Lens Presets', () => {
  it('are a ≡-menu submenu: a pick sets Zoom to the lens, as ONE undo entry, and is ticked', async () => {
    const reg = new SectionMenuRegistry();
    render(
      <SectionMenuSlot registry={reg} slotKey="custom" order={0}>
        <LensPresetsMenu nodeId={CAM} />
      </SectionMenuSlot>,
    );
    const lenses = (): DropdownItem[] => {
      const row = reg.rows().find((r) => r.type === 'item' && r.label === 'Lens Presets');
      if (row?.type !== 'item' || !row.submenu) throw new Error('no Lens Presets submenu');
      return row.submenu;
    };
    const tele = lenses().find((r) => r.type === 'item' && String(r.label).startsWith('135mm'));
    act(() => { if (tele?.type === 'item') tele.onSelect?.({} as never); });
    await idle();
    const ticked = lenses().filter((r) => r.type === 'item' && r.icon === 'check').map((r) => (r.type === 'item' ? String(r.label) : ''));
    expect(ticked).toEqual(['135mm — Tele']);
    settle();
    expect(await historyLabels()).toHaveLength(1);
  });
});
