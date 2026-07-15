import {
  normalizeTracks,
  offsetTracks,
  minTime,
  captureAnimation,
  listPresets,
  saveCurrentAsPreset,
  BUILTIN_PRESETS,
  type PresetTrack,
} from './animationPresets';
import { AnimationEngine } from '@motion/animation';

const track = (prop: string, kfs: Array<[number, number]>): PresetTrack => ({
  prop,
  keyframes: kfs.map(([t, value]) => ({ t, value })),
});

describe('minTime', () => {
  test('finds the earliest keyframe across tracks', () => {
    expect(minTime([track('x', [[3, 0], [5, 1]]), track('y', [[1, 0]])])).toBe(1);
  });
  test('empty → 0', () => {
    expect(minTime([])).toBe(0);
  });
});

describe('normalizeTracks', () => {
  test('rebases the earliest keyframe to t=0, preserving spacing + values', () => {
    const out = normalizeTracks([track('x', [[2, 10], [4, 20]]), track('opacity', [[3, 100]])]);
    expect(out[0]!.keyframes.map((k) => k.t)).toEqual([0, 2]); // shifted by min=2
    expect(out[1]!.keyframes[0]!.t).toBe(1);
    expect(out[0]!.keyframes.map((k) => k.value)).toEqual([10, 20]); // values untouched
  });
});

describe('offsetTracks', () => {
  test('shifts every keyframe by dt', () => {
    const out = offsetTracks([track('x', [[0, 0], [1, 1]])], 5);
    expect(out[0]!.keyframes.map((k) => k.t)).toEqual([5, 6]);
  });

  test('normalize → offset(playhead) round-trips to playhead-anchored times', () => {
    const captured = normalizeTracks([track('x', [[2, 0], [4, 1]])]);
    const applied = offsetTracks(captured, 10);
    expect(applied[0]!.keyframes.map((k) => k.t)).toEqual([10, 12]);
  });
});

describe('captureAnimation', () => {
  test('captures a node’s animated tracks, normalized to t=0', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n', 'x', 1, 0);
    a.setKeyframe('n', 'x', 3, 200);
    const tracks = captureAnimation('n', a);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.prop).toBe('x');
    expect(tracks[0]!.keyframes.map((k) => k.t)).toEqual([0, 2]); // rebased from 1,3
    expect(tracks[0]!.keyframes.map((k) => k.value)).toEqual([0, 200]);
  });

  test('an un-animated node captures nothing', () => {
    expect(captureAnimation('empty', new AnimationEngine())).toEqual([]);
  });
});

describe('presets registry', () => {
  test('listPresets always includes the built-ins', () => {
    const names = listPresets().map((p) => p.name);
    for (const b of BUILTIN_PRESETS) expect(names).toContain(b.name);
  });

  test('saving an un-animated layer fails (nothing to capture)', () => {
    // Uses the real default engine; a fresh node id has no keyframes.
    expect(saveCurrentAsPreset('no-such-node-xyz', 'X')).toBe(false);
  });
});

describe('3D presets', () => {
  test('builtins include the 3D set', () => {
    const names = BUILTIN_PRESETS.map((p) => p.name);
    for (const n of ['Flip In 3D', 'Card Flip 3D', 'Swing In 3D', 'Depth Push In', 'Orbit Tilt 3D']) {
      expect(names).toContain(n);
    }
  });

  test('applying a 3D preset auto-enables the layer 3D switch', async () => {
    const { applyPresetByName } = await import('./animationPresets');
    const { default: defaultSceneGraph } = await import('@core/scene/DefaultSceneGraph');
    const { insertShape } = await import('@core/scene/sceneInsert');
    const { is3DEnabled } = await import('@core/scene/threeD');
    const { useSelectionStore } = await import('@stores/selectionStore');
    const { setCommandSystem, CommandSystem } = await import('@core/commands/CommandSystem');
    // runAnimEdit records onto the command system — boot a minimal one.
    const dummyServices = {
      undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
      selection: { get: () => [], set: () => {}, clear: () => {} },
      panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
      workspace: { setActive: () => {}, getActive: () => '' },
      get: () => undefined,
    } as never;
    setCommandSystem(new CommandSystem({ services: dummyServices, getState: () => ({}) }));
    insertShape('rect', 'Preset Test Rect');
    const nodeId = useSelectionStore.getState().ids[0]!;
    const node = defaultSceneGraph.getNode(nodeId)!;
    expect(is3DEnabled(node)).toBe(false);
    applyPresetByName(nodeId, 'Flip In 3D', 0);
    expect(is3DEnabled(defaultSceneGraph.getNode(nodeId)!)).toBe(true);
  });
});
