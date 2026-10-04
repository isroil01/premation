import { documentMirror } from '@stores/documentMirror';
/**
 * The editor shell's timeline / menu edits through the engine API (B3): one
 * undo entry per user action, exact undo / redo, the legacy writers' rules.
 */

import { rowSelectionId } from '@core/engine/__testHelpers__/selectionIds';
import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { edit } from '@core/engine/uiEdits';
import { insertFragment } from '@/engine-client/insertFragment';
import type { SceneNode } from '@core/types';
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
  toggleTrackSwitchEdit,
} from './appEdits';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  // The command builders under test compose from the layers' trees (the
  // timeline rows that call them show those layers).
  await settleEdits();
  await documentMirror().loadTrees(documentMirror().layerIds());
  useSelectionStore.getState().clear();
});

afterEach(async () => {
  await h.dispose();
});

async function roundTrip(run: () => Promise<unknown>, label: string): Promise<void> {
  const before = (await h.doc());
  const entries = (await historyLabels()).length;
  await run();
  await settleEdits();
  const after = (await h.doc());
  expect(after).not.toBe(before);
  expect((await historyLabels()).length).toBe(entries + 1);
  expect((await historyLabels()).at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toBe(after);
}

const node = async (id: string) => (await docView()).getNode(id)!;

describe('track switches', () => {
  it('eye / lock / solo: one entry each, labelled as before', async () => {
    await roundTrip(() => toggleTrackSwitchEdit(s.A, 'visible'), 'Hide layer');
    expect((await node(s.A)).visible).toBe(false);
    await roundTrip(() => toggleTrackSwitchEdit(s.A, 'locked'), 'Lock layer');
    await roundTrip(() => toggleTrackSwitchEdit(s.B, 'solo'), 'Solo layer');
    expect((await node(s.B)).solo).toBe(true);
  });

  it('Alt+click solo isolates this layer, then clears every solo — one entry each', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { solo: true } });
    await h.run({ type: 'setLayerSwitches', layers: [s.c2layer], patch: { solo: true } });
    await roundTrip(() => soloExclusiveEdit(s.B), 'Solo only this layer');
    expect([(await node(s.A)).solo, (await node(s.c2layer)).solo, (await node(s.B)).solo]).toEqual([false, false, true]);
    await roundTrip(() => soloExclusiveEdit(s.B), 'Clear all solos');
    expect((await node(s.B)).solo).toBe(false);
  });

  it('the speaker glyph mutes a video layer, not a solid', async () => {
    await roundTrip(() => toggleAudioMuteEdit(s.V), 'Mute layer audio');
    expect(documentMirror().layer(s.V)!.switches.audioEnabled).toBe(false);
    const before = (await historyLabels()).length;
    await toggleAudioMuteEdit(s.A);
    expect((await historyLabels()).length).toBe(before);
  });
});

describe('row reorder', () => {
  it('moves a layer next to a sibling in child order, one entry', async () => {
    const kids = async () => (await docView()).getChildOrder(s.comp).filter((id) => [s.A, s.B, s.T].includes(id));
    const start = (await kids());
    // Put the back-most of the three in front of the front-most.
    const back = start[0]!;
    const front = start[start.length - 1]!;
    await roundTrip(() => moveLayerAdjacentEdit(back, front, 'after'), 'Reorder layer');
    expect((await kids()).at(-1)).toBe(back);
  });
});

