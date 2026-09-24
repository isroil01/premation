/**
 * The editor shell's timeline / menu edits through the engine API (B3): one
 * undo entry per user action, exact undo / redo, the legacy writers' rules.
 */

import { defaultAnimation } from '@motion/animation';
import { rowSelectionId } from '@core/engine/__testHelpers__/selectionIds';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readLayerFlag } from '@core/scene/layerFlags';
import { isLayerAudioMuted } from '@core/audio/audioLayerSwitches';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { edit } from '@core/engine/uiEdits';
import { useSelectionStore } from '@stores/selectionStore';
import {
  addKeyframesForSelectionEdit,
  applyAnimationPresetEdit,
  centreAnchorEdit,
  centreInCompEdit,
  createLayerEdit,
  easyEaseAllEdit,
  fitLayersEdit,
  sequenceLayerBarsEdit,
  staggerAnimationsEdit,
  timeReverseKeyframesEdit,
  deleteClipLayerEdit,
  moveLayerAdjacentEdit,
  propertyKeyToggleEdit,
  propertyStopwatchEdit,
  propertyValueCommands,
  setKeyInterpolationEdit,
  setKeyRovingEdit,
  soloExclusiveEdit,
  toggleAudioMuteEdit,
  toggleLayerFlagEdit,
  toggleTrackSwitchEdit,
} from './appEdits';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.getState().clear();
});

afterEach(async () => {
  await h.dispose();
});

async function roundTrip(run: () => Promise<unknown>, label: string): Promise<void> {
  const before = h.doc();
  const entries = historyLabels().length;
  await run();
  await engineIdle();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels().length).toBe(entries + 1);
  expect(historyLabels().at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

const node = (id: string) => defaultSceneGraph.getNode(id)!;

describe('track switches', () => {
  it('eye / lock / solo: one entry each, labelled as before', async () => {
    await roundTrip(() => toggleTrackSwitchEdit(s.A, 'visible'), 'Hide layer');
    expect(node(s.A).visible).toBe(false);
    await roundTrip(() => toggleTrackSwitchEdit(s.A, 'locked'), 'Lock layer');
    await roundTrip(() => toggleTrackSwitchEdit(s.B, 'solo'), 'Solo layer');
    expect(node(s.B).solo).toBe(true);
  });

  it('Alt+click solo isolates this layer, then clears every solo — one entry each', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { solo: true } });
    await h.run({ type: 'setLayerSwitches', layers: [s.c2layer], patch: { solo: true } });
    await roundTrip(() => soloExclusiveEdit(s.B), 'Solo only this layer');
    expect([node(s.A).solo, node(s.c2layer).solo, node(s.B).solo]).toEqual([false, false, true]);
    await roundTrip(() => soloExclusiveEdit(s.B), 'Clear all solos');
    expect(node(s.B).solo).toBe(false);
  });

  it('the speaker glyph mutes a video layer, not a solid', async () => {
    await roundTrip(() => toggleAudioMuteEdit(s.V), 'Mute layer audio');
    expect(isLayerAudioMuted(s.V)).toBe(true);
    const before = historyLabels().length;
    await toggleAudioMuteEdit(s.A);
    expect(historyLabels().length).toBe(before);
  });

  it('switch-column flags go through setLayerSwitches', async () => {
    await roundTrip(() => toggleLayerFlagEdit(s.A, 'fxEnabled'), 'Disable Effects');
    expect(readLayerFlag(node(s.A), 'fxEnabled')).toBe(false);
    await roundTrip(() => toggleLayerFlagEdit(s.B, 'shy'), 'Enable Shy');
    await roundTrip(() => toggleLayerFlagEdit(s.B, 'quality'), 'Quality: Draft');
    await roundTrip(() => toggleLayerFlagEdit(s.A, 'guide'), 'Enable Guide Layer');
    expect(readLayerFlag(node(s.A), 'guide')).toBe(true);
  });
});

describe('row reorder', () => {
  it('moves a layer next to a sibling in child order, one entry', async () => {
    const kids = () => defaultSceneGraph.getChildOrder(s.comp).filter((id) => [s.A, s.B, s.T].includes(id));
    const start = kids();
    // Put the back-most of the three in front of the front-most.
    const back = start[0]!;
    const front = start[start.length - 1]!;
    await roundTrip(() => moveLayerAdjacentEdit(back, front, 'after'), 'Reorder layer');
    expect(kids().at(-1)).toBe(back);
  });
});

