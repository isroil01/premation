/**
 * Param supervision — the plugin hears its own control move, and may move the
 * others.
 *
 * The four properties that make this safe to hand a third party, in the order
 * they would hurt if they were wrong:
 *
 *   • it CANNOT LOOP — a plugin that normalises a value it also supervises
 *     would otherwise exchange messages with the host forever, and the symptom
 *     is a pegged CPU with no error anywhere;
 *   • it COALESCES — a slider commits thirty times a second, and a round trip
 *     per commit is how an interaction stops being 60fps;
 *   • it CANNOT REACH ANYTHING ELSE — the reply is plugin output arriving
 *     through a channel the user did not initiate;
 *   • a plugin that hangs or throws costs the user nothing, because their own
 *     edit already landed.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeEffects, writeNodeEffects } from '@core/effects/effects';
import { registerEffects, unregisterEffects } from './pluginEffects';
import {
  SUPERVISE_DEBOUNCE_MS,
  noteParamCommitted,
  resetParamSupervision,
  setSuperviseHandler,
  supervisionPending,
  type SuperviseRequest,
} from './paramSupervision';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import type { EffectContribution } from './effectSchema';

const PLUGIN = 'studio.acme.grade';
const TYPE = `${PLUGIN}.filmic`;

const CONTRIBUTION = {
  id: 'filmic',
  label: 'Filmic Grade',
  shader: '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
  supervises: ['preset'],
  params: {
    preset: { type: 'number', default: 0, min: 0, max: 3 },
    lift: { type: 'number', default: 0, min: 0, max: 1 },
    gain: { type: 'number', default: 1, min: 0, max: 4 },
  },
} as unknown as EffectContribution;

let h: Harness & { engine: LocalEngine };
/** A layer of the active composition (the engine addresses its effects). */
let LAYER = '';

/** Put one instance of the plugin effect on `layer`. */
function addEffect(params: Record<string, unknown> = {}): void {
  writeNodeEffects(LAYER, [{
    id: 'fx1',
    type: TYPE as never,
    params: { preset: 0, lift: 0, gain: 1, ...params } as never,
  }]);
}

const paramsOf = (): Record<string, unknown> =>
  (getNodeEffects(LAYER)[0]?.params ?? {}) as Record<string, unknown>;

// B5: the answer is ONE engine batch (setProperty of effects/<id>/<param>,
// origin plugin) — so the layer lives in the app engine's composition.
beforeEach(async () => {
  h = await setupAppEngine();
  resetParamSupervision();
  unregisterEffects(PLUGIN);
  registerEffects(PLUGIN, 'Acme Grade', [CONTRIBUTION]);
  LAYER = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Graded', init: [] })).layer;
  // The fixture's effect instance (a test-only write; the engine resyncs it).
  addEffect();
  getCommandSystem().getHistory().clear();
});

afterEach(async () => {
  resetParamSupervision();
  unregisterEffects(PLUGIN);
  await h.dispose();
});

