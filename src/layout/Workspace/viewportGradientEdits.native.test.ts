import { documentMirror } from '@stores/documentMirror';
/**
 * The gradient gizmo's command builders (viewportEdits.ts ▸ gradient*Commands)
 * — the per-property rule the overlay test cannot isolate:
 *
 *   • a radial centre with ONE live coordinate keys that one and writes the
 *     other into the stored paint, in one batch (one undo entry);
 *   • a keyed stop list only for the PRIMARY fill; a stack slot is its paint;
 *   • Auto-Keyframe keys an addressable geometry track (a text stroke's
 *     angle) and leaves the stored paint alone; a track the engine does not
 *     address is written statically instead — never dropped.
 */

import { type FillPaint, type LinearFill, type RadialFill } from '@core/paint/fill';
import { edit } from '@core/engine/uiEdits';
import { values } from '@core/engine/propRefs';
import { clearHistory, setupAppEngine, historyLabels, sampleTrack, propRef, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { fillPaintCommands, textStrokePaintCommands } from '@layout/Inspector/appearance/paintEdits';
import { fieldCommands } from '@layout/Text/textEdits';
import {
  gradientGeometryCommands,
  gradientPaintCommands,
  gradientStopsCommands,
  type GradientPaintTarget,
} from './viewportEdits';

let h: Harness;
let ID: string;

const RADIAL: RadialFill = {
  type: 'radial',
  cx: 0.5,
  cy: 0.5,
  radius: 0.5,
  stops: [
    { id: 'a', offset: 0, color: '#000000' },
    { id: 'b', offset: 1, color: '#ffffff' },
  ],
} as RadialFill;

const LINEAR: LinearFill = {
  type: 'linear',
  angle: 0,
  stops: [
    { id: 'a', offset: 0, color: '#000000' },
    { id: 'b', offset: 1, color: '#ffffff' },
  ],
};

const target = async (over: Partial<GradientPaintTarget> = {}): Promise<GradientPaintTarget> => ({
  nodeId: ID, channel: 'fill', fillIndex: 0, strokeIndex: 0, fills: (await docView()).getNodeFills(ID), ...over,
});

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'G', init: [] })).layer;
  // The fixture's field commands (and the edits under test) compose from the layer's tree.
  await settleEdits();
  await documentMirror().loadTree(ID);
});

afterEach(async () => {
  await h.dispose();
});

async function roundTrip(label: string, cmds: ReturnType<typeof gradientPaintCommands>): Promise<void> {
  await clearHistory();
  const before = (await h.doc());
  const res = await edit(label, cmds);
  expect(res.ok).toBe(true);
  expect((await historyLabels())).toEqual([label]);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
}

test('a radial centre with one live coordinate: that one keys, the other lands in the paint — one entry', async () => {
  await h.batch('fixture', fillPaintCommands(ID, RADIAL));
  await settleEdits();
  const ref = (await propRef(ID, 'fillCenterX'));
  await h.run({ type: 'addKeyframes', keys: [{ prop: ref, time: 0, value: values.scalar(0.5), spatialIn: [], spatialOut: [] }] });

  const t = await target();
  const staticNext = { ...((await docView()).getNodeFill(ID) as RadialFill), cx: 0.2, cy: 0.7 };
  const cmds = gradientGeometryCommands(
    t,
    [{ track: 'fillCenterX', value: 0.2 }, { track: 'fillCenterY', value: 0.7 }],
    () => gradientPaintCommands(t, staticNext),
    { seconds: 0, autoKeyframe: false },
  );
  await roundTrip('Move Gradient Handle', cmds);
  await h.run({ type: 'redo' });

  expect(await sampleTrack(ID, 'fillCenterX', 0)).toBeCloseTo(0.2);
  expect((await docView()).isAnimated(ID, 'fillCenterY')).toBe(false);
  expect(((await docView()).getNodeFill(ID) as RadialFill).cy).toBeCloseTo(0.7);
});

test('a stack slot above the primary is written as its paint — never as the primary’s keys', async () => {
  const second: FillPaint = { ...LINEAR, stops: LINEAR.stops.map((s) => ({ ...s, id: `${s.id}2` })) };
  await h.batch('fixture', fieldCommands(ID, 'layer/fills', [LINEAR, second]));
  await h.run({ type: 'setAnimated', prop: { layer: ID, path: 'layer/fillStops' }, animated: true, time: 0 });

  const t = await target({ fillIndex: 1 });
  const moved = [{ id: 'a2', offset: 0.25, color: '#000000' }, { id: 'b2', offset: 1, color: '#ffffff' }];
  await roundTrip('Move Gradient Stop', gradientStopsCommands(t, second as LinearFill, moved, { keyed: true, seconds: 0 }));
  await h.run({ type: 'redo' });

  const stack = (await docView()).getNodeFills(ID) as LinearFill[];
  expect(stack[1]?.stops.map((s) => s.offset)).toEqual([0.25, 1]);
  // The primary's Colors key is untouched.
  const res = await h.query({ type: 'getPropertyValues', props: [{ layer: ID, path: 'layer/fillStops' }], time: 0, evaluated: true });
  const key = (res.values[0]!.value as { value: { stops: Array<{ offset: number }> } }).value.stops;
  expect(key.map((s) => s.offset)).toEqual([0, 1]);
});

test('under Auto-Keyframe a text stroke’s angle keys at the playhead; the stored paint is untouched', async () => {
  const { layer: T } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'T', init: [] });
  await settleEdits();
  await documentMirror().loadTree(T);
  await h.batch('fixture', textStrokePaintCommands(T, LINEAR));
  await settleEdits();
  const t: GradientPaintTarget = { nodeId: T, channel: 'stroke', fillIndex: 0, strokeIndex: 0, fills: [] };
  const cmds = gradientGeometryCommands(
    t,
    [{ track: 'strokeAngle', value: 45 }],
    () => gradientPaintCommands(t, { ...LINEAR, angle: 45 }),
    { seconds: 0, autoKeyframe: true },
  );
  await roundTrip('Move Gradient Handle', cmds);
  await h.run({ type: 'redo' });

  expect(await sampleTrack(T, 'strokeAngle', 0)).toBeCloseTo(45);
  const text = (await docView()).getNode(T)!.components.find((c) => c.type === 'Text')!.props;
  expect((text.strokePaint as LinearFill).angle).toBe(0);
});

test('a track the engine does not address is written statically, even under Auto-Keyframe — never dropped', async () => {
  // `fillCenterX` exists only while the primary fill is radial.
  await h.batch('fixture', fillPaintCommands(ID, LINEAR));
  const t = await target();
  const cmds = gradientGeometryCommands(
    t,
    [{ track: 'fillCenterX', value: 0.3 }],
    () => gradientPaintCommands(t, { ...LINEAR, angle: 30 }),
    { seconds: 0, autoKeyframe: true },
  );
  await roundTrip('Move Gradient Handle', cmds);
  await h.run({ type: 'redo' });
  expect(((await docView()).getNodeFill(ID) as LinearFill).angle).toBe(30);
  expect((await docView()).isAnimated(ID, 'fillCenterX')).toBe(false);
});