describe('property rows', () => {
  it('Alt+Shift+T keys opacity on every selected unlocked layer at the playhead', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.T], patch: { locked: true } });
    await roundTrip(() => addKeyframesForSelectionEdit([s.A, s.B, s.T], ['opacity'], 1), 'Add keyframe');
    expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(true);
    expect(defaultAnimation.isAnimated(s.B, 'opacity')).toBe(true);
    expect(defaultAnimation.isAnimated(s.T, 'opacity')).toBe(false);
  });

  it('the stopwatch turns animation on, then off (static at the playhead)', async () => {
    await roundTrip(() => propertyStopwatchEdit(s.A, ['opacity'], 0), 'Enable animation');
    expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(true);
    await roundTrip(() => propertyStopwatchEdit(s.A, ['opacity'], 0), 'Disable animation');
    expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(false);
  });

  it("a drawn shape's Path row stopwatch keys the whole outline, then leaves it static at the playhead", async () => {
    const { layer } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'path', name: 'Drawn', init: [] });
    const pts = [[0, -30], [30, 30], [-30, 30]].map(([x, y]) => ({ x: x!, y: y!, inX: x!, inY: y!, outX: x!, outY: y! }));
    defaultSceneGraph.writeProp(layer, `${layer}_g`, 'points', pts);
    await h.run({ type: 'renameLayer', layer, name: 'Drawn' });
    await roundTrip(() => propertyStopwatchEdit(layer, ['path.points'], 0), 'Enable animation');
    expect(defaultAnimation.isDataAnimated(layer, 'path.points')).toBe(true);
    await roundTrip(() => propertyStopwatchEdit(layer, ['path.points'], 0), 'Disable animation');
    expect(defaultAnimation.isDataAnimated(layer, 'path.points')).toBe(false);
  });

  it('the merged Position stopwatch keys x and y together', async () => {
    await roundTrip(() => propertyStopwatchEdit(s.A, ['x', 'y'], 0.5), 'Enable animation');
    expect(defaultAnimation.isAnimated(s.A, 'x')).toBe(true);
    expect(defaultAnimation.isAnimated(s.A, 'y')).toBe(true);
  });

  it('the navigator diamond adds a key at the playhead, then removes it', async () => {
    await roundTrip(() => propertyKeyToggleEdit(s.B, 'Position', 0.5), 'Add keyframe');
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')!.length).toBe(3);
    await roundTrip(() => propertyKeyToggleEdit(s.B, 'Position', 0.5), 'Remove keyframe');
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')!.length).toBe(2);
  });

  it('a value field keys an animated property and writes a static one', async () => {
    const keyed = propertyValueCommands(s.B, 'x', 250, 0, false)!;
    await roundTrip(() => edit('Set x', keyed), 'Set x');
    const k0 = defaultAnimation.getTrackKeyframes(s.B, 'x')![0]!;
    expect(k0.value).toBe(250);
    const plain = propertyValueCommands(s.A, 'opacity', 0.25, 0, false)!;
    await roundTrip(() => edit('Set opacity', plain), 'Set opacity');
    expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(false);
    // Auto-keyframe on an unanimated property makes its first key.
    const auto = propertyValueCommands(s.A, 'rotation', 30, 0, true)!;
    await roundTrip(() => edit('Set rotation', auto), 'Set rotation');
    expect(defaultAnimation.isAnimated(s.A, 'rotation')).toBe(true);
  });

  it('a locked layer gets no command', () => {
    defaultSceneGraph.getNode(s.A)!.locked = true;
    expect(propertyValueCommands(s.A, 'opacity', 0.5, 0, false)).toEqual([]);
    defaultSceneGraph.getNode(s.A)!.locked = false;
  });
});

describe('keyframe menu', () => {
  const uiId = (t: number) => rowSelectionId(s.B, 'Position', t);

  it('interpolation kinds and hold, one entry each', async () => {
    await roundTrip(() => setKeyInterpolationEdit(uiId(0), 'linear', 'Linear interpolation'), 'Set keyframe easing: Linear');
    await roundTrip(() => setKeyInterpolationEdit(uiId(0), 'hold', 'Enable hold keyframe'), 'Enable hold keyframe');
    // Scalar tracks spell hold 'step' (the sampler treats both as a hold).
    expect(['hold', 'step']).toContain(defaultAnimation.getTrackKeyframes(s.B, 'x')![0]!.easing);
  });

  it('roving', async () => {
    await roundTrip(() => setKeyRovingEdit(uiId(0), true), 'Enable roving keyframe');
  });
});

