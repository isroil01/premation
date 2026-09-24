/**
 * The "what changed" lane's SOURCE SELECTION.
 *
 * The lane has two baselines and they answer different questions — "since I
 * saved" and "what did the last AI run touch" — so the bug this guards against
 * is the one where both return the same set, which looks entirely plausible on
 * screen and makes the AI answer worthless.
 *
 * Everything below is the pure half (`captureHeatSnapshot`, `diffHeat`,
 * `isKeyframeHot`, `heatFor`) driven against the real engine: B4 fingerprints
 * the document MIRROR, so the keys are written through the engine API (a real
 * layer, `addKeyframes` / `deleteKeyframes`) and filed under their API
 * property path. The SUBSCRIPTIONS are deliberately not exercised:
 * `attachHeatSources` binds to the event bus and the CommandSystem, and a test
 * that stood both of those up would be testing the bus.
 */

import { makeKeyframeId, POSITION_PSEUDO_PROP } from '@motion/animation';
import type { Value } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import {
  captureHeatSnapshot,
  diffHeat,
  heatFor,
  heatKeyOf,
  isKeyframeHot,
  markHeatAiRun,
  markHeatSaved,
  resetHeatForTest,
} from './changeHeat';

let NODE = '';
let h: Harness & { engine: LocalEngine };

const OPACITY = 'transform/opacity';
const ROTATION = 'transform/rotation';
const POSITION = 'transform/position';

beforeEach(async () => {
  resetHeatForTest();
  h = await setupAppEngine();
  NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Heat', init: [] })).layer;
});

afterEach(async () => {
  await h.dispose();
});

/** Key `path` at `t` seconds (a replaced key keeps its time and id, as `setKeyframe` did). */
async function key(path: string, t: number, value: number | { x: number; y: number }): Promise<void> {
  const v: Value = typeof value === 'number' ? { kind: 'scalar', value } : { kind: 'vec2', value };
  await h.run({
    type: 'addKeyframes',
    keys: [{ prop: { layer: NODE, path }, time: sec(t), value: v, easing: 'linear', spatialIn: [], spatialOut: [] }],
  });
}

async function unkey(path: string, t: number): Promise<void> {
  const res = await h.query({ type: 'getKeyframes', props: [{ layer: NODE, path }] });
  const id = res.sets[0]!.keyframes.find((k) => k.time === sec(t))!.id;
  await h.run({ type: 'deleteKeyframes', ids: [id] });
}

describe('fingerprint and diff', () => {
  it('reports nothing when nothing has moved', async () => {
    await key(OPACITY, 0, 0);
    const before = captureHeatSnapshot();
    const diff = diffHeat(before, captureHeatSnapshot());
    expect(diff.keys.size).toBe(0);
    expect(diff.clipIds.size).toBe(0);
  });

  it('catches an ADDED keyframe', async () => {
    await key(OPACITY, 0, 0);
    const before = captureHeatSnapshot();
    await key(OPACITY, 1, 100);
    expect(diffHeat(before, captureHeatSnapshot()).keys).toContain(heatKeyOf(NODE, OPACITY, 1));
  });

  it('catches a REMOVED keyframe', async () => {
    await key(OPACITY, 0, 0);
    await key(OPACITY, 1, 100);
    const before = captureHeatSnapshot();
    await unkey(OPACITY, 1);
    expect(diffHeat(before, captureHeatSnapshot()).keys).toContain(heatKeyOf(NODE, OPACITY, 1));
  });

  it('catches a VALUE change at a time that did not move', async () => {
    await key(OPACITY, 0, 0);
    const before = captureHeatSnapshot();
    await key(OPACITY, 0, 50);
    // A fingerprint of TIME alone would call this unchanged — which is the
    // most common single edit there is.
    expect(diffHeat(before, captureHeatSnapshot()).keys).toContain(heatKeyOf(NODE, OPACITY, 0));
  });

  it('catches a MOVED bar', async () => {
    const before = captureHeatSnapshot();
    await h.run({ type: 'setLayerTiming', items: [{ layer: NODE, inPoint: sec(0.5) }] });
    expect(diffHeat(before, captureHeatSnapshot()).clipIds).toContain(`clip:${NODE}`);
  });
});

describe('source selection', () => {
  it('answers nothing for a baseline that was never taken', async () => {
    await key(OPACITY, 0, 0);
    // No `markHeatSaved` / `markHeatAiRun` yet: an un-baselined source has to
    // report EMPTY, not "everything", or turning the lane on for the first
    // time lights the whole comp.
    expect(heatFor('save').keys.size).toBe(0);
    expect(heatFor('ai').keys.size).toBe(0);
  });

  it('keeps the two baselines apart', async () => {
    await key(OPACITY, 0, 0);
    markHeatSaved();

    // An edit the USER made after saving.
    await key(OPACITY, 1, 100);
    const beforeRun = captureHeatSnapshot();

    // Then a "run" edits something else.
    await key(ROTATION, 2, 45);
    markHeatAiRun(beforeRun);

    const save = heatFor('save');
    const ai = heatFor('ai');

    // "Since save" covers both edits; "the last run" covers only its own.
    expect(save.keys).toContain(heatKeyOf(NODE, OPACITY, 1));
    expect(save.keys).toContain(heatKeyOf(NODE, ROTATION, 2));
    expect(ai.keys).toContain(heatKeyOf(NODE, ROTATION, 2));
    expect(ai.keys).not.toContain(heatKeyOf(NODE, OPACITY, 1));
  });

  it('re-baselining "save" forgets what came before it', async () => {
    await key(OPACITY, 0, 0);
    markHeatSaved();
    await key(OPACITY, 1, 100);
    expect(heatFor('save').keys.size).toBeGreaterThan(0);

    markHeatSaved();
    expect(heatFor('save').keys.size).toBe(0);
  });
});

describe('isKeyframeHot', () => {
  it('matches a plain property by its model id', async () => {
    await key(OPACITY, 0, 0);
    markHeatSaved();
    await key(OPACITY, 1, 100);
    const diff = heatFor('save');
    expect(isKeyframeHot(diff, makeKeyframeId(NODE, 'opacity', 1))).toBe(true);
    expect(isKeyframeHot(diff, makeKeyframeId(NODE, 'opacity', 0))).toBe(false);
  });

  it('matches a MERGED position row, which no engine track is filed under', async () => {
    await key(POSITION, 0, { x: 0, y: 0 });
    markHeatSaved();
    await key(POSITION, 1, { x: 50, y: 0 });
    const diff = heatFor('save');
    // The model's merged Position row carries a pseudo-prop id. A raw set
    // lookup misses every position keyframe an AI run wrote; the row → property
    // mapping is the same one the keyframe edits resolve selections with.
    expect(isKeyframeHot(diff, makeKeyframeId(NODE, POSITION_PSEUDO_PROP, 1))).toBe(true);
    // …and so does a MEMBER row of the property (one key per time, as in AE).
    expect(isKeyframeHot(diff, makeKeyframeId(NODE, 'y', 1))).toBe(true);
    expect(isKeyframeHot(diff, makeKeyframeId(NODE, POSITION_PSEUDO_PROP, 0))).toBe(false);
  });

  it('says no for an id that does not parse', async () => {
    await key(OPACITY, 0, 0);
    markHeatSaved();
    await key(OPACITY, 1, 100);
    expect(isKeyframeHot(heatFor('save'), 'not-a-keyframe-id')).toBe(false);
  });
});