describe('property rows', () => {
  it('Alt+Shift+T keys opacity on every selected unlocked layer at the playhead', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.T], patch: { locked: true } });
    await roundTrip(() => addKeyframesForSelectionEdit([s.A, s.B, s.T], ['opacity'], 1), 'Add keyframe');
    expect((await docView()).isAnimated(s.A, 'opacity')).toBe(true);
    expect((await docView()).isAnimated(s.B, 'opacity')).toBe(true);
    expect((await docView()).isAnimated(s.T, 'opacity')).toBe(false);
  });

  it('the stopwatch turns animation on, then off (static at the playhead)', async () => {
    await roundTrip(() => propertyStopwatchEdit(s.A, ['opacity'], 0), 'Enable animation');
    expect((await docView()).isAnimated(s.A, 'opacity')).toBe(true);
    await roundTrip(() => propertyStopwatchEdit(s.A, ['opacity'], 0), 'Disable animation');
    expect((await docView()).isAnimated(s.A, 'opacity')).toBe(false);
  });

  it("a drawn shape's Path row stopwatch keys the whole outline, then leaves it static at the playhead", async () => {
    // A drawn shape as the pen tool lays it: a path primitive with stored points.
    const ids = await insertFragment('Fixture', (b) => {
      b.addChild(s.comp, {
        id: 'drawn', name: 'Drawn', parent: s.comp, children: [], visible: true, locked: false,
        transform: { position: { x: 300, y: 200 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [
          { id: 'drawn_t', type: 'Transform', props: { __kind: 'shape', x: 300, y: 200, rotation: 0, shapeType: 'path' } },
          { id: 'drawn_g', type: 'Geometry', props: { points: [[0, -30], [30, 30], [-30, 30]].map(([x, y]) => ({ x, y, inX: x, inY: y, outX: x, outY: y })) } },
        ],
      } as unknown as SceneNode);
      return 'drawn';
    }, { comp: s.comp, noSelect: true });
    const layer = ids![0]!;
    await settleEdits();
    await roundTrip(() => propertyStopwatchEdit(layer, ['path.points'], 0), 'Enable animation');
    expect((await docView()).isDataAnimated(layer, 'path.points')).toBe(true);
    await roundTrip(() => propertyStopwatchEdit(layer, ['path.points'], 0), 'Disable animation');
    expect((await docView()).isDataAnimated(layer, 'path.points')).toBe(false);
  });

  it('the merged Position stopwatch keys x and y together', async () => {
    await roundTrip(() => propertyStopwatchEdit(s.A, ['x', 'y'], 0.5), 'Enable animation');
    expect((await docView()).isAnimated(s.A, 'x')).toBe(true);
    expect((await docView()).isAnimated(s.A, 'y')).toBe(true);
  });

  it('the navigator diamond adds a key at the playhead, then removes it', async () => {
    await roundTrip(() => propertyKeyToggleEdit(s.B, 'Position', 0.5), 'Add keyframe');
    expect((await docView()).getTrackKeyframes(s.B, 'x')!.length).toBe(3);
    await roundTrip(() => propertyKeyToggleEdit(s.B, 'Position', 0.5), 'Remove keyframe');
    expect((await docView()).getTrackKeyframes(s.B, 'x')!.length).toBe(2);
  });

  it('a value field keys an animated property and writes a static one', async () => {
    const keyed = propertyValueCommands(s.B, 'x', 250, 0, false)!;
    await roundTrip(() => edit('Set x', keyed), 'Set x');
    const k0 = (await docView()).getTrackKeyframes(s.B, 'x')![0]!;
    expect(k0.value).toBe(250);
    const plain = propertyValueCommands(s.A, 'opacity', 0.25, 0, false)!;
    await roundTrip(() => edit('Set opacity', plain), 'Set opacity');
    expect((await docView()).isAnimated(s.A, 'opacity')).toBe(false);
    // Auto-keyframe on an unanimated property makes its first key.
    const auto = propertyValueCommands(s.A, 'rotation', 30, 0, true)!;
    await roundTrip(() => edit('Set rotation', auto), 'Set rotation');
    expect((await docView()).isAnimated(s.A, 'rotation')).toBe(true);
  });

  it('a locked layer gets no command', async () => {
    // Locked through the engine: the lock is read from the document mirror (B4).
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { locked: true } });
    await settleEdits();
    expect(propertyValueCommands(s.A, 'opacity', 0.5, 0, false)).toEqual([]);
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { locked: false } });
    await settleEdits();
  });
});

describe('keyframe menu', () => {
  const uiId = (t: number) => rowSelectionId(s.B, 'Position', t);

  it('interpolation kinds and hold, one entry each', async () => {
    // The fixture's keys are linear: hold first, then back to linear — each a change.
    await roundTrip(() => setKeyInterpolationEdit(uiId(0), 'hold', 'Enable hold keyframe'), 'Enable hold keyframe');
    // Scalar tracks spell hold 'step' (the sampler treats both as a hold).
    expect(['hold', 'step']).toContain((await docView()).getTrackKeyframes(s.B, 'x')![0]!.easing);
    await roundTrip(() => setKeyInterpolationEdit(uiId(0), 'linear', 'Linear interpolation'), 'Set keyframe easing: Linear');
  });

  it('roving', async () => {
    await roundTrip(() => setKeyRovingEdit(uiId(0), true), 'Enable roving keyframe');
  });
});

