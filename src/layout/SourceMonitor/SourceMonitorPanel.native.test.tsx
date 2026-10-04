/**
 * The panel's job, end to end: mark a range with the keyboard, press Insert,
 * and get THAT range in the comp.
 *
 * Deliberately not mocked at the seam that would make it trivial: the media
 * insert is the real one (a fragment pasted through the engine, the new layer
 * selected). Everything between the `I` key and `Clip.sourceIn` is the real
 * thing: the store's clamping, the seconds → frames conversion, and the trim
 * order.
 *
 * The JKL shuttle is asserted through the store's `playing` flag rather than
 * through the media element, because jsdom's `HTMLMediaElement.play` is a
 * stub — what is testable here is that the panel OWNS the keys while focused
 * (and, per `data-shortcut-claim`, that the global dispatcher will let it).
 */

import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { SourceMonitorPanel } from './SourceMonitorPanel';
import { useSourceMonitorStore } from '@stores/sourceMonitorStore';
import { seekPlayhead } from '@core/timeline/timelineView';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { claimsChord } from '@core/commands/ShortcutManager';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';

/** The clip: a 10 s, 30 fps footage item (the engine's fake ports read the length from the name). */
const ASSET = { id: '', duration: 10 };

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(10) } } as Command);
  const { items } = await h.run({ type: 'importFiles', files: [{ path: 'C:/media/clip_10s.mp4', asSequence: false, createComposition: false }] } as Command) as { items: string[] };
  ASSET.id = items[0]!;
  await settleEdits();
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  useSelectionStore.getState().clear();
  useSourceMonitorStore.getState().close();
  act(() => { seekPlayhead(0); });
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

/** The inserted layer's bar in seconds: where it starts, ends, and where source 0 plays. */
const barOf = (layer: string) => {
  const t = documentMirror().layer(layer)!.timing;
  return { in: t.inPoint / sec(1), out: t.outPoint / sec(1), start: t.startTime / sec(1) };
};

const panel = (): HTMLElement => screen.getByRole('group', { name: 'Source monitor' });

function mountWithAsset(): void {
  act(() => { useSourceMonitorStore.getState().open(ASSET.id, ASSET.duration); });
  render(<SourceMonitorPanel />);
}

describe('empty state', () => {
  it('says what to do when no clip is loaded', () => {
    render(<SourceMonitorPanel />);
    expect(screen.getByText(/No clip loaded/)).toBeInTheDocument();
  });
});

describe('marking in and out', () => {
  it('I and O mark at the playhead', () => {
    mountWithAsset();
    act(() => { useSourceMonitorStore.getState().setTime(2); });
    fireEvent.keyDown(panel(), { key: 'i' });
    act(() => { useSourceMonitorStore.getState().setTime(5); });
    fireEvent.keyDown(panel(), { key: 'o' });
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: 2, outPoint: 5 });
  });

  it('the Clear button drops both marks', () => {
    mountWithAsset();
    act(() => { useSourceMonitorStore.getState().setTime(2); });
    fireEvent.keyDown(panel(), { key: 'i' });
    fireEvent.click(screen.getByTitle('Clear both marks'));
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: null, outPoint: null });
  });

  it('the range readout names the span, not just the marks', () => {
    mountWithAsset();
    act(() => {
      useSourceMonitorStore.getState().setIn(2);
      useSourceMonitorStore.getState().setOut(5);
    });
    expect(screen.getByText(/3\.00s/)).toBeInTheDocument();
  });
});

describe('Insert at playhead', () => {
  it('inserts the MARKED range, trimmed, at the comp playhead', async () => {
    mountWithAsset();
    act(() => { seekPlayhead(1); });

    // Marked with the keyboard, exactly as a user would.
    act(() => { useSourceMonitorStore.getState().setTime(2); });
    fireEvent.keyDown(panel(), { key: 'i' });
    act(() => { useSourceMonitorStore.getState().setTime(5); });
    fireEvent.keyDown(panel(), { key: 'o' });

    await act(async () => {
      fireEvent.click(screen.getByText('Insert at playhead'));
      await Promise.resolve();
    });

    await settleEdits();
    await waitFor(() => {
      // The layer the insert created — by SELECTION, not by a guessed id.
      const nodeId = [...useSelectionStore.getState().ids][0]!;
      // In 2s · 3s long · playhead 1s: the bar is [1, 4] and source 0 plays at -1.
      const bar = barOf(nodeId);
      expect(bar.in).toBeCloseTo(1, 4);
      expect(bar.out).toBeCloseTo(4, 4);
      expect(bar.start).toBeCloseTo(-1, 4);
    });
  });

  it('with nothing marked it inserts the whole clip rather than refusing', async () => {
    mountWithAsset();
    await act(async () => {
      fireEvent.click(screen.getByText('Insert at playhead'));
      await Promise.resolve();
    });
    await settleEdits();
    await waitFor(() => {
      const nodeId = [...useSelectionStore.getState().ids][0]!;
      const bar = barOf(nodeId);
      expect(bar.start).toBeCloseTo(0, 4);
      expect(bar.out - bar.in).toBeCloseTo(10, 4);
    });
  });
});

describe('JKL shuttle', () => {
  it('L runs forward, K stops, J runs in reverse', () => {
    mountWithAsset();
    fireEvent.keyDown(panel(), { key: 'l' });
    expect(useSourceMonitorStore.getState().playing).toBe(true);
    fireEvent.keyDown(panel(), { key: 'k' });
    expect(useSourceMonitorStore.getState().playing).toBe(false);
    fireEvent.keyDown(panel(), { key: 'j' });
    expect(useSourceMonitorStore.getState().playing).toBe(true);
    // The speed readout is the only visible proof of the ramp.
    fireEvent.keyDown(panel(), { key: 'j' });
    expect(screen.getByText('2× rev')).toBeInTheDocument();
  });

  it('arrows step frames — shifted arrows step ten', () => {
    mountWithAsset();
    act(() => { useSourceMonitorStore.getState().setTime(1); });
    fireEvent.keyDown(panel(), { key: 'ArrowRight' });
    expect(useSourceMonitorStore.getState().time).toBeCloseTo(1 + 1 / 30, 5);
    fireEvent.keyDown(panel(), { key: 'ArrowLeft', shiftKey: true });
    expect(useSourceMonitorStore.getState().time).toBeCloseTo(1 + 1 / 30 - 10 / 30, 5);
  });

  it('claims its chords from the global dispatcher, and nothing else', () => {
    mountWithAsset();
    const root = panel();
    for (const chord of ['j', 'k', 'l', 'i', 'o', 'arrowleft', 'Shift+arrowright']) {
      expect({ chord, claimed: claimsChord(root, chord) }).toEqual({ chord, claimed: true });
    }
    // Global chords the panel must NOT swallow — undo is the one that would
    // hurt most, and Delete belongs to the timeline's selection.
    for (const chord of ['Meta+z', 'delete', 'Ctrl+s']) {
      expect({ chord, claimed: claimsChord(root, chord) }).toEqual({ chord, claimed: false });
    }
  });
});

describe('with no clip open', () => {
  it('names the surface and says where a clip comes from', () => {
    useSourceMonitorStore.setState({ assetId: null });
    render(<SourceMonitorPanel />);

    expect(screen.getByText('No clip loaded')).toBeTruthy();
    expect(screen.getByText(/Open a clip from the Assets panel/)).toBeTruthy();
  });
});
