/**
 * The timeline's keyframe edits through the engine API (B3): the selection's
 * positional ids are resolved to ENGINE keyframe ids (`getKeyframes`), every
 * user action is one undo entry, and a key the API cannot address alone (one
 * member of a grouped property keyed with its sibling) keeps the legacy writer.
 */

import { defaultAnimation, POSITION_PSEUDO_PROP } from '@motion/animation';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { copyKeyframes, clearClipboard } from '@core/animation/keyframeClipboard';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import {
  deleteKeyframesUi,
  easeKindOnKeys,
  easePresetOnKeys,
  moveKeyframesTo,
  pasteKeyframesAt,
  resolveKeyIds,
} from './keyframeEdits';
import { uiKeyId } from './keyframeSelectionIds';
import { createSelectionNudger } from './keyframeNudge';
import { applyKeyframeVelocity } from './keyframeVelocity';

let h: Harness & { engine: LocalEngine };
let L = '';
const COMP = 'comp_root';

const key = (prop: string, t: number) => defaultAnimation.getTrackKeyframes(L, prop)?.find((k) => Math.abs(k.t - t) < 1e-9);
const times = (prop: string) => (defaultAnimation.getTrackKeyframes(L, prop) ?? []).map((k) => k.t);

async function keys(path: string, pts: Array<[number, number | { x: number; y: number }]>): Promise<void> {
  await h.run({
    type: 'addKeyframes',
    keys: pts.map(([s, v]) => ({
      prop: { layer: L, path },
      time: sec(s),
      value: typeof v === 'number' ? { kind: 'scalar' as const, value: v } : { kind: 'vec2' as const, value: v },
      easing: 'linear' as const,
      spatialIn: [],
      spatialOut: [],
    })),
  });
}

beforeEach(async () => {
  h = await setupAppEngine();
  L = (await h.run({ type: 'createLayer', comp: COMP, kind: 'solid', name: 'L', init: [] })).layer;
  await keys('transform/opacity', [[0, 0], [1, 50], [2, 100]]);
  useKeyframeSelectionStore.getState().clear();
});

afterEach(async () => {
  clearClipboard();
  await h.dispose();
});

describe('ids', () => {
  it('resolves positional selection ids to the engine’s keyframe ids', async () => {
    const res = await h.query({ type: 'getKeyframes', props: [{ layer: L, path: 'transform/opacity' }] });
    const ids = await resolveKeyIds([uiKeyId(L, 'opacity', 1)]);
    expect(ids?.get(uiKeyId(L, 'opacity', 1))).toBe(res.sets[0]!.keyframes[1]!.id);
  });

  it('refuses a lone Scale X key whose Scale Y sibling is keyed at the same time', async () => {
    await keys('transform/scale', [[0, { x: 100, y: 100 }], [1, { x: 50, y: 50 }]]);
    expect(await resolveKeyIds([uiKeyId(L, 'scaleX', 1)])).toBeNull();
  });
});

