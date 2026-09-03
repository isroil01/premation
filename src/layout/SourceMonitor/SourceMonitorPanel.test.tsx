/**
 * The panel's job, end to end: mark a range with the keyboard, press Insert,
 * and get THAT range in the comp.
 *
 * Deliberately not mocked at the seam that would make it trivial. The only
 * fake is `insertMedia` — which fits, PAR-corrects and routes by file type,
 * none of which is this panel's business — and it keeps the one contract the
 * ops depend on: it adds a footage node and selects it. Everything between the
 * `I` key and `Clip.sourceIn` is the real thing: the store's clamping, the
 * seconds → frames conversion, and the trim order.
 *
 * The JKL shuttle is asserted through the store's `playing` flag rather than
 * through the media element, because jsdom's `HTMLMediaElement.play` is a
 * stub — what is testable here is that the panel OWNS the keys while focused
 * (and, per `data-shortcut-claim`, that the global dispatcher will let it).
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SourceMonitorPanel } from './SourceMonitorPanel';
import { useSourceMonitorStore } from '@stores/sourceMonitorStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore } from '@stores/assetStore';
import { claimsChord } from '@core/commands/ShortcutManager';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { insertMedia } from '@core/scene/sceneInsert';
import type { CommandServices } from '@core/commands/Command';
import type { ImportedAsset } from '@stores/assetStore';
import type { SceneNode } from '@core/types';

jest.mock('@core/scene/sceneInsert', () => {
  let seq = 0;
  return {
    insertMedia: jest.fn(async (asset: { id: string; name: string; src: string }) => {
      const graph = jest.requireActual('@core/scene/DefaultSceneGraph').default;
      const { useSelectionStore: sel } = jest.requireActual('@stores/selectionStore');
      const { SCENE_KIND_PROP: KIND } = jest.requireActual('@core/scene/seedDefaultScene');
      const id = `layer_${asset.id}_${++seq}`;
      graph.addChild('comp_root', {
        id, name: asset.name, parent: 'comp_root', children: [], visible: true, locked: false,
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [{
          id: `${id}_t`, type: 'Transform',
          props: { [KIND]: 'video', src: asset.src, assetId: asset.id, x: 0, y: 0, width: 64, height: 48 },
        }],
      });
      sel.getState().set([id]);
    }),
  };
});

const ASSET: ImportedAsset = {
  id: 'a1', name: 'clip.mp4', type: 'video', src: 'blob:nowhere/clip', size: 1,
  metadata: { width: 64, height: 48, duration: 10, fps: 30 },
};

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  (insertMedia as jest.Mock).mockClear();
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  getTimelineController().reset();
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  useSelectionStore.getState().clear();
  useAssetStore.setState({ assets: [ASSET] });
  useSourceMonitorStore.getState().close();
});

const panel = (): HTMLElement => screen.getByRole('group', { name: 'Source monitor' });

function mountWithAsset(): void {
  act(() => { useSourceMonitorStore.getState().open(ASSET.id, ASSET.metadata?.duration); });
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
    const c = getTimelineController();
    c.seekSeconds(1);

    // Marked with the keyboard, exactly as a user would.
    act(() => { useSourceMonitorStore.getState().setTime(2); });
    fireEvent.keyDown(panel(), { key: 'i' });
    act(() => { useSourceMonitorStore.getState().setTime(5); });
    fireEvent.keyDown(panel(), { key: 'o' });

    await act(async () => {
      fireEvent.click(screen.getByText('Insert at playhead'));
      await Promise.resolve();
    });

    expect(insertMedia).toHaveBeenCalledTimes(1);
    expect((insertMedia as jest.Mock).mock.calls[0]?.[0]).toMatchObject({ id: 'a1' });

    await waitFor(() => {
      // The node the insert created — by SELECTION, not by a guessed id: the
      // fake's counter runs across the whole file.
      const nodeId = [...useSelectionStore.getState().ids][0]!;
      const clip = c.getLayersForNode(nodeId)[0]?.clip;
      // 30fps · in 2s → sourceIn 60 · 3s long → 90 frames · playhead 1s → start 30.
      expect(clip).toMatchObject({ sourceIn: 60, duration: 90, start: 30 });
    });
  });

  it('with nothing marked it inserts the whole clip rather than refusing', async () => {
    mountWithAsset();
    await act(async () => {
      fireEvent.click(screen.getByText('Insert at playhead'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const nodeId = [...useSelectionStore.getState().ids][0]!;
      expect(getTimelineController().getLayersForNode(nodeId)[0]?.clip).toMatchObject({ sourceIn: 0, duration: 300 });
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