/** Let the debounce fire, the handler's promise settle and the engine apply the answer. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, SUPERVISE_DEBOUNCE_MS + 1));
  for (let i = 0; i < 3; i++) await Promise.resolve();
  await engineIdle();
  await engineIdle();
}

describe('what triggers it', () => {
  it('calls the plugin when a supervised param is committed', async () => {
    const seen: SuperviseRequest[] = [];
    setSuperviseHandler((r) => { seen.push(r); return null; });

    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      pluginId: PLUGIN, effectId: 'filmic', instanceId: 'fx1', nodeId: LAYER, changed: 'preset',
    });
    // The WHOLE block, not just the one that moved: a preset needs to know
    // what it is overwriting.
    expect(seen[0]!.params).toMatchObject({ preset: 0, lift: 0, gain: 1 });
  });

  it('ignores a param the effect does not supervise', async () => {
    const handler = jest.fn(() => null);
    setSuperviseHandler(handler);
    noteParamCommitted(LAYER, 'fx1', 'lift');
    await settle();
    // Opt-in per param: an effect that names none costs nothing at all.
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores an effect that is not a plugin\'s', async () => {
    writeNodeEffects(LAYER, [{ id: 'fx1', type: 'blur' as never, params: {} as never }]);
    const handler = jest.fn(() => null);
    setSuperviseHandler(handler);
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    expect(handler).not.toHaveBeenCalled();
  });

  it('does nothing at all with no handler wired', () => {
    setSuperviseHandler(null);
    noteParamCommitted(LAYER, 'fx1', 'preset');
    expect(supervisionPending(LAYER, 'fx1')).toBe(false);
  });
});

describe('coalescing', () => {
  it('fires ONCE for a drag, with the value it ended on', async () => {
    const seen: SuperviseRequest[] = [];
    setSuperviseHandler((r) => { seen.push(r); return null; });

    // A slider commits every frame. Thirty round trips inside a drag loop is
    // the thing this prevents.
    for (let i = 1; i <= 30; i++) {
      writeNodeEffects(LAYER, [{ id: 'fx1', type: TYPE as never, params: { preset: i, lift: 0, gain: 1 } as never }]);
      noteParamCommitted(LAYER, 'fx1', 'preset');
      await new Promise((r) => setTimeout(r, 16));
    }
    await settle();

    expect(seen).toHaveLength(1);
    // Where the drag ENDED, not where it was queued.
    expect(seen[0]!.params.preset).toBe(30);
  });

  it('keeps two instances on the same layer apart', async () => {
    writeNodeEffects(LAYER, [
      { id: 'fx1', type: TYPE as never, params: { preset: 0 } as never },
      { id: 'fx2', type: TYPE as never, params: { preset: 0 } as never },
    ]);
    const seen: string[] = [];
    setSuperviseHandler((r) => { seen.push(r.instanceId); return null; });

    noteParamCommitted(LAYER, 'fx1', 'preset');
    noteParamCommitted(LAYER, 'fx2', 'preset');
    await settle();

    expect(seen.sort()).toEqual(['fx1', 'fx2']);
  });
});

describe('applying the answer', () => {
  it('writes the params the plugin returned', async () => {
    setSuperviseHandler(() => ({ lift: 0.2, gain: 1.8 }));
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    expect(paramsOf()).toMatchObject({ lift: 0.2, gain: 1.8 });
  });

  it('is ONE undo entry, and undoing it restores the whole set', async () => {
    setSuperviseHandler(() => ({ lift: 0.2, gain: 1.8 }));
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    expect(paramsOf()).toMatchObject({ lift: 0.2, gain: 1.8 });

    await h.run({ type: 'undo' });
    expect(paramsOf()).toMatchObject({ lift: 0, gain: 1 });
  });

  it('refuses a key the effect does not declare', async () => {
    // A reply is plugin output arriving through a channel the user did not
    // initiate. It does not get to invent parameters.
    setSuperviseHandler(() => ({ lift: 0.5, somethingElse: 99 }));
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    expect(paramsOf().lift).toBe(0.5);
    expect(paramsOf()).not.toHaveProperty('somethingElse');
  });

  it('writes nothing, and no history entry, when the answer changes nothing', async () => {
    const history = getCommandSystem().getHistory();
    setSuperviseHandler(() => ({ lift: 0, gain: 1 }));
    const before = history.canUndo();
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    // Writing what is already there would manufacture an undo step out of a
    // plugin saying "no change".
    expect(history.canUndo()).toBe(before);
  });

  it('accepts null as "nothing to change"', async () => {
    setSuperviseHandler(() => null);
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    expect(paramsOf()).toMatchObject({ lift: 0, gain: 1 });
  });
});

describe('the loop guard', () => {
  it('does not re-supervise the params the plugin itself wrote', async () => {
    let calls = 0;
    // The shape that would otherwise never terminate: the plugin supervises
    // `preset` and also writes it.
    setSuperviseHandler(() => {
      calls += 1;
      return { preset: calls, lift: 0.1 * calls };
    });

    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    // Give any second round every chance to appear.
    await settle();
    await settle();

    expect(calls).toBe(1);
  });
});

describe('a plugin that misbehaves', () => {
  it('costs the user nothing when it throws', async () => {
    setSuperviseHandler(() => { throw new Error('boom'); });
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await expect(settle()).resolves.toBeUndefined();
    // The user's own edit already landed; there is nothing to roll back.
    expect(paramsOf()).toMatchObject({ preset: 0, lift: 0, gain: 1 });
  });

  it('costs the user nothing when it rejects', async () => {
    setSuperviseHandler(() => Promise.reject(new Error('nope')));
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await settle();
    expect(paramsOf()).toMatchObject({ lift: 0, gain: 1 });
  });

  it('writes nothing when the layer was deleted while it was thinking', async () => {
    let resolve!: (v: Record<string, unknown>) => void;
    setSuperviseHandler(() => new Promise((r) => { resolve = r; }));
    noteParamCommitted(LAYER, 'fx1', 'preset');
    await new Promise((r) => setTimeout(r, SUPERVISE_DEBOUNCE_MS + 1));
    await Promise.resolve();

    await h.run({ type: 'deleteLayers', layers: [LAYER] });
    const entries = getCommandSystem().getHistory().getEntries().length;
    resolve({ lift: 0.9 });
    await settle();
    expect(defaultSceneGraph.getNode(LAYER)).toBeUndefined();
    expect(getCommandSystem().getHistory().getEntries().length).toBe(entries);
  });
});
