/**
 * `set_layer_timing` and the operator handles (M1 of docs/AI_AUTHOR_MODE_PLAN.md),
 * on the app's engine: the bar the tool says it set is the bar the engine
 * holds, in comp seconds, and a trim / repeater created with `id` is keyable
 * through `pathop.<id>.…` in the SAME batch — which is what an authored scene,
 * compiled to one ToolCall[] up front, depends on.
 */

import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { runToolTurn } from './aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(10) } } as Command);
  await settleEdits();
});
afterEach(async () => { await h.dispose(); });

const named = (name: string): string => {
  const m = documentMirror();
  const id = m.layerIds().find((c) => m.layer(c)?.name === name);
  if (!id) throw new Error(`no layer named ${name}`);
  return id;
};
const bar = (id: string): { in: number; out: number; start: number } => {
  const t = documentMirror().layer(id)!.timing;
  return { in: t.inPoint / sec(1), out: t.outPoint / sec(1), start: t.startTime / sec(1) };
};

describe('set_layer_timing', () => {
  it('sets in / out in comp seconds for a whole beat in one call', async () => {
    const r = await runToolTurn('AI: time', [
      { name: 'create_layer', args: { id: 'a', kind: 'shape', name: 'A', width: 100, height: 100 } },
      { name: 'create_layer', args: { id: 'b', kind: 'text', name: 'B', text: 'Hello' } },
      { name: 'set_layer_timing', args: { items: [{ nodeId: 'a', inSec: 1, outSec: 3.5 }, { nodeId: 'b', inSec: 2, outSec: 6 }] } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    expect(r.outcome.kind).toBe('engine');
    expect(bar(named('A'))).toMatchObject({ in: 1, out: 3.5 });
    expect(bar(named('B'))).toMatchObject({ in: 2, out: 6 });
  });

  it('changes only what it is given, and refuses a bar that ends before it starts', async () => {
    const r = await runToolTurn('AI: trim', [
      { name: 'create_layer', args: { id: 'a', kind: 'null', name: 'A' } },
      { name: 'set_layer_timing', args: { items: [{ nodeId: 'a', inSec: 2, outSec: 5 }] } },
      { name: 'set_layer_timing', args: { items: [{ nodeId: 'a', outSec: 4 }] } },
      { name: 'set_layer_timing', args: { items: [{ nodeId: 'a', outSec: 1 }] } },
    ]);
    expect(r.results.map((x) => x.ok)).toEqual([true, true, true, false]);
    expect(r.results[3]!.content).toMatch(/must be after inSec/);
    expect(bar(named('A'))).toMatchObject({ in: 2, out: 4 });
  });

  it('keyframes keep their composition times after the bar moves', async () => {
    await runToolTurn('AI: keys', [
      { name: 'create_layer', args: { id: 'a', kind: 'null', name: 'A' } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 'a', prop: 'x', t: 2, value: 0 }, { nodeId: 'a', prop: 'x', t: 3, value: 400 }] } },
      { name: 'set_layer_timing', args: { items: [{ nodeId: 'a', inSec: 2, outSec: 4 }] } },
    ]);
    const keys = (await docView()).getTrackKeyframes(named('A'), 'x') ?? [];
    expect(keys.map((k) => k.value)).toEqual([0, 400]);
  });
});

describe('operator handles', () => {
  it('a trim created with id is keyed through pathop.<id> in the same batch', async () => {
    const r = await runToolTurn('AI: draw on', [
      { name: 'create_layer', args: { id: 'ring', kind: 'shape', shape: 'ellipse', name: 'Ring', width: 200, height: 200 } },
      { name: 'update_layer', args: { nodeId: 'ring', stroke: '#ffcc00', strokeWidth: 6, fillOpacity: 0 } },
      { name: 'set_trim_path', args: { nodeId: 'ring', id: 'ring_trim', end: 0 } },
      { name: 'set_keyframes', args: { keyframes: [
        { nodeId: 'ring', prop: 'pathop.ring_trim.end', t: 0, value: 0, easing: 'easeOut' },
        { nodeId: 'ring', prop: 'pathop.ring_trim.end', t: 1, value: 100 },
      ] } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const opId = (r.results[2]!.data as { opId: string }).opId;
    const keys = (await docView()).getTrackKeyframes(named('Ring'), `pathop.${opId}.end`) ?? [];
    expect(keys.map((k) => k.value)).toEqual([0, 100]);
  });

  it('a repeater created with id is reachable as opId later in the batch', async () => {
    const r = await runToolTurn('AI: burst', [
      { name: 'create_layer', args: { id: 'dot', kind: 'shape', shape: 'ellipse', name: 'Dot', width: 20, height: 20 } },
      { name: 'add_repeater', args: { nodeId: 'dot', id: 'rep', copies: 6, rotation: 60, anchorX: 80 } },
      { name: 'add_repeater', args: { nodeId: 'dot', opId: 'rep', copies: 8 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    expect(r.results[2]!.data).toMatchObject({ opId: (r.results[1]!.data as { opId: string }).opId, repeaterCount: 1 });
  });
});