describe('move / delete', () => {
  it('a multi-key drag release is ONE entry; undo and redo round-trip', async () => {
    const before = h.doc();
    const legacy = jest.fn();
    await moveKeyframesTo([
      { id: uiKeyId(L, 'opacity', 1), time: 1.5 },
      { id: uiKeyId(L, 'opacity', 2), time: 2.5 },
    ], legacy);
    await engineIdle();
    expect(legacy).not.toHaveBeenCalled();
    expect(times('opacity')).toEqual([0, 1.5, 2.5]);
    expect(historyLabels().at(-1)).toBe('Move keyframes');
    const after = h.doc();
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
    await h.run({ type: 'redo' });
    expect(h.doc()).toBe(after);
  });

  it('two keys a trimmed clip clamps onto ONE comp instant stay two keys', async () => {
    // Trim the layer to 0.5–1.0 s: the keys at 1 s and 2 s both draw at the
    // clip's last frame. Each must still resolve to its OWN engine id.
    await h.run({ type: 'setLayerTiming', items: [{ layer: L, inPoint: sec(0.5), outPoint: sec(1) }] });
    const ids = await resolveKeyIds([uiKeyId(L, 'opacity', 1), uiKeyId(L, 'opacity', 2)]);
    expect(ids).not.toBeNull();
    expect(new Set(ids!.values()).size).toBe(2);
  });

  it('a merged Position diamond moves x and y together', async () => {
    await keys('transform/position', [[0, { x: 0, y: 0 }], [1, { x: 10, y: 20 }]]);
    await moveKeyframesTo([{ id: uiKeyId(L, POSITION_PSEUDO_PROP, 1), time: 2 }], () => { throw new Error('legacy'); });
    expect(times('x')).toEqual([0, 2]);
    expect(times('y')).toEqual([0, 2]);
  });

  it('the lone-member case runs the legacy writer instead', async () => {
    await keys('transform/scale', [[0, { x: 100, y: 100 }], [1, { x: 50, y: 50 }]]);
    const legacy = jest.fn();
    await moveKeyframesTo([{ id: uiKeyId(L, 'scaleX', 1), time: 2 }], legacy);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('delete', async () => {
    await deleteKeyframesUi([uiKeyId(L, 'opacity', 1), uiKeyId(L, 'opacity', 2)], () => { throw new Error('legacy'); });
    expect(times('opacity')).toEqual([0]);
    expect(historyLabels().at(-1)).toBe('Delete keyframes');
  });
});

describe('easing', () => {
  it('a preset on every selected key', async () => {
    await easePresetOnKeys([uiKeyId(L, 'opacity', 0), uiKeyId(L, 'opacity', 1)], 'Ease');
    await engineIdle();
    expect(key('opacity', 0)?.easing).toBe('bezier');
    expect(key('opacity', 1)?.easing).toBe('bezier');
    expect(key('opacity', 2)?.easing).toBe('linear');
    expect(historyLabels().at(-1)).toBe('Set keyframe easing: Ease');
  });

  it('Hold on a scalar track is written as `step`, as the legacy writer did', async () => {
    await easePresetOnKeys([uiKeyId(L, 'opacity', 0)], 'Hold');
    expect(key('opacity', 0)?.easing).toBe('step');
  });

  it('a kind seeds default handles like `setEasing`', async () => {
    await easeKindOnKeys([uiKeyId(L, 'opacity', 1)], 'bezier');
    expect(key('opacity', 1)).toMatchObject({ easing: 'bezier', bezier: [0.25, 0.1, 0.25, 1], continuous: true });
    expect(historyLabels().at(-1)).toMatch(/^Set keyframe easing: /);
  });

  it('keyframe velocity on a scalar: one entry through the engine', async () => {
    const entries = historyLabels().length;
    expect(applyKeyframeVelocity(L, 'opacity', 1, { inSpeed: 10, outSpeed: 80, inInfluence: 0.5, outInfluence: 0.25 })).toBe(true);
    await engineIdle();
    await engineIdle();
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe('Keyframe velocity');
    expect(key('opacity', 0)?.easing).toBe('bezier');
    expect(key('opacity', 1)?.easing).toBe('bezier');
  });
});

describe('copy / paste', () => {
  it('pastes onto another layer at the playhead, spacing kept, one entry', async () => {
    const M = (await h.run({ type: 'createLayer', comp: COMP, kind: 'solid', name: 'M', init: [] })).layer;
    copyKeyframes(new Set([uiKeyId(L, 'opacity', 1), uiKeyId(L, 'opacity', 2)]));
    const before = h.doc();
    await pasteKeyframesAt([M], 3);
    expect((defaultAnimation.getTrackKeyframes(M, 'opacity') ?? []).map((k) => [k.t, k.value])).toEqual([[3, 50], [4, 100]]);
    expect(historyLabels().at(-1)).toBe('Paste keyframes');
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });

  it('pastes a merged Position key as one vec2', async () => {
    await keys('transform/position', [[0, { x: 1, y: 2 }], [1, { x: 10, y: 20 }]]);
    copyKeyframes(new Set([uiKeyId(L, POSITION_PSEUDO_PROP, 1)]));
    await pasteKeyframesAt([L], 2);
    expect(key('x', 2)?.value).toBe(10);
    expect(key('y', 2)?.value).toBe(20);
  });
});

describe('arrow-key nudge', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('a burst of presses is ONE gesture entry and the selection follows the key', async () => {
    useKeyframeSelectionStore.getState().set(new Set([uiKeyId(L, 'opacity', 1)]));
    const n = createSelectionNudger();
    const frame = 1 / 30;
    n.push({ dt: frame, dv: 0 });
    n.push({ dt: frame, dv: 0 });
    await engineIdle();
    await engineIdle();
    n.push({ dt: frame, dv: 0 });
    await engineIdle();
    await engineIdle();
    const before = historyLabels().length;
    jest.advanceTimersByTime(400); // the burst goes quiet → commit
    await engineIdle();
    await engineIdle();
    expect(historyLabels().length).toBe(before + 1);
    expect(historyLabels().at(-1)).toBe('Nudge keyframes in time');
    expect(times('opacity')[1]).toBeCloseTo(1 + 3 * frame, 6);
    expect([...useKeyframeSelectionStore.getState().ids]).toEqual([uiKeyId(L, 'opacity', times('opacity')[1]!)]);
    await h.run({ type: 'undo' });
    expect(times('opacity')).toEqual([0, 1, 2]);
  });

  it('Alt+↑ nudges the value', async () => {
    useKeyframeSelectionStore.getState().set(new Set([uiKeyId(L, 'opacity', 1)]));
    const n = createSelectionNudger();
    n.push({ dt: 0, dv: 10 });
    await engineIdle();
    await engineIdle();
    n.flush();
    await engineIdle();
    await engineIdle();
    expect(key('opacity', 1)?.value).toBe(60);
    expect(historyLabels().at(-1)).toBe('Nudge keyframe value');
  });
});