describe('registry commands', () => {
  const tp = async (id: string, p: string) => (await node(id)).components.find((c) => c.type === 'Transform')!.props[p] as number;

  it('Centre Anchor: anchor to 0, Position compensated, the whole selection in ONE entry', async () => {
    await h.run({ type: 'setProperties', writes: [
      { prop: { layer: s.A, path: 'transform/anchorPoint' }, value: { kind: 'vec2', value: { x: 30, y: 40 } } },
      { prop: { layer: s.P, path: 'transform/anchorPoint' }, value: { kind: 'vec2', value: { x: -10, y: 5 } } },
    ] });
    const ax = (await tp(s.A, 'x'));
    await roundTrip(() => centreAnchorEdit([s.A, s.P], 0), 'Centre Anchor Point');
    expect([(await tp(s.A, 'anchorX')), (await tp(s.A, 'anchorY'))]).toEqual([0, 0]);
    expect((await tp(s.A, 'x'))).toBe(ax - 30);
    expect((await tp(s.P, 'anchorX'))).toBe(0);
  });

  it('Centre In View and Fit to Comp: one entry for the selection', async () => {
    await roundTrip(() => centreInCompEdit([s.A, s.B], { width: 1000, height: 600 }, 0.5), 'Centre In Frame');
    expect((await tp(s.A, 'x'))).toBe(500);
    // B's Position is animated: the centre is keyed at the playhead instead.
    expect((await docView()).getTrackKeyframes(s.B, 'x')!.length).toBe(3);
    const done = await fitLayersEdit([s.V], { width: 1920, height: 1080 }, 'contain', 0);
    expect(typeof done).toBe('boolean');
  });

  it('Time-Reverse / Easy Ease All keyframes on a layer, one entry each', async () => {
    await roundTrip(() => timeReverseKeyframesEdit(s.B), 'Time-reverse keyframes');
    expect((await docView()).getTrackKeyframes(s.B, 'x')!.map((k) => k.value)).toEqual([300, 100]);
    await roundTrip(() => easyEaseAllEdit(s.B), 'Easy ease all keyframes');
    expect((await docView()).getTrackKeyframes(s.B, 'x')!.every((k) => k.easing === 'bezier')).toBe(true);
    expect(await easyEaseAllEdit(s.A)).toBe('none');
  });

  it('Time-Reverse mirrors every key within the layer OVERALL span when properties span different times', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.B, path: 'transform/opacity' }, time: 0, value: { kind: 'scalar', value: 0 }, spatialIn: [], spatialOut: [] },
      { prop: { layer: s.B, path: 'transform/opacity' }, time: 5 * 705600000, value: { kind: 'scalar', value: 100 }, spatialIn: [], spatialOut: [] },
    ] });
    expect(await timeReverseKeyframesEdit(s.B)).toBe(true);
    // Position's keys (0 s, 1 s) mirror across the overall 0 - 5 s span: 4 s and 5 s.
    expect((await docView()).getTrackKeyframes(s.B, 'x')!.map((k) => Math.round(k.t * 1000) / 1000)).toEqual([4, 5]);
  });

  it('Stagger Animations shifts the second animated layer by the interval, one entry', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.A, path: 'transform/opacity' }, time: 0, value: { kind: 'scalar', value: 0 }, spatialIn: [], spatialOut: [] },
      { prop: { layer: s.A, path: 'transform/opacity' }, time: 705600000, value: { kind: 'scalar', value: 100 }, spatialIn: [], spatialOut: [] },
    ] });
    await roundTrip(() => staggerAnimationsEdit([s.B, s.A], 0.5), 'Sequence layers');
    expect((await docView()).getTrackKeyframes(s.A, 'opacity')![0]!.t).toBeCloseTo(0.5, 3);
    expect(await staggerAnimationsEdit([s.B], 0.5)).toBe('none');
  });

  it('Sequence Layers lays bars end to end with the cross-dissolve in ONE entry', async () => {
    await roundTrip(() => sequenceLayerBarsEdit([s.A, s.P], 0.5, true), 'Sequence Layers');
    expect((await docView()).isAnimated(s.P, 'opacity')).toBe(true);
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
    expect((await docView()).getNode(s.A)).toBeUndefined();
    await h.run({ type: 'setLayerSwitches', layers: [s.B], patch: { locked: true } });
    const n = (await historyLabels()).length;
    await deleteClipLayerEdit(s.B, false);
    expect((await historyLabels()).length).toBe(n);
    expect(await deleteClipLayerEdit(null, false)).toBe(false);
  });

  it('createLayer: a null in the active comp, selected, one entry', async () => {
    let id: string | null = null;
    await roundTrip(async () => { id = await createLayerEdit('null', { label: 'New Null' }); }, 'New Null');
    expect(id).not.toBeNull();
    expect(useSelectionStore.getState().ids).toEqual([id]);
  });
});
