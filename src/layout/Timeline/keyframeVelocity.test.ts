/**
 * Keyframe velocity: the half-ownership rule.
 *
 * The one thing this feature can get wrong invisibly is writing the INCOMING
 * numbers onto the keyframe you clicked. A keyframe's bezier shapes the
 * segment that starts at it, so incoming belongs to the PREVIOUS keyframe —
 * put it in the wrong place and the curve on the other side changes while the
 * side you were editing does not, which reads as "the dialog does nothing".
 */

import { act } from '@testing-library/react';
import { defaultAnimation, POSITION_PSEUDO_PROP } from '@motion/animation';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { incomingSpeed, outgoingSpeed, effectiveBezier, influences } from './speedGraph';
import { applyKeyframeVelocity, readKeyframeVelocity } from './keyframeVelocity';

// The write goes through the engine API (B3): a real layer in the app engine,
// its Position keyed through the engine. x runs 0 → 100 → 300 and y a tenth of
// that, 0 → 10 → 30, over 0..2 s.
let NODE = '';
let keyIds: string[] = [];
let h: Harness & { engine: LocalEngine };

/** Apply, then let the engine land the edit the helper sent. */
async function apply(prop: string, t: number, v: Parameters<typeof applyKeyframeVelocity>[3]): Promise<boolean> {
  let ok = false;
  await act(async () => {
    ok = applyKeyframeVelocity(NODE, prop, t, v);
    await engineIdle();
    await engineIdle();
  });
  return ok;
}

function kf(prop: string, t: number) {
  return (defaultAnimation.getTrackKeyframes(NODE, prop) ?? []).find((k) => Math.abs(k.t - t) < 1e-6);
}

describe('keyframe velocity', () => {
  beforeEach(async () => {
    h = await setupAppEngine();
    NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'V', init: [] })).layer;
    keyIds = (await h.run({
      type: 'addKeyframes',
      keys: [[0, 0, 0], [1, 100, 10], [2, 300, 30]].map(([t, x, y]) => ({
        prop: { layer: NODE, path: 'transform/position' }, time: sec(t!),
        value: { kind: 'vec2' as const, value: { x: x!, y: y! } }, spatialIn: [], spatialOut: [],
      })),
    })).ids;
    // Each test starts from an empty undo stack.
    getCommandSystem().getHistory().clear();
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('reports both sides for a middle keyframe', () => {
    const r = readKeyframeVelocity(NODE, 'x', 1);
    expect(r).not.toBeNull();
    expect(r!.hasIncoming).toBe(true);
    expect(r!.hasOutgoing).toBe(true);
    expect(r!.props).toEqual(['x']);
  });

  it('reports only the outgoing side at the first keyframe', () => {
    const r = readKeyframeVelocity(NODE, 'x', 0);
    expect(r!.hasIncoming).toBe(false);
    expect(r!.hasOutgoing).toBe(true);
  });

  it('reports only the incoming side at the last keyframe', () => {
    const r = readKeyframeVelocity(NODE, 'x', 2);
    expect(r!.hasIncoming).toBe(true);
    expect(r!.hasOutgoing).toBe(false);
  });

  it('is null for a lone keyframe — no segment, no velocity', async () => {
    await h.run({ type: 'deleteKeyframes', ids: keyIds.slice(1) });
    expect(kf('x', 0)).toBeDefined();
    expect(kf('x', 1)).toBeUndefined();
    expect(readKeyframeVelocity(NODE, 'x', 0)).toBeNull();
  });

  it('is null when nothing is keyed at that time', () => {
    expect(readKeyframeVelocity(NODE, 'x', 0.5)).toBeNull();
  });

  it('writes the incoming half onto the PREVIOUS keyframe, the outgoing onto this one', async () => {
    const before0 = { ...kf('x', 0)! };
    const before1 = { ...kf('x', 1)! };

    await apply('x', 1, {
      inSpeed: 40,
      outSpeed: 500,
      inInfluence: 0.5,
      outInfluence: 0.25,
    });

    // Both ends of the middle keyframe's neighbourhood changed…
    expect(kf('x', 0)!.bezier).not.toEqual(before0.bezier);
    expect(kf('x', 1)!.bezier).not.toEqual(before1.bezier);
    // …and the keyframe AFTER it did not: nothing here owns that segment.
    expect(kf('x', 2)!.bezier).toBeUndefined();
  });

  it('round-trips the numbers it was given', async () => {
    await apply('x', 1, {
      inSpeed: 40,
      outSpeed: 500,
      inInfluence: 0.5,
      outInfluence: 0.25,
    });

    // Incoming: segment 0→1, dv 100 over dt 1, read off keyframe 0's bezier.
    const inB = effectiveBezier(kf('x', 0)!);
    expect(incomingSpeed(inB, 100, 1)).toBeCloseTo(40, 4);
    expect(influences(inB).in).toBeCloseTo(0.5, 4);

    // Outgoing: segment 1→2, dv 200 over dt 1, read off keyframe 1's bezier.
    const outB = effectiveBezier(kf('x', 1)!);
    expect(outgoingSpeed(outB, 200, 1)).toBeCloseTo(500, 4);
    expect(influences(outB).out).toBeCloseTo(0.25, 4);
  });

  it('records exactly one undo entry for the whole write, and undo restores both halves', async () => {
    const before0 = { ...kf('x', 0)! };
    const before1 = { ...kf('x', 1)! };
    expect(historyLabels()).toEqual([]);
    await apply('x', 1, {
      inSpeed: 10,
      outSpeed: 20,
      inInfluence: 0.4,
      outInfluence: 0.4,
    });
    // Two keyframes patched (the previous one's incoming, this one's outgoing), one entry.
    expect(historyLabels()).toEqual(['Keyframe velocity']);
    expect(kf('x', 0)!.bezier).not.toEqual(before0.bezier);

    await act(async () => { await h.run({ type: 'undo' }); });
    expect(kf('x', 0)!.bezier).toEqual(before0.bezier);
    expect(kf('x', 1)!.bezier).toEqual(before1.bezier);
  });

  it('solves each axis of a merged Position separately for the same speed', async () => {
    // y moves a tenth as far as x over the same segment (seeded in beforeEach),
    // so the bezier that expresses "leaves at 50/s" is necessarily different on
    // each track. One shared bezier would mean two different speeds, which is the bug.
    expect(kf('y', 1)!.value).toBe(10);
    expect(kf('y', 2)!.value).toBe(30);

    const r = readKeyframeVelocity(NODE, POSITION_PSEUDO_PROP, 1);
    expect(r!.props).toEqual(expect.arrayContaining(['x', 'y']));

    await apply(POSITION_PSEUDO_PROP, 1, {
      inSpeed: 50,
      outSpeed: 50,
      inInfluence: 1 / 3,
      outInfluence: 1 / 3,
    });

    expect(outgoingSpeed(effectiveBezier(kf('x', 1)!), 200, 1)).toBeCloseTo(50, 4);
    expect(outgoingSpeed(effectiveBezier(kf('y', 1)!), 20, 1)).toBeCloseTo(50, 4);
    expect(kf('x', 1)!.bezier).not.toEqual(kf('y', 1)!.bezier);
  });
});
