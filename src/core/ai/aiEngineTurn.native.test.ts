/**
 * B5: an AI turn is ONE engine gesture on the app's engine — one undo entry
 * labelled after the turn, origin `ai`, exact undo/redo, rollback = the
 * engine's cancel — and a turn that had to write around the engine still lands
 * as one (snapshot) entry that names its gaps.
 */

import { unwrap } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, itFullEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { documentMirror } from '@stores/documentMirror';
import { runToolTurn } from './aiTurn';
import { beginAiTransaction } from './aiTransaction';
import { createToolContext } from './toolContext';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

const rigTurn = [
  { name: 'create_layer', args: { id: 'a', kind: 'null', name: 'Rig A', x: 100, y: 200 } },
  { name: 'create_layer', args: { id: 'b', kind: 'null', name: 'Rig B' } },
  { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Cam' } },
  {
    name: 'set_keyframes',
    args: {
      keyframes: [
        { nodeId: 'a', prop: 'rotation', t: 0, value: 0, easing: 'easeOut' },
        { nodeId: 'a', prop: 'rotation', t: 1, value: 90 },
        { nodeId: 'b', prop: 'x', t: 0, value: 100, easing: 'bezier', bezier: [0.2, 0, 0.2, 1] },
        { nodeId: 'b', prop: 'x', t: 2, value: 500 },
        { nodeId: 'cam', prop: 'z', t: 0, value: -900 },
        { nodeId: 'cam', prop: 'z', t: 2, value: -400 },
      ],
    },
  },
  { name: 'update_layer', args: { nodeId: 'a', name: 'Rig A (renamed)' } },
  { name: 'update_layer', args: { nodeId: 'b', rotation: 12, y: 300 } },
  { name: 'set_expression', args: { nodeId: 'b', prop: 'rotation', expression: 'time * 10' } },
  { name: 'set_easing', args: { targets: [{ nodeId: 'a', prop: 'rotation', t: 1, easing: 'easeIn' }] } },
];

describe('an AI turn on the engine', () => {
  it('is one engine entry named after the turn, origin ai, with exact undo and redo', async () => {
    const before = (await h.doc());
    const r = await runToolTurn('AI: rig it', rigTurn);
    expect(r.results.map((x) => x.ok ? 'ok' : x.content)).toEqual(rigTurn.map(() => 'ok'));
    expect(r.outcome).toEqual({ kind: 'engine', gaps: [] });

    const entries = unwrap(await engine().query({ type: 'getHistory' })).entries;
    expect((await historyLabels())).toEqual(['AI: rig it']);
    expect(entries.at(-1)?.origin).toBe('ai');

    const after = (await h.doc());
    expect(after).not.toBe(before);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
    await h.run({ type: 'redo' });
    expect((await h.doc())).toBe(after);
  });

  it('keys one Position dimension on its own (AE Separate Dimensions)', async () => {
    const r = await runToolTurn('AI: slide', [
      { name: 'create_layer', args: { id: 'n', kind: 'null', name: 'N', x: 10, y: 20 } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 'n', prop: 'x', t: 0, value: 10 }, { nodeId: 'n', prop: 'x', t: 1, value: 300 }] } },
    ]);
    expect(r.outcome.kind).toBe('engine');
    const m = documentMirror();
    const id = m.layerIds().find((c) => m.layer(c)?.name === 'N')!;
    const v = await docView();
    expect(v.getTrackKeyframes(id, 'x')?.map((k) => k.value)).toEqual([10, 300]);
    // y was never keyed — the tool's contract, kept by separating dimensions.
    expect(v.getTrackKeyframes(id, 'y') ?? []).toEqual([]);
  });

  it('puts a value and its easing on the SAME stored key when the layer is offset in time (B1)', async () => {
    const r = await runToolTurn('AI: make', [{ name: 'create_layer', args: { id: 'n', kind: 'null', name: 'Late' } }]);
    const id = (r.results[0]!.data as { id: string }).id;
    await h.run({ type: 'moveLayersInTime', layers: [id], delta: 2 * 705_600_000, ripple: false });
    const r2 = await runToolTurn('AI: ease', [
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: id, prop: 'rotation', t: 3, value: 45, easing: 'bezier', bezier: [0.3, 0, 0.1, 1] }, { nodeId: id, prop: 'rotation', t: 4, value: 90 }] } },
    ]);
    expect(r2.outcome.kind).toBe('engine');
    // The layer starts at 2 s: comp 3 s is its key at 1 s.
    const key = (await docView()).getTrackKeyframes(id, 'rotation')!.find((k) => Math.abs(k.t - 1) < 1e-6)!;
    expect(key.value).toBe(45);
    expect(key.bezier).toEqual([0.3, 0, 0.1, 1]);
  });

  it('rolls back through the engine: the document is unchanged and nothing is on the stack', async () => {
    const before = (await h.doc());
    const r = await runToolTurn('AI: doomed', [
      ...rigTurn.slice(0, 4),
      { name: 'reparent_layer', args: { nodeId: 'a', parentId: 'no_such_layer' } },
    ], { rollbackOnFailure: true });
    expect(r.rolledBack).toBe(true);
    expect((await h.doc())).toBe(before);
    expect((await historyLabels())).toEqual([]);
  });

  it('a turn with a named gap is still ONE engine entry, and reports the gap', async () => {
    const before = (await h.doc());
    const tx = await beginAiTransaction('AI: boxes');
    const ctx = createToolContext(new AbortController().signal, undefined, tx.session);
    await ctx.scene.create('null', 'N');
    tx.session.legacy('a test gap');
    const out = await tx.commit();
    expect(out.kind).toBe('engine');
    expect(out.gaps).toEqual(['a test gap']);
    expect((await historyLabels())).toEqual(['AI: boxes']);
    const after = (await h.doc());
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
    await h.run({ type: 'redo' });
    expect((await h.doc())).toBe(after);
  });

  // merge_paths sends the engine's createLiveMerge (B4 round 8): the C++ engine's polygon booleans
  // make the result (facesMergeNative.test; the full engine only).
  itFullEngine('merge_paths sends createLiveMerge', async () => {
    const r = await runToolTurn('AI: merge', [
      { name: 'create_layer', args: { id: 'ma', kind: 'shape', shape: 'rect', name: 'A', x: 100, y: 100, width: 80, height: 80 } },
      { name: 'create_layer', args: { id: 'mb', kind: 'shape', shape: 'rect', name: 'B', x: 140, y: 100, width: 80, height: 80 } },
      { name: 'merge_paths', args: { op: 'union', nodeIds: ['ma', 'mb'] } },
    ]);
    expect(r.results.slice(0, 2).every((x) => x.ok)).toBe(true);
    expect(r.results[2]!.ok).toBe(true);
  });

  it('B5: polystars, text animators, masks, path operators, styles, rigs and a group time remap stay on the engine', async () => {
    const r = await runToolTurn('AI: b5', [
      { name: 'create_layer', args: { id: 's', kind: 'shape', shape: 'star', name: 'Star', points: 7, fill: '#ff0000' } },
      { name: 'create_layer', args: { id: 'e', kind: 'shape', shape: 'ellipse', name: 'Dot' } },
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'Title', text: 'Hello' } },
      { name: 'create_layer', args: { id: 'g', kind: 'group', name: 'G' } },
      { name: 'text_animator', args: { nodeId: 't', basedOn: 'words', opacity: 0, y: 20, sweep: { fromSec: 0, toSec: 1 } } },
      { name: 'create_mask', args: { nodeId: 'e', shape: 'ellipse', feather: 4 } },
      { name: 'set_trim_path', args: { nodeId: 's', end: 40 } },
      { name: 'add_repeater', args: { nodeId: 'e', copies: 4, rotation: 90, anchorX: 30 } },
      { name: 'add_path_operator', args: { nodeId: 's', op: 'puckerBloat', amount: 20 } },
      { name: 'apply_layer_style', args: { nodeId: 'e', styleType: 'drop_shadow', color: '#000000' } },
      { name: 'add_effect', args: { nodeId: 's', type: 'glow', id: 'my_glow' } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 's', prop: 'effect.my_glow.radius', t: 0, value: 4 }] } },
      { name: 'set_time_remap', args: { nodeId: 'g', keys: [{ t: 0, sourceT: 0 }, { t: 1, sourceT: 2 }] } },
      { name: 'create_puppet_rig', args: { layerId: 'e', pins: [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: 20, y: 0 }] } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    expect(r.outcome).toEqual({ kind: 'engine', gaps: [] });
    expect((await historyLabels())).toEqual(['AI: b5']);
    const star = (await docView()).getNode((r.results[0]!.data as { id: string }).id)!;
    expect(star.components.find((c) => c.type === 'fx')?.props.polystar).toMatchObject({ points: 7 });
  });

  it('G1: drawn layers, fill colour, text fields, an enum by value and a static write on a keyed property stay on the engine', async () => {
    const r = await runToolTurn('AI: title card', [
      { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', width: 640, height: 360, fill: '#112233' } },
      { name: 'create_layer', args: { id: 'box', kind: 'shape', name: 'Box', fill: '#ff0000' } },
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'Title', text: 'Hello' } },
      { name: 'create_layer', args: { id: 'g', kind: 'group', name: 'G' } },
      { name: 'create_layer', args: { id: 'l', kind: 'light', name: 'Key' } },
      { name: 'update_layer', args: { nodeId: 't', fontFamily: 'Georgia', align: 'center', fontWeight: 700, fill: '#ffcc00' } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 'box', prop: 'opacity', t: 0, value: 0 }, { nodeId: 'box', prop: 'opacity', t: 1, value: 100 }, { nodeId: 'box', prop: 'scaleX', t: 0.5, value: 2 }] } },
      { name: 'update_layer', args: { nodeId: 'box', opacity: 50 } },
    ]);
    expect(r.outcome.gaps).toEqual([]);
    expect(r.outcome.kind).toBe('engine');
    expect((await historyLabels())).toEqual(['AI: title card']);
    // One light: After Effects adds no ambient fill light beside it.
    const lights = (await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false })).layers.filter((x) => x.kind === 'light');
    expect(lights).toHaveLength(1);
  });

  it('a read-only turn leaves no entry', async () => {
    await runToolTurn('AI: create', [{ name: 'create_layer', args: { kind: 'null', name: 'X' } }]);
    const r = await runToolTurn('AI: look', [{ name: 'describe_scene', args: {} }, { name: 'list_capabilities', args: {} }]);
    expect(r.outcome.kind).toBe('empty');
    expect((await historyLabels())).toEqual(['AI: create']);
  });

  it('a user edit made during the turn joins the turn (one entry), like the old snapshot did', async () => {
    const tx = await beginAiTransaction('AI: shared');
    const ctx = createToolContext(new AbortController().signal, undefined, tx.session);
    const id = await ctx.scene.create('null', 'Mine');
    await h.run({ type: 'renameLayer', layer: id, name: 'Renamed by the user' });
    const out = await tx.commit();
    expect(out.kind).toBe('engine');
    expect((await historyLabels())).toEqual(['AI: shared']);
  });
});