describe('registry commands', () => {
  const tp = (id: string, p: string) => node(id).components.find((c) => c.type === 'Transform')!.props[p] as number;

  it('Centre Anchor: anchor to 0, Position compensated, the whole selection in ONE entry', async () => {
    await h.run({ type: 'setProperties', writes: [
      { prop: { layer: s.A, path: 'transform/anchorPoint' }, value: { kind: 'vec2', value: { x: 30, y: 40 } } },
      { prop: { layer: s.P, path: 'transform/anchorPoint' }, value: { kind: 'vec2', value: { x: -10, y: 5 } } },
    ] });
    const ax = tp(s.A, 'x');
    await roundTrip(() => centreAnchorEdit([s.A, s.P], 0), 'Centre Anchor Point');
    expect([tp(s.A, 'anchorX'), tp(s.A, 'anchorY')]).toEqual([0, 0]);
    expect(tp(s.A, 'x')).toBe(ax - 30);
    expect(tp(s.P, 'anchorX')).toBe(0);
  });

  it('Centre In View and Fit to Comp: one entry for the selection', async () => {
    await roundTrip(() => centreInCompEdit([s.A, s.B], { width: 1000, height: 600 }, 0.5), 'Centre In Frame');
    expect(tp(s.A, 'x')).toBe(500);
    // B's Position is animated: the centre is keyed at the playhead instead.
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')!.length).toBe(3);
    const done = await fitLayersEdit([s.V], { width: 1920, height: 1080 }, 'contain', 0);
    expect(typeof done).toBe('boolean');
  });

  it('Time-Reverse / Easy Ease All keyframes on a layer, one entry each', async () => {
    await roundTrip(() => timeReverseKeyframesEdit(s.B), 'Time-reverse keyframes');
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')!.map((k) => k.value)).toEqual([300, 100]);
    await roundTrip(() => easyEaseAllEdit(s.B), 'Easy ease all keyframes');
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')!.every((k) => k.easing === 'bezier')).toBe(true);
    expect(await easyEaseAllEdit(s.A)).toBe('none');
  });

  it('Time-Reverse falls back when properties span different times', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.B, path: 'transform/opacity' }, time: 0, value: { kind: 'scalar', value: 0 }, spatialIn: [], spatialOut: [] },
      { prop: { layer: s.B, path: 'transform/opacity' }, time: 5 * 705600000, value: { kind: 'scalar', value: 100 }, spatialIn: [], spatialOut: [] },
    ] });
    expect(await timeReverseKeyframesEdit(s.B)).toBe(false);
  });

  it('Stagger Animations shifts the second animated layer by the interval, one entry', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.A, path: 'transform/opacity' }, time: 0, value: { kind: 'scalar', value: 0 }, spatialIn: [], spatialOut: [] },
      { prop: { layer: s.A, path: 'transform/opacity' }, time: 705600000, value: { kind: 'scalar', value: 100 }, spatialIn: [], spatialOut: [] },
    ] });
    await roundTrip(() => staggerAnimationsEdit([s.B, s.A], 0.5), 'Sequence layers');
    expect(defaultAnimation.getTrackKeyframes(s.A, 'opacity')![0]!.t).toBeCloseTo(0.5, 3);
    expect(await staggerAnimationsEdit([s.B], 0.5)).toBe('none');
  });

  it('Sequence Layers lays bars end to end with the cross-dissolve in ONE entry', async () => {
    await roundTrip(() => sequenceLayerBarsEdit([s.A, s.P], 0.5, true), 'Sequence Layers');
    expect(defaultAnimation.isAnimated(s.P, 'opacity')).toBe(true);
    // One layer in each of two comps: no composition has two to sequence.
    expect(await sequenceLayerBarsEdit([s.A, s.c2layer], 0, false)).toBe('none');
  });

  it('animation preset through applyPreset', async () => {
    const { listPresets } = await import('@core/animation/animationPresets');
    const preset = listPresets().find((p) => !p.requires && !(p.animators && p.animators.length))!;
    await roundTrip(() => applyAnimationPresetEdit([s.B], preset.name, 0), `Apply ${preset.name}`);
  });
});

describe('clip menu and new layers', () => {
  it('Delete Layer through deleteLayers; a locked layer is left alone', async () => {
    await roundTrip(() => deleteClipLayerEdit(s.A, false), 'Delete layer');
    expect(defaultSceneGraph.getNode(s.A)).toBeUndefined();
    await h.run({ type: 'setLayerSwitches', layers: [s.B], patch: { locked: true } });
    const n = historyLabels().length;
    await deleteClipLayerEdit(s.B, false);
    expect(historyLabels().length).toBe(n);
    expect(await deleteClipLayerEdit(null, false)).toBe(false);
  });

  it('createLayer: a null in the active comp, selected, one entry', async () => {
    let id: string | null = null;
    await roundTrip(async () => { id = await createLayerEdit('null', { label: 'New Null' }); }, 'New Null');
    expect(id).not.toBeNull();
    expect(useSelectionStore.getState().ids).toEqual([id]);
  });
});
